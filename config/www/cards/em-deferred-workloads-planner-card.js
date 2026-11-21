const cardType = "em-deferred-workloads-planner-card";
const defaultEntity = "sensor.energy_manager_plan";
const defaultCapacityEntity = "input_number.battery_capacity";
const minute = 60000;
const hour = 60 * minute;
const energyTolerance = 1e-7;

function finite(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative(value) {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function extractIntervals(timeline, earliest) {
  if (!Array.isArray(timeline)) return [];
  const intervals = [];

  for (const row of timeline) {
    const start = Date.parse(row?.ts);
    const minutes = finite(row?.interval_minutes);
    if (!Number.isFinite(start) || !(minutes > 0)) continue;
    const end = start + minutes * minute;
    if (end <= earliest) continue;

    const inputs = row.inputs;
    const expected = row.expected;
    const solar = nonnegative(inputs?.pv_kw);
    const house = nonnegative(inputs?.load_kw);
    const ev = nonnegative(inputs?.ev_charge_kw ?? row.ev?.charge_kw);
    const totalLoad = nonnegative(inputs?.total_load_kw) ??
      (house !== null && ev !== null ? house + ev : null);
    const charge = nonnegative(expected?.battery_charge_kw);
    const discharge = nonnegative(expected?.battery_discharge_kw);
    const gridImport = nonnegative(expected?.grid_import_kw);
    const gridExport = nonnegative(expected?.grid_export_kw);
    if ([solar, totalLoad, charge, discharge, gridImport, gridExport].includes(null)) continue;

    const headroom = gridImport > 0.005 ? 0 :
      Math.max(0, Math.min(solar - totalLoad - charge, gridExport - discharge));
    const controls = row.setpoints;
    const constraints = row.constraints;
    const forcedExport = row.mode === "FORCED_EXPORT" || nonnegative(controls?.force_export_kw) > 0;
    const canSelfConsume = row.mode === "SELF_CONSUMPTION" && !forcedExport &&
      nonnegative(controls?.force_charge_kw) === 0;

    const minSoc = nonnegative(constraints?.min_soc_pct);
    const reserve = nonnegative(controls?.soc_reserve_pct);
    const startSoc = nonnegative(inputs?.soc_pct_start);
    const endSoc = nonnegative(expected?.soc_pct_end);

    const tapered = forcedExport && discharge > 0 &&
      gridExport + 0.005 < nonnegative(controls?.force_export_kw);
    intervals.push({
      start, end, headroom, charge, discharge, gridImport, gridExport, startSoc, endSoc,
      evBattery: nonnegative(inputs?.ev_battery_kw ?? row.ev?.battery_kw) ?? 0,
      importLimit: nonnegative(controls?.import_limit_kw),
      chargeTarget: nonnegative(constraints?.max_soc_pct),
      buyPrice: finite(inputs?.buy_price),
      sellPrice: finite(inputs?.sell_price),
      minSoc,
      floor: minSoc === null || reserve === null ? null :
        Math.max(minSoc, reserve, forcedExport ? nonnegative(constraints?.peak_reserve_pct) ?? 0 : 0,
          tapered ? endSoc ?? 0 : 0),
      restrictedBelow: constraints?.battery_discharge_restriction_enabled === true ?
        nonnegative(constraints.battery_discharge_restriction_under_pct) ?? 0 : 0,
      chargeLimit: nonnegative(controls?.charge_limit_kw),
      dischargeLimit: nonnegative(controls?.discharge_limit_kw),
      canSelfConsume,
    });
  }

  return intervals.sort((a, b) => a.start - b.start);
}

const sources = [
  ["solar", "Surplus solar only"],
  ["battery", "Solar + battery"],
  ["grid", "Grid allowed"],
];
const beamWidth = 12;
const forecastRoundingKw = 0.005;

function continuousForecast(rows, earliest) {
  const intervals = [];
  let cursor = Math.max(earliest, rows[0]?.start ?? earliest);
  for (const row of rows) {
    if (row.end <= cursor) continue;
    if (row.start > cursor) break;
    intervals.push({ ...row, from: cursor });
    cursor = row.end;
  }
  return intervals;
}

function addCost(total, energy, rate) {
  if (energy <= energyTolerance) return total;
  return total === null || rate === null ? null : total + energy * rate;
}

// Replay all assigned workloads against one forecast. Earlier battery use
// carries forward into later workloads and normal household consumption.
function evaluateSchedule(intervals, placements, battery) {
  const jobs = placements.map(window => ({ ...window, solar: 0, battery: 0, grid: 0, cost: 0 }));
  // Constrained workloads have first claim on the sources they can use.
  jobs.sort((a, b) => a.sourceIndex - b.sourceIndex || a.id - b.id);
  let deficit = 0;
  let grid = 0;
  let solar = 0;
  let gridCost = 0;
  let exportImpact = 0;
  let afterRunGrid = 0;
  let afterRunCost = 0;
  const lastFinish = Math.max(...jobs.map(job => job.end));

  for (const row of intervals) {
    const intervalJobs = jobs.filter(job => job.start < row.end && job.end > row.from);
    if (!intervalJobs.length && deficit <= energyTolerance) continue;
    const cuts = new Set([row.from, row.end]);
    for (const job of intervalJobs) {
      cuts.add(Math.max(row.from, job.start));
      cuts.add(Math.min(row.end, job.end));
    }
    const boundaries = [...cuts].sort((a, b) => a - b);
    for (let i = 1; i < boundaries.length; i++) {
      const from = boundaries[i - 1];
      const to = boundaries[i];
      const hours = (to - from) / hour;
      const baseEnd = row.startSoc + (row.endSoc - row.startSoc) *
        (to - row.start) / (row.end - row.start);
      const plannedDischarge = row.discharge * hours;
      // First account for any planned discharge that the earlier loads displaced.
      const floor = Math.min(baseEnd, row.floor);
      const lostDischarge = battery ? Math.min(plannedDischarge,
        Math.max(0, deficit - battery.capacity * (baseEnd - floor) / 100) * battery.dischargeEfficiency) : 0;
      if (lostDischarge > Math.max(0, row.discharge - row.evBattery) * hours + energyTolerance) return null;
      if (lostDischarge > energyTolerance) deficit -= lostDischarge / battery.dischargeEfficiency;
      const lostExport = Math.min(lostDischarge, row.gridExport * hours);
      const houseGrid = lostDischarge - lostExport;
      let extraGrid = houseGrid;
      let exportUsed = lostExport;
      let surplus = row.headroom * hours;
      let discharge = 0;
      if (battery && row.canSelfConsume && row.charge <= forecastRoundingKw && row.dischargeLimit !== null) {
        const reserve = Math.max(row.floor, row.restrictedBelow);
        const usable = Math.max(0, (baseEnd - reserve) * battery.capacity / 100 - deficit);
        const powerRoom = Math.max(0, (row.dischargeLimit - row.discharge) * hours + lostDischarge);
        discharge = Math.min(usable * battery.dischargeEfficiency, powerRoom);
      }

      for (const job of intervalJobs) {
        if (job.start >= to || job.end <= from) continue;
        const demand = job.power * hours;
        const direct = Math.min(surplus, demand);
        surplus -= direct;
        const stored = job.sourceIndex === 0 ? 0 : Math.min(discharge, demand - direct);
        discharge -= stored;
        const imported = Math.max(0, demand - direct - stored);
        if (imported > energyTolerance && job.sourceIndex !== 2) return null;
        if (stored > energyTolerance) deficit += stored / battery.dischargeEfficiency;
        job.solar += direct;
        job.battery += stored;
        job.grid += imported;
        job.cost = addCost(addCost(job.cost, direct, row.sellPrice), imported, row.buyPrice);
        solar += direct;
        extraGrid += imported;
        exportUsed += direct;
      }

      // Preserve forecast charging and use remaining forecast exports to
      // replenish the extra discharge when the inverter has capacity.
      if (battery && deficit > energyTolerance && row.canSelfConsume &&
          row.discharge <= forecastRoundingKw && row.chargeLimit !== null) {
        const room = Math.max(0, row.chargeLimit - row.charge) * hours;
        const refill = Math.min(surplus, room, deficit / battery.chargeEfficiency);
        deficit = Math.max(0, deficit - refill * battery.chargeEfficiency);
        exportUsed += refill;
      }
      if (battery && to === row.end && row.charge > forecastRoundingKw &&
          row.chargeTarget !== null && row.endSoc >= row.chargeTarget - 0.05 &&
          baseEnd - deficit / battery.capacity * 100 < row.chargeTarget - 0.05) return null;
      if (row.importLimit !== null &&
          extraGrid > Math.max(0, row.importLimit - row.gridImport) * hours + energyTolerance) return null;

      grid += extraGrid;
      gridCost = addCost(gridCost, extraGrid, row.buyPrice);
      exportImpact = addCost(exportImpact, exportUsed, row.sellPrice);
      if (from >= lastFinish) {
        afterRunGrid += houseGrid;
        afterRunCost = addCost(afterRunCost, houseGrid, row.buyPrice);
      }
    }
  }
  return {
    jobs, grid, solar, deficit, gridCost, exportImpact, afterRunGrid, afterRunCost,
    totalCost: gridCost === null || exportImpact === null ? null : gridCost + exportImpact,
  };
}

function possibleStarts(intervals, job, latest, placements = []) {
  const earliest = intervals[0].from;
  const starts = new Set();
  if (!placements.length) {
    starts.add(earliest);
    starts.add(latest);
    for (const { from, end } of intervals) {
      starts.add(from);
      starts.add(end - job.duration);
    }
  }
  for (const { start, end } of placements) {
    starts.add(start);
    starts.add(end);
    starts.add(start - job.duration);
    starts.add(end - job.duration);
  }
  return [...starts].filter(start => start >= earliest && start <= latest);
}

function compareSchedules(a, b) {
  if (b.jobs.length !== a.jobs.length) return b.jobs.length - a.jobs.length;
  if ((a.totalCost === null) !== (b.totalCost === null)) return a.totalCost === null ? 1 : -1;
  for (const difference of [
    (a.totalCost ?? 0) - (b.totalCost ?? 0), a.grid - b.grid,
    a.deficit - b.deficit, b.solar - a.solar,
  ]) {
    if (Math.abs(difference) > energyTolerance) return difference;
  }
  return a.finish - b.finish || a.starts - b.starts;
}

function recommend(intervals, workloads, battery) {
  const horizon = intervals.at(-1).end;
  const jobs = workloads.map(job => {
    const latest = Math.min(job.deadline ?? horizon, horizon) - job.duration;
    const candidates = possibleStarts(intervals, job, latest)
      .map(start => ({ ...job, start, end: start + job.duration }))
      .map(window => ({ window, result: evaluateSchedule(intervals, [window], battery) }))
      .filter(candidate => candidate.result);
    return { ...job, latest, candidates };
  });
  // Try the constrained jobs first. Keep alternative schedules so a cheap
  // individual window cannot automatically displace another workload.
  jobs.sort((a, b) => (a.candidates.length || Infinity) - (b.candidates.length || Infinity) ||
    (a.deadline ?? horizon) - (b.deadline ?? horizon) || a.sourceIndex - b.sourceIndex ||
    b.duration - a.duration || a.id - b.id);

  const empty = { ...evaluateSchedule(intervals, [], battery), placements: [], finish: 0, starts: 0 };
  let schedules = [empty];
  for (const job of jobs) {
    const { candidates, latest, ...workload } = job;
    const known = new Map(candidates.map(({ window, result }) => [window.start, result]));
    const alternatives = [...schedules];
    for (const schedule of schedules) {
      const starts = schedule.placements.length ?
        new Set([...known.keys(), ...possibleStarts(intervals, workload, latest, schedule.placements)]) : known.keys();
      for (const start of starts) {
        const window = { ...workload, start, end: start + workload.duration };
        const placements = [...schedule.placements, window];
        const result = schedule.placements.length ? evaluateSchedule(intervals, placements, battery) :
          (known.get(start) ?? evaluateSchedule(intervals, placements, battery));
        if (result) alternatives.push({ ...result, placements, finish: Math.max(schedule.finish, window.end),
          starts: schedule.starts + start });
      }
    }
    alternatives.sort(compareSchedules);
    schedules = alternatives.slice(0, beamWidth);
    // Retain the empty schedule when it has fallen out of the shortlist.
    if (!schedules.includes(empty)) schedules.push(empty);
  }
  return schedules[0];
}

function wallTime(timestamp, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

function parseDeadline(value, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const target = Date.parse(value + "Z");
  if (!Number.isFinite(target)) return null;
  // Date inputs have no timezone. Resolve them in Home Assistant's zone,
  // including the offset on either side of a daylight-saving transition.
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23",
  });
  const candidates = [-36, 0, 36].map(delta => target + delta * hour)
    .map(probe => target - (wallTime(probe, formatter) - probe))
    .filter(candidate => wallTime(candidate, formatter) === target);
  return candidates.length ? Math.max(...candidates) : null;
}

class EmDeferredWorkloadsPlannerCard extends HTMLElement {
  constructor() {
    super();
    this._nextId = 1;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        [hidden] { display: none !important; }
        ha-card {
          --planner-muted: var(--secondary-text-color, #656c75);
          --planner-line: var(--divider-color, #85858555);
          --planner-solar: var(--energy-solar-color, #e8a21c);
          --planner-grid: var(--info-color, #478fe0);
          padding: 16px;
          container-type: inline-size;
          color: var(--primary-text-color, #242424);
        }
        * { box-sizing: border-box; }
        h2, h3, p { margin: 0; }
        h2 { font-size: 19px; }
        h3 { font-size: 15px; }
        header { display: flex; align-items: flex-start; gap: 9px; }
        header ha-icon { color: var(--planner-solar); --mdc-icon-size: 22px; }
        header p, .muted, small { color: var(--planner-muted); font-size: 12px; }
        header p { margin-top: 2px; }
        #editors { display: grid; gap: 8px; margin-top: 14px; }
        .editor {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(60px,.5fr) minmax(60px,.6fr)
            minmax(135px,1fr) minmax(110px,.9fr) 32px;
          align-items: end;
          gap: 6px;
        }
        label { display: grid; min-width: 0; gap: 3px; font-size: 11px; color: var(--planner-muted); }
        input, select, button {
          min-height: 34px;
          min-width: 0;
          border: 1px solid var(--planner-line);
          border-radius: 6px;
          color: var(--primary-text-color, #242424);
          font: inherit;
        }
        input, select {
          width: 100%;
          padding: 4px 6px;
          background: var(--secondary-background-color, transparent);
          font-size: 13px;
          color-scheme: var(--ha-card-color-scheme, light dark);
        }
        button { background: transparent; padding: 4px 10px; cursor: pointer; }
        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid var(--primary-color, #03a9f4);
          outline-offset: 1px;
        }
        .remove { padding: 0; font-size: 19px; }
        .editor-toolbar { margin-top: 10px; }
        #status { margin-top: 12px; color: var(--planner-muted); }
        #schedule { border-top: 1px solid var(--planner-line); margin-top: 14px; padding-top: 12px; }
        .schedule-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        #recommendations { display: grid; gap: 6px; padding: 0; margin: 8px 0; list-style: none; }
        .recommendation {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(0,1.15fr) minmax(0,1.3fr);
          gap: 8px;
          padding: 8px 10px;
          border: 1px solid var(--planner-line);
          border-inline-start-width: 3px;
          border-radius: 7px;
          font-size: 13px;
          overflow-wrap: anywhere;
        }
        .recommendation[data-source="solar"] { border-inline-start-color: var(--planner-solar); }
        .recommendation[data-source="battery"], .recommendation[data-source="grid"] { border-inline-start-color: var(--planner-grid); }
        .recommendation small { display: block; margin-top: 2px; }
        .recommendation[data-source="unplaced"] .detail { grid-column: span 2; }
        #totals { margin-top: 10px; font-size: 13px; }
        #effects { margin-top: 5px; }
        @container (max-width: 610px) {
          .editor {
            grid-template-columns: minmax(0,1fr) minmax(0,1fr) 32px;
            grid-template-areas: "name name remove" "power duration duration" "deadline source source";
          }
          .workload-name { grid-area: name; }
          .workload-power { grid-area: power; }
          .workload-duration { grid-area: duration; }
          .workload-deadline { grid-area: deadline; }
          .power-source { grid-area: source; }
          .remove { grid-area: remove; }
          .recommendation { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
          .recommendation .detail { grid-column: 1 / -1; }
        }
        @container (max-width: 410px) {
          .editor {
            grid-template-areas: "name name remove" "power duration duration"
              "deadline deadline deadline" "source source source";
          }
        }
      </style>
      <ha-card>
        <header>
          <ha-icon icon="mdi:solar-power-variant" aria-hidden="true"></ha-icon>
          <div><h2 id="title"></h2><p>Suggested times based on your energy forecast</p></div>
        </header>
        <div id="editors"></div>
        <template id="editor">
          <div class="editor">
            <label class="workload-name">Workload<input data-field="name" type="text" placeholder="Workload name"></label>
            <label class="workload-power">Power (kW)<input data-field="power" type="number" min="0.1" step="0.1" inputmode="decimal"></label>
            <label class="workload-duration">Duration (min)<input data-field="minutes" type="number" min="1" step="1" inputmode="numeric"></label>
            <label class="workload-deadline">Finish by (optional)<input data-field="deadline" type="datetime-local" step="60"></label>
            <label class="power-source">Power source<select data-field="source"></select></label>
            <button class="remove" type="button" aria-label="Remove workload" title="Remove workload">×</button>
          </div>
        </template>
        <div class="editor-toolbar"><button id="add" type="button">+ Add workload</button></div>
        <p id="status" role="status" hidden></p>
        <section id="schedule" aria-labelledby="schedule-title" hidden>
          <div class="schedule-heading"><h3 id="schedule-title">Suggested schedule</h3><span id="horizon" class="muted"></span></div>
          <ul id="recommendations"></ul>
          <p id="totals"></p>
          <p id="effects" class="muted" hidden></p>
        </section>
      </ha-card>`;
    this._get("add").addEventListener("click", () => this._addWorkload(false, true));
    this._addWorkload(true);
  }

  setConfig(config = {}) {
    const maxAge = finite(config.max_plan_age_minutes ?? 20);
    const chargeEfficiency = finite(config.battery_charge_efficiency ?? 0.95);
    const dischargeEfficiency = finite(config.battery_discharge_efficiency ?? 0.95);
    if (!(maxAge > 0)) throw new Error("max_plan_age_minutes must be greater than zero");
    if (!(chargeEfficiency > 0 && chargeEfficiency <= 1 && dischargeEfficiency > 0 && dischargeEfficiency <= 1)) {
      throw new Error("Battery efficiencies must be greater than zero and at most 1");
    }
    this._config = {
      entity: config.entity ?? defaultEntity,
      capacityEntity: config.battery_capacity_entity ?? defaultCapacityEntity,
      capacity: nonnegative(config.battery_capacity_kwh),
      title: config.name ?? "Deferred Workloads Planner",
      maxAge: maxAge * minute,
      chargeEfficiency,
      dischargeEfficiency,
    };
    this._get("title").textContent = this._config.title;
    this._render();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._config) return;
    const { entity, capacityEntity } = this._config;
    if (!old || old.states?.[entity] !== hass.states?.[entity] ||
        old.states?.[capacityEntity] !== hass.states?.[capacityEntity] ||
        old.config?.time_zone !== hass.config?.time_zone || old.language !== hass.language) this._render();
  }

  connectedCallback() {
    this._clockTimer = setInterval(() => this._render(), minute);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._clockTimer);
    clearTimeout(this._editTimer);
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  _get(id) { return this.shadowRoot.getElementById(id); }

  _addWorkload(defaults = false, focus = false) {
    const row = this._get("editor").content.firstElementChild.cloneNode(true);
    row.dataset.id = String(this._nextId++);
    const input = field => row.querySelector(`[data-field="${field}"]`);
    if (defaults) {
      input("power").value = 1;
      input("minutes").value = 60;
    }
    for (const [value, label] of sources) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      input("source").append(option);
    }
    row.addEventListener("input", () => {
      clearTimeout(this._editTimer);
      this._editTimer = setTimeout(() => this._render(), 200);
    });
    row.querySelector(".remove").addEventListener("click", () => {
      row.remove();
      this._get("add").focus();
      this._render();
    });
    this._get("editors").append(row);
    if (focus) input("name").focus();
    this._render();
  }

  _readWorkloads(timeZone, earliest) {
    return Array.from(this._get("editors").children, (row, index) => {
      const value = field => row.querySelector(`[data-field="${field}"]`).value;
      const power = finite(value("power"));
      const minutes = finite(value("minutes"));
      const deadlineValue = value("deadline");
      const deadline = deadlineValue ? parseDeadline(deadlineValue, timeZone) : null;
      let problem = "";
      if (!(power >= 0.1) || !Number.isSafeInteger(minutes) || minutes < 1) {
        problem = "Enter a power and a whole-minute duration.";
      } else if (deadlineValue && deadline === null) {
        problem = "Choose a valid finish time in " + (timeZone ?? "your local timezone") + ".";
      } else if (deadline !== null && deadline < earliest + minutes * minute) {
        problem = "The workload cannot finish by this deadline.";
      }
      return {
        id: Number(row.dataset.id), name: value("name").trim() || "Workload " + (index + 1),
        power, duration: minutes * minute, deadline,
        sourceIndex: sources.findIndex(([key]) => key === value("source")),
        problem,
      };
    });
  }

  _render() {
    if (!this._config) return;
    const { entity, capacityEntity, capacity, maxAge, chargeEfficiency, dischargeEfficiency } = this._config;
    const state = this._hass?.states?.[entity];
    const plan = state?.attributes?.energy_plan;
    const now = Date.now();
    const generated = Date.parse(plan?.meta?.generated_at ?? plan?.summary?.ts);
    const showStatus = message => {
      this._get("status").textContent = message;
      this._get("status").hidden = false;
      this._get("schedule").hidden = true;
    };
    if (!plan || ["unavailable", "unknown"].includes(state.state)) {
      showStatus("Waiting for the Energy Manager plan.");
      return;
    }
    if (!Number.isFinite(generated) || now - generated > maxAge || generated - now > minute) {
      showStatus("Waiting for an up-to-date energy forecast.");
      return;
    }

    const intervals = continuousForecast(extractIntervals(plan.timeline, now), Math.ceil(now / minute) * minute);
    if (!intervals.length) {
      showStatus("The energy plan has no upcoming usable forecast intervals.");
      return;
    }
    const timeZone = this._hass.config?.time_zone || undefined;
    const workloads = this._readWorkloads(timeZone, intervals[0].from);
    if (!workloads.length) {
      showStatus("Add a workload to see suggested times.");
      return;
    }
    const siteCapacity = capacity || nonnegative(this._hass.states?.[capacityEntity]?.state);
    const battery = siteCapacity && intervals.every(row =>
      [row.startSoc, row.endSoc, row.floor].every(value => value !== null && value <= 100)) ?
      { capacity: siteCapacity, chargeEfficiency, dischargeEfficiency } : null;
    const schedule = recommend(intervals, workloads.filter(row => !row.problem), battery);
    this._renderSchedule(workloads, schedule, intervals, battery, timeZone, now);
    this._get("status").hidden = true;
    this._get("schedule").hidden = false;
  }

  _renderSchedule(workloads, schedule, intervals, battery, timeZone, now) {
    const last = intervals.at(-1);
    const locale = this._hass.language || undefined;
    const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone });
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone });
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const money = new Intl.NumberFormat(locale, {
      style: "currency", currency: this._hass.config?.currency || "AUD", currencyDisplay: "narrowSymbol",
    });
    const kwh = value => number.format(value) + " kWh";
    const cost = value => value === null ? "Cost unavailable" : money.format(value);
    const startLabel = date => day.format(date) === day.format(now) ? "Today" : day.format(date);
    const jobs = new Set(schedule.jobs.map(job => job.id));
    const list = this._get("recommendations");
    list.replaceChildren();
    const rows = [...schedule.jobs.sort((a, b) => a.start - b.start || a.id - b.id),
      ...workloads.filter(row => !jobs.has(row.id))];
    for (const row of rows) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("div");
      item.className = "recommendation";
      title.textContent = row.name;
      detail.className = "detail";
      item.append(title);
      if (row.start !== undefined) {
        const time = document.createElement("span");
        const endDay = day.format(row.start) === day.format(row.end) ? "" : day.format(row.end) + ", ";
        time.textContent = startLabel(row.start) + ", " + clock.format(row.start) + "–" + endDay + clock.format(row.end);
        item.dataset.source = row.grid > energyTolerance ? "grid" : row.battery > energyTolerance ? "battery" : "solar";
        const mix = [[row.solar, "surplus solar"], [row.battery, "battery"], [row.grid, "grid"]]
          .filter(([energy]) => energy > energyTolerance)
          .map(([energy, source]) => kwh(energy) + " " + source);
        detail.textContent = mix.join(" · ");
        const amount = document.createElement("small");
        amount.textContent = "During run · " + cost(row.cost);
        detail.append(amount);
        item.append(time);
      } else {
        item.dataset.source = "unplaced";
        detail.textContent = row.problem || (row.duration > last.end - intervals[0].from ?
          "The forecast is too short for this duration." : "No suitable window found.");
      }
      item.append(detail);
      list.append(item);
    }

    this._get("horizon").textContent = "Forecast through " + startLabel(last.end) + ", " + clock.format(last.end);
    const totals = this._get("totals");
    totals.hidden = !schedule.jobs.length;
    totals.textContent = "Estimated added cost " + cost(schedule.totalCost) +
      " · Extra grid cost " + cost(schedule.gridCost) + " · Feed-in impact " + cost(schedule.exportImpact);
    const notes = [];
    if (schedule.afterRunGrid >= 0.005) {
      notes.push(kwh(schedule.afterRunGrid) + " extra grid use after the last run (" + cost(schedule.afterRunCost) + ").");
    }
    if (battery && schedule.deficit >= 0.005) {
      const endSoc = Math.max(0, last.endSoc - schedule.deficit / battery.capacity * 100);
      notes.push("Battery at forecast end " + number.format(endSoc) + "% vs " + number.format(last.endSoc) + "% planned.");
      if (endSoc <= last.minSoc + 0.1) notes.push("Further grid use beyond the forecast is possible.");
    }
    if (!battery && workloads.some(row => row.sourceIndex !== 0)) {
      notes.push("Battery support is unavailable without capacity and state-of-charge forecast data.");
    }
    const effects = this._get("effects");
    effects.hidden = !notes.length;
    effects.textContent = notes.join(" ");
  }
}

if (!customElements.get(cardType)) {
  customElements.define(cardType, EmDeferredWorkloadsPlannerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: cardType,
    name: "Deferred Workloads Planner",
    description: "Find suggested times for workloads using the Energy Manager forecast.",
  });
}
