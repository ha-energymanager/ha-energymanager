"""Approve and execute one-off Energy Manager workloads in Home Assistant."""

import asyncio
from copy import deepcopy
from datetime import UTC, datetime
import logging
from math import ceil
import re
from time import time
from uuid import UUID

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_HOMEASSISTANT_STOP
from homeassistant.core import Context, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_track_point_in_utc_time, async_track_state_change_event
from homeassistant.helpers.storage import Store

from .planner import SOURCES, nonnegative, overlaps, read_forecast, recommend, replay

DOMAIN = "em_deferred_workloads"
LOGGER = logging.getLogger(__name__)
PENDING = {"scheduled", "delayed"}
ACTIVE = PENDING | {"starting", "running", "stopping", "stop_failed"}
START_GRACE = 59
MAX_ACTIVE = 12
HISTORY = 24

CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Optional("entity", default="sensor.energy_manager_plan"): cv.entity_id,
        vol.Optional("battery_capacity_entity", default="input_number.battery_capacity"): cv.entity_id,
        vol.Optional("battery_capacity_kwh"): vol.All(vol.Coerce(float), vol.Range(min=0.01)),
        vol.Optional("max_plan_age_minutes", default=20): vol.All(vol.Coerce(float), vol.Range(min=1, max=180)),
        vol.Optional("battery_charge_efficiency", default=0.95): vol.All(vol.Coerce(float), vol.Range(min=0, min_included=False, max=1)),
        vol.Optional("battery_discharge_efficiency", default=0.95): vol.All(vol.Coerce(float), vol.Range(min=0, min_included=False, max=1)),
    }),
}, extra=vol.ALLOW_EXTRA)

APPROVAL = {
    vol.Required("id"): str,
    vol.Required("name"): vol.All(str, vol.Length(min=1, max=80)),
    vol.Required("power"): vol.All(vol.Any(float, int), vol.Range(min=0.1, max=1000)),
    vol.Required("duration"): vol.All(int, vol.Range(min=60, max=86400)),
    vol.Required("source"): vol.In(SOURCES),
    vol.Required("timing"): vol.In(("fixed", "flexible")),
    vol.Required("policy"): vol.In(("must", "defer")),
    vol.Required("start"): vol.Any(int, None),
    vol.Required("deadline"): int,
    vol.Required("start_automation"): str,
    vol.Required("stop_automation"): str,
}


async def async_setup(hass, config):
    """Restore the queue, expose approval and start the scheduler with Core."""
    scheduler = Scheduler(hass, config[DOMAIN])
    await scheduler.restore()
    hass.data[DOMAIN] = scheduler
    for command in (ws_subscribe, ws_approve, ws_cancel, ws_retry_stop):
        websocket_api.async_register_command(hass, command)
    if hass.is_running:
        scheduler.start(None)
    else:
        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, scheduler.start)
    return True


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
def ws_subscribe(hass, connection, msg):
    """Subscribe to persisted status changes."""
    scheduler = hass.data[DOMAIN]
    unsubscribe = scheduler.subscribe(lambda data: connection.send_event(msg["id"], data))
    connection.subscriptions[msg["id"]] = unsubscribe
    connection.send_result(msg["id"])
    connection.send_event(msg["id"], scheduler.snapshot())


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/approve",
    vol.Required("jobs"): vol.All([APPROVAL], vol.Length(min=1, max=MAX_ACTIVE)),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_approve(hass, connection, msg):
    """Save a batch atomically before allowing scheduled actions."""
    ids = await hass.data[DOMAIN].approve(msg["jobs"])
    connection.send_result(msg["id"], {"ids": ids})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/cancel", vol.Required("job_id"): str})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_cancel(hass, connection, msg):
    await hass.data[DOMAIN].cancel(msg["job_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/retry_stop", vol.Required("job_id"): str})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_retry_stop(hass, connection, msg):
    await hass.data[DOMAIN].retry_stop(msg["job_id"])
    connection.send_result(msg["id"])


class Scheduler:
    def __init__(self, hass, config):
        self.hass = hass
        self.config = config
        self.store = Store(hass, 1, DOMAIN, atomic_writes=True)
        self.jobs = {}
        self.listeners = set()
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self.timer = None
        self.worker = None

    async def restore(self):
        saved = await self.store.async_load()
        if saved:
            self.jobs = {job["id"]: job for job in saved["jobs"]}
        jobs = deepcopy(self.jobs)
        for job in jobs.values():
            if job["status"] == "starting":
                if job["stop_automation"]:
                    job.update(status="running", note="Start was interrupted. Stop remains scheduled.")
                else:
                    job.update(status="failed", note="Start was interrupted. Check the appliance before scheduling it again.")
            if job["status"] == "stopping":
                job.update(status="running", stop_at=time(), note="Retrying the stop after Home Assistant restarted.")
        await self.commit(jobs)

    @callback
    def start(self, _event):
        entities = list({self.config["entity"], self.config["battery_capacity_entity"]})
        unsubscribe = async_track_state_change_event(self.hass, entities, self.request_tick)

        @callback
        def shutdown(_event):
            unsubscribe()
            if self.timer:
                self.timer()
            self.worker.cancel()

        self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, shutdown)
        self.worker = self.hass.async_create_background_task(self.run(), DOMAIN)
        self.wake.set()

    @callback
    def request_tick(self, _event=None):
        self.wake.set()

    def subscribe(self, listener):
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)

    def snapshot(self):
        return {
            "jobs": sorted(self.jobs.values(), key=lambda job: job["created"], reverse=True),
            "config": self.config,
        }

    async def commit(self, jobs):
        if jobs == self.jobs:
            return
        finished = sorted((job for job in jobs.values() if job["status"] not in ACTIVE),
                          key=lambda job: job["created"], reverse=True)
        for job in finished[HISTORY:]:
            del jobs[job["id"]]
        saved = {"jobs": list(jobs.values())}
        await self.store.async_save(saved)
        # Home Assistant's Store logs some write errors instead of raising them.
        if await self.store.async_load() != saved:
            raise HomeAssistantError("Could not verify the saved workload schedule.")
        self.jobs = jobs
        data = self.snapshot()
        for listener in tuple(self.listeners):
            try:
                listener(data)
            except Exception:
                LOGGER.exception("Could not publish the updated workload schedule")

    def automation_available(self, entity):
        state = self.hass.states.get(entity) if re.fullmatch(r"automation\.[a-z0-9_]+", entity) else None
        return state is not None and state.state in ("on", "off")

    async def approve(self, requested):
        async with self.lock:
            now = time()
            jobs = deepcopy(self.jobs)
            active_count = sum(job["status"] in ACTIVE for job in jobs.values())
            ids = []
            for item in requested:
                name = item["name"]
                try:
                    if str(UUID(item["id"])) != item["id"] or item["id"] in ids:
                        raise ValueError
                except ValueError:
                    raise vol.Invalid("Invalid or duplicate workload ID.") from None
                ids.append(item["id"])
                if item["id"] in jobs:
                    if jobs[item["id"]]["approval"] == item:
                        continue
                    raise vol.Invalid("This approval ID is already in use.")
                if active_count >= MAX_ACTIVE:
                    raise vol.Invalid(f"At most {MAX_ACTIVE} workloads can be active.")
                start, deadline, duration = item["start"], item["deadline"], item["duration"]
                if (not now < deadline <= now + 172800 or duration % 60
                        or deadline - duration <= now):
                    raise vol.Invalid(f"{name} needs a future finish time with enough time to run.")
                if start is None and item["timing"] != "flexible":
                    raise vol.Invalid(f"{name} needs a suggested start time.")
                if start is not None and (start <= now or start + duration > deadline):
                    raise vol.Invalid(f"The suggested start for {name} has expired. Review the refreshed times.")
                if not self.automation_available(item["start_automation"]):
                    raise vol.Invalid(f"Choose an available start automation for {name}.")
                stop = item["stop_automation"]
                if stop and (stop == item["start_automation"] or not self.automation_available(stop)):
                    raise vol.Invalid(f"Choose a different available stop automation for {name}.")
                if start is None and item["policy"] == "must":
                    start = deadline - duration
                if start is not None:
                    window = dict(item, start=start, end=start + duration)
                    existing = [self.reservation(job) for job in jobs.values()
                                if job["status"] in ACTIVE and job["start"] is not None]
                    if overlaps(window, existing):
                        raise vol.Invalid(f"{name} overlaps another approved run using the same automation.")
                jobs[item["id"]] = dict(
                    item, approval=dict(item), created=now, start=start, stop_at=None,
                    actual_start=None, status="scheduled" if item["start"] is not None else "delayed",
                    note="", start_failed=False,
                )
                active_count += 1
            await self.commit(jobs)
            self.wake.set()
            return ids

    async def cancel(self, job_id):
        async with self.lock:
            jobs = deepcopy(self.jobs)
            if job_id not in jobs or jobs[job_id]["status"] not in PENDING:
                raise vol.Invalid("Only a pending workload can be cancelled.")
            jobs[job_id].update(status="cancelled", note="")
            await self.commit(jobs)
            self.wake.set()

    async def retry_stop(self, job_id):
        async with self.lock:
            jobs = deepcopy(self.jobs)
            if job_id not in jobs or jobs[job_id]["status"] != "stop_failed":
                raise vol.Invalid("This workload has no failed stop to retry.")
            jobs[job_id].update(status="running", stop_at=time())
            await self.commit(jobs)
            self.wake.set()

    def forecast(self, earliest, now):
        state = self.hass.states.get(self.config["entity"])
        plan = state.attributes.get("energy_plan") if state and state.state not in ("unknown", "unavailable") else None
        capacity = self.config.get("battery_capacity_kwh")
        if capacity is None:
            entity = self.hass.states.get(self.config["battery_capacity_entity"])
            capacity = nonnegative(entity.state) if entity else None
        return read_forecast(plan, earliest, now, self.config["max_plan_age_minutes"] * 60, capacity)

    @staticmethod
    def reservation(job):
        start = job["actual_start"] if job["actual_start"] is not None else job["start"]
        end = job["stop_at"] if job["stop_at"] is not None else start + job["duration"]
        if job["status"] in ("stopping", "stop_failed") or (job["status"] == "running" and end <= time()):
            end = max(end, time() + 60)
        return dict(job, start=start, end=end, source="grid", reserved=True)

    async def run(self):
        while True:
            await self.wake.wait()
            self.wake.clear()
            if self.timer:
                self.timer()
                self.timer = None
            try:
                async with self.lock:
                    wake_at = await self.tick()
                    if wake_at is not None:
                        self.timer = async_track_point_in_utc_time(
                            self.hass, self.request_tick, datetime.fromtimestamp(wake_at, UTC))
            except Exception:
                LOGGER.exception("Could not process deferred workloads. Retrying in 30 seconds")
                self.timer = async_track_point_in_utc_time(
                    self.hass, self.request_tick, datetime.fromtimestamp(time() + 30, UTC))

    async def tick(self):
        now = time()
        jobs = deepcopy(self.jobs)
        stops = []
        remaining = []
        for job in jobs.values():
            if job["status"] not in {"starting", "running"}:
                continue
            if job["stop_at"] > now:
                remaining.append(job["stop_at"])
            elif job["stop_automation"]:
                job.update(status="stopping")
                stops.append(job["id"])
            else:
                job.update(status="failed" if job["start_failed"] or job["status"] == "starting" else "completed",
                           note=job["note"] if job["start_failed"] else
                           "Estimated run time elapsed." if job["status"] == "running" else "Start did not confirm.")
        await self.commit(jobs)
        for job_id in stops:
            self.dispatch(job_id, "stop")

        jobs = deepcopy(self.jobs)
        pending = [job for job in jobs.values() if job["status"] in PENDING]
        if pending:
            starts = []
            await self.plan_pending(jobs, pending, now, starts, remaining)
            await self.commit(jobs)
            for job_id in starts:
                self.dispatch(job_id, "start")
        return min(remaining, default=None)

    def dispatch(self, job_id, phase):
        self.hass.async_create_background_task(self.trigger(job_id, phase), f"{DOMAIN} {phase} {job_id}")

    async def plan_pending(self, jobs, pending, now, dispatch, remaining):
        fixed = [job for job in pending if job["timing"] == "fixed"]
        flexible = [job for job in pending if job["timing"] == "flexible"]
        active = [self.reservation(job) for job in jobs.values()
                  if job["status"] in {"starting", "running", "stopping", "stop_failed"}]
        # Include the saved start in the search when the timer fires a few seconds late.
        earliest = ceil(now / 60) * 60
        due_times = [job["start"] for job in pending if job["start"] is not None
                     and 0 <= now - job["start"] <= 10]
        if due_times:
            earliest = min(earliest, min(due_times))
        intervals, capacity = self.forecast(earliest, now)
        efficiencies = self.config["battery_charge_efficiency"], self.config["battery_discharge_efficiency"]

        for job in sorted(fixed, key=lambda job: job["start"]):
            if job["start"] > now:
                remaining.append(job["start"])
                continue
            if now - job["start"] > START_GRACE:
                job.update(status="skipped", note="Home Assistant missed the fixed start time.")
                continue
            window = self.reservation(job)
            if overlaps(window, active):
                job.update(status="skipped", note="Another run using this automation was still active.")
                continue
            if job["policy"] == "defer":
                fixed_rows, fixed_capacity = (intervals, capacity) if earliest <= window["start"] else self.forecast(
                    window["start"], now)
                covered = (fixed_rows and fixed_rows[0]["begin"] <= window["start"]
                           and fixed_rows[-1]["end"] >= window["end"])
                if not covered or replay(fixed_rows, [*active, dict(window, source=job["source"], reserved=False)],
                                         fixed_capacity, *efficiencies) is None:
                    job.update(status="skipped", note="The forecast no longer supports this fixed window.")
                    continue
            self.mark_start(job, now, dispatch, "Starting at the approved fixed time.")
            active.append(self.reservation(job))

        reserved = active + [self.reservation(job) for job in fixed if job["status"] in PENDING]
        urgent = [job for job in flexible if job["policy"] == "must"
                  and job["deadline"] - job["duration"] <= now]
        for job in urgent:
            latest = job["deadline"] - job["duration"]
            window = dict(job, start=now, end=now + job["duration"])
            if now - latest > START_GRACE:
                job.update(status="skipped", note="Home Assistant missed the latest start time.")
            elif overlaps(window, reserved):
                job.update(status="skipped", note="Another run using this automation was still active.")
            else:
                self.mark_start(job, now, dispatch, "Latest start reached. Grid energy may be used.")
                reserved.append(self.reservation(job))

        flexible = [job for job in flexible if job["status"] in PENDING]
        starts = await self.hass.async_add_executor_job(
            recommend, intervals, flexible, reserved, capacity, *efficiencies) if intervals and flexible else {}
        for job in sorted(flexible, key=lambda job: starts.get(job["id"], float("inf"))):
            latest = job["deadline"] - job["duration"]
            start = starts.get(job["id"])
            if start is not None and start <= now:
                window = dict(job, start=now, end=now + job["duration"])
                if not overlaps(window, reserved):
                    self.mark_start(job, now, dispatch, "Starting in a forecast window.")
                    reserved.append(self.reservation(job))
                    continue
                start = None
            if now >= latest:
                job.update(status="skipped", note="No suitable window was available by the deadline.")
            elif start is not None:
                moved = start != job["approval"]["start"]
                job.update(start=start, status="delayed" if moved and
                           (job["approval"]["start"] is None or start > job["approval"]["start"]) else "scheduled",
                           note="Moved with the updated forecast." if moved else "")
                remaining.append(start)
            else:
                job.update(start=latest if job["policy"] == "must" else None, status="delayed",
                           note="Waiting for a suitable window. Will run by the latest start."
                           if job["policy"] == "must" else "Waiting for a suitable window.")
                remaining.append(latest)

        remaining.extend(job["stop_at"] for job in jobs.values() if job["status"] == "starting"
                         and job["stop_at"] > now)

    @staticmethod
    def mark_start(job, now, dispatch, note):
        job.update(status="starting", actual_start=now, stop_at=now + job["duration"], note=note)
        dispatch.append(job["id"])

    async def trigger(self, job_id, phase):
        job = self.jobs[job_id]
        entity = job[f"{phase}_automation"]
        context = Context()
        received = asyncio.Event()
        triggered_at = None

        @callback
        def triggered(event):
            nonlocal triggered_at
            if (event.data.get("entity_id") == entity
                    and context.id in (event.context.id, event.context.parent_id)):
                triggered_at = event.time_fired.timestamp()
                received.set()

        unsubscribe = self.hass.bus.async_listen("automation_triggered", triggered)
        error = ""
        call = None
        try:
            if not self.automation_available(entity):
                error = f"{phase.capitalize()} automation is unavailable."
            else:
                call = self.hass.async_create_task(self.hass.services.async_call(
                    "automation", "trigger", {"entity_id": entity, "skip_condition": False},
                    blocking=True, context=context,
                ))
                observed = asyncio.create_task(received.wait())
                try:
                    await asyncio.wait((call, observed), return_when=asyncio.FIRST_COMPLETED)
                    if triggered_at is not None and phase == "start":
                        await self.record_trigger(job_id, triggered_at)
                    await call
                    if triggered_at is None:
                        error = f"{phase.capitalize()} automation did not run. Check its conditions and trace."
                finally:
                    observed.cancel()
        except Exception:
            LOGGER.exception("Deferred workload %s automation failed for %s", phase, entity)
            error = f"{phase.capitalize()} automation reported an error. Check its trace."
        finally:
            unsubscribe()

        async with self.lock:
            jobs = deepcopy(self.jobs)
            job = jobs.get(job_id)
            if job is None:
                return
            if phase == "start" and job["status"] in {"starting", "running"}:
                if error and triggered_at is None:
                    job.update(status="failed", note=error, stop_at=None)
                elif error:
                    job.update(status="running", start_failed=True, note=error)
                elif job["status"] == "starting":
                    job.update(status="running", actual_start=triggered_at, stop_at=triggered_at + job["duration"])
            elif phase == "stop" and job["status"] == "stopping":
                job.update(status="stop_failed" if error else "failed" if job["start_failed"] else "completed",
                           note=error or ("Stop ran after an error in the start automation."
                                          if job["start_failed"] else "Stop automation ran."))
            await self.commit(jobs)
            self.wake.set()

    async def record_trigger(self, job_id, triggered_at):
        async with self.lock:
            jobs = deepcopy(self.jobs)
            job = jobs[job_id]
            if job["status"] == "starting":
                job.update(status="running", actual_start=triggered_at, stop_at=triggered_at + job["duration"])
                await self.commit(jobs)
                self.wake.set()
