/**
 * Energy Manager: first-run sidebar defaults (Home Assistant 2026.11+).
 * Loaded through frontend.extra_module_url, NOT a Lovelace dashboard resource.
 * This is a one-time preference seed, not a permanently enforced sidebar.
 */
const POLICY_URL = '/local/em-sidebar-first-run.json';
const ORDER = [
  'energy-pv',
  'energy-overview',
  'energy-costs',
  'energy-ev',
  'energy-scheduler',
  'grafana-energy',
];
const HIDE = ['map', 'logbook', 'history', 'media-browser', 'todo', 'lovelace'];
const VERSION = 1;

// Avoid running twice if the module is requested more than once.
if (!window.__emSidebarInitialiserLoaded) {
  window.__emSidebarInitialiserLoaded = true;
  void initialise();
}

async function initialise() {
  let policy;
  try {
    const response = await fetch(POLICY_URL, { cache: 'no-store' });
    // An existing installation will not have this file: silently exit.
    if (!response.ok) return;
    policy = await response.json();
    if (policy?.enabled !== true || policy?.schema_version !== VERSION) return;
  } catch (_err) {
    return;
  }

  // HA panel registration is asynchronous (especially Supervisor Apps).
  // Fail closed: apply NOTHING unless all 7 requested panels are identifiable.
  for (let attempt = 0; attempt < 180; attempt++) {
    const root = document.querySelector('home-assistant');
    const hass = root?.hass;
    if (hass?.connection && hass?.user && hass?.panels) {
      const panels = Object.values(hass.panels);
      const studio = panels.filter((p) =>
        /^studio code server$/i.test(String(p.title || '').trim())
      );
      const available = new Set(panels.map((p) => p.url_path));
      if (ORDER.every((slug) => available.has(slug)) && studio.length === 1) {
        await seedForUser(hass, [...ORDER, studio[0].url_path], available);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function seedForUser(hass, order, available) {
  const connection = hass.connection;
  const get = async (key) => {
    const result = await connection.sendMessagePromise({
      type: 'frontend/get_user_data', key,
    });
    return result?.value;
  };
  const set = (key, value) => connection.sendMessagePromise({
    type: 'frontend/set_user_data', key, value,
  });

  try {
    const existing = await get('sidebar');
    // Any existing saved sidebar state means the user owns it, even empty arrays.
    if (existing !== null && existing !== undefined) return;
    // Respect old installations whose settings have not migrated from localStorage.
    if (localStorage.getItem('sidebarPanelOrder') !== null ||
        localStorage.getItem('sidebarHiddenPanels') !== null) return;

    const core = await get('core');
    // If user selected a default dashboard, do not override it. HA always shows
    // the default panel, even if listed in hiddenPanels.
    if (core?.default_panel && core.default_panel !== 'energy-pv') return;

    // Avoid hiding an unknown panel: use exactly the registered identifiers.
    const hidden = HIDE.filter((slug) => available.has(slug));
    if (!available.has('lovelace')) {
      // HA may expose the stock Overview under another path; never guess it.
      console.info('[Energy Manager] Default Overview panel not found; leaving it visible.');
    }

    // Set PV as this user's default to prevent Overview being forced visible.
    if (core?.default_panel !== 'energy-pv') {
      await set('core', { ...(core || {}), default_panel: 'energy-pv' });
    }
    // No force: user is free to rearrange/unhide afterwards.
    await set('sidebar', { panelOrder: order, hiddenPanels: hidden });
    console.info('[Energy Manager] Initial sidebar preferences saved for this user.');
  } catch (err) {
    console.warn('[Energy Manager] Sidebar defaults not applied:', err);
  }
}
