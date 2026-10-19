#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import struct


def validate_components(items):
    if not isinstance(items, list):
        raise ValueError('hacs_components must be a list')
    seen = set()
    for entry in items:
        if not isinstance(entry, dict):
            raise ValueError('Invalid HACS component entry')
        name = entry.get('repository')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', name):
            raise ValueError('Invalid HACS repository: %r' % name)
        if name.lower() in seen:
            raise ValueError('Duplicate HACS repository: ' + name)
        seen.add(name.lower())
        if entry.get('type') not in ('integration', 'plugin', 'theme', 'template'):
            raise ValueError('Invalid HACS category: ' + name)
        if entry.get('action') not in ('install', 'remove'):
            raise ValueError('Invalid HACS action: ' + name)
        if entry['action'] == 'install':
            version = entry.get('version', 'latest')
            if not isinstance(version, str) or not version or len(version) > 128 or any(c.isspace() for c in version):
                raise ValueError('Invalid HACS version: ' + name)
        elif 'version' in entry:
            raise ValueError('Remove action cannot specify version: ' + name)
    return items

class HAWebSocket:
    def __init__(self):
        token = os.environ.get('SUPERVISOR_TOKEN')
        if not token:
            raise RuntimeError('SUPERVISOR_TOKEN is missing')
        self.sock = socket.create_connection(('supervisor', 80), timeout=20)
        self.sock.settimeout(120)
        try:
            key = base64.b64encode(secrets.token_bytes(16)).decode()
            handshake = ('GET /core/websocket HTTP/1.1\r\nHost: supervisor\r\n'
                         'Upgrade: websocket\r\nConnection: Upgrade\r\n'
                         'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n') % key
            self.sock.sendall(handshake.encode())
            response = bytearray()
            while b'\r\n\r\n' not in response:
                part = self.sock.recv(1)
                if not part or len(response) > 16384:
                    raise ConnectionError('Invalid WebSocket upgrade response')
                response.extend(part)
            headers = response.decode('latin-1')
            expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if ' 101 ' not in headers.split('\r\n')[0] or ('sec-websocket-accept: ' + expected).lower() not in headers.lower():
                raise ConnectionError('WebSocket upgrade rejected')
            if self.receive().get('type') != 'auth_required':
                raise RuntimeError('Unexpected Home Assistant auth greeting')
            self.send({'type': 'auth', 'access_token': token})
            if self.receive().get('type') != 'auth_ok':
                raise RuntimeError('Home Assistant WebSocket auth failed')
            self.counter = 0
        except Exception:
            self.sock.close()
            raise

    def read(self, count):
        data = bytearray()
        while len(data) < count:
            chunk = self.sock.recv(count - len(data))
            if not chunk:
                raise ConnectionError('WebSocket closed')
            data.extend(chunk)
        return bytes(data)

    def frame(self, opcode, payload):
        mask = secrets.token_bytes(4)
        size = len(payload)
        header = bytes([128 | opcode])
        if size < 126:
            header += bytes([128 | size])
        elif size < 65536:
            header += bytes([254]) + struct.pack('!H', size)
        else:
            header += bytes([255]) + struct.pack('!Q', size)
        self.sock.sendall(header + mask + bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload)))

    def send(self, message):
        self.frame(1, json.dumps(message).encode())

    def receive(self):
        data = bytearray()
        while True:
            first, second = self.read(2)
            opcode = first & 15
            length = second & 127
            if length == 126:
                length = struct.unpack('!H', self.read(2))[0]
            elif length == 127:
                length = struct.unpack('!Q', self.read(8))[0]
            if length > 8 * 1024 * 1024:
                raise ValueError('Oversized WebSocket response')
            mask = self.read(4) if second & 128 else None
            chunk = self.read(length)
            if mask:
                chunk = bytes(byte ^ mask[i % 4] for i, byte in enumerate(chunk))
            if opcode == 9:
                self.frame(10, chunk)
                continue
            if opcode == 8:
                raise ConnectionError('WebSocket closed by server')
            if opcode not in (0, 1):
                continue
            data.extend(chunk)
            if first & 128:
                return json.loads(data.decode())

    def call(self, command, **fields):
        self.counter += 1
        request_id = self.counter
        self.send(dict(type=command, id=request_id, **fields))
        while True:
            message = self.receive()
            if message.get('type') == 'result' and message.get('id') == request_id:
                if not message.get('success'):
                    raise RuntimeError('%s: %s' % (command, message.get('error')))
                return message.get('result')

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.sock.close()

def sync_hacs_components(entries, dry_run=False):
    validate_components(entries)
    if not entries:
        return []
    changes = []
    with HAWebSocket() as ws:
        info = ws.call('hacs/info')
        if info.get('stage') != 'running':
            raise RuntimeError('HACS is not running')
        repos = ws.call('hacs/repositories/list')
        lookup = {str(r.get('full_name', '')).lower(): r for r in repos}
        for entry in entries:
            name = entry['repository']
            repo = lookup.get(name.lower())
            if not repo:
                raise RuntimeError('Repository not registered in HACS: ' + name)
            if repo.get('category') != entry['type']:
                raise RuntimeError('HACS category mismatch: ' + name)
            installed = bool(repo.get('installed'))
            version = entry.get('version', 'latest')
            target = repo.get('available_version') if version == 'latest' else version
            if entry['action'] == 'remove':
                needed = installed
            else:
                if not target and version != 'latest':
                    raise RuntimeError('Cannot determine desired version: ' + name)
                needed = not installed or (
                    bool(target) and repo.get('installed_version') != target
                )
            if not needed:
                continue
            identifier = str(repo['id'])
            change = {'repository': name, 'action': entry['action'], 'version': target}
            changes.append(change)
            if dry_run:
                continue
            if entry['action'] == 'remove':
                ws.call('hacs/repository/remove', repository=identifier)
            else:
                if version != 'latest':
                    details = ws.call('hacs/repository/info', repository_id=identifier)
                    if target not in details.get('releases', []):
                        raise RuntimeError('Release %s unavailable for %s' % (target, name))
                    ws.call('hacs/repository/download',
                            repository=identifier, version=target)
                else:
                    # Let HACS resolve the latest available version.
                    ws.call('hacs/repository/download',
                            repository=identifier)
            verified = ws.call('hacs/repository/info', repository_id=identifier)
            if entry['action'] == 'remove' and verified.get('installed'):
                raise RuntimeError('Failed to verify removal: ' + name)
            if entry['action'] == 'install':
                if not verified.get('installed'):
                    raise RuntimeError('Failed to verify installation: ' + name)
                if version != 'latest' and verified.get('installed_version') != target:
                    raise RuntimeError('Failed to verify version: ' + name)
    return changes
