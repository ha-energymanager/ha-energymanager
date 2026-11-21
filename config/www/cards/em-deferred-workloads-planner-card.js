const cardType = "em-deferred-workloads-planner-card";
const schedulerDomain = "em_deferred_workloads";
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
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

    const flexibleSolarCharge = canSelfConsume && gridImport <= forecastRoundingKw &&
      discharge <= forecastRoundingKw ? Math.min(charge, Math.max(0, solar - totalLoad - headroom)) : 0;
    intervals.push({
      start, end, headroom, flexibleSolarCharge, charge, discharge, gridImport, gridExport, startSoc, endSoc,
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
  ["priority", "Solar before battery charging"],
  ["grid", "Grid allowed"],
];
const sourceOrder = { solar: 0, priority: 1, battery: 2, grid: 3 };
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

function evaluateSchedule(intervals, placements, battery) {
  const jobs = placements.map(window => ({
    ...window, solar: 0, divertedSolar: 0, battery: 0, grid: 0, cost: 0,
  }));

  jobs.sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || a.id - b.id);
  let deficit = 0;
  let priorityDeficit = 0;
  let missedChargeTarget = null;
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
      let flexibleCharge = battery ? row.flexibleSolarCharge * hours : 0;
      let divertedCharge = 0;
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
        const diverted = job.source === "priority" ? Math.min(flexibleCharge, demand - direct) : 0;
        flexibleCharge -= diverted;
        divertedCharge += diverted;
        const canUseBattery = job.source === "battery" || job.source === "grid";
        const stored = canUseBattery ? Math.min(discharge, demand - direct) : 0;
        discharge -= stored;
        const imported = Math.max(0, demand - direct - diverted - stored);
        if (imported > energyTolerance && job.source !== "grid") return null;
        if (stored > energyTolerance) deficit += stored / battery.dischargeEfficiency;
        job.solar += direct;
        job.divertedSolar += diverted;
        job.battery += stored;
        job.grid += imported;
        job.cost = addCost(addCost(job.cost, direct, row.sellPrice), imported, row.buyPrice);
        solar += direct + diverted;
        extraGrid += imported;
        exportUsed += direct;
      }

      if (divertedCharge > energyTolerance) {
        const deferredEnergy = divertedCharge * battery.chargeEfficiency;
        deficit += deferredEnergy;
        priorityDeficit += deferredEnergy;
      }

      if (battery && deficit > energyTolerance && row.canSelfConsume &&
          row.discharge <= forecastRoundingKw && row.chargeLimit !== null) {
        const room = Math.max(0, (row.chargeLimit - row.charge) * hours + divertedCharge);
        const refill = Math.min(surplus, room, deficit / battery.chargeEfficiency);
        deficit = Math.max(0, deficit - refill * battery.chargeEfficiency);
        exportUsed += refill;
      }

      priorityDeficit = Math.min(priorityDeficit, deficit);
      if (battery && to === row.end && row.charge > forecastRoundingKw &&
          row.chargeTarget !== null && row.endSoc >= row.chargeTarget - 0.05) {
        const allowedShortfall = Math.max(0, (baseEnd - row.chargeTarget + 0.05) * battery.capacity / 100);
        if (deficit - priorityDeficit > allowedShortfall) return null;
        if (deficit > allowedShortfall && !missedChargeTarget) {
          missedChargeTarget = { at: to, target: row.chargeTarget,
            soc: Math.max(0, baseEnd - deficit / battery.capacity * 100) };
        }
      }
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
    jobs, grid, solar, deficit, gridCost, exportImpact, afterRunGrid, afterRunCost, missedChargeTarget,
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

  jobs.sort((a, b) => (a.candidates.length || Infinity) - (b.candidates.length || Infinity) ||
    (a.deadline ?? horizon) - (b.deadline ?? horizon) || sourceOrder[a.source] - sourceOrder[b.source] ||
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

    if (!schedules.includes(empty)) schedules.push(empty);
  }
  return schedules[0];
}

function approvalId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function wallTime(timestamp, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

function clockMinutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function parseDeadline(value, timeZone, now) {
  const minutes = clockMinutes(value);
  if (minutes === null) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23",
  });
  const earliest = Math.floor(now / minute) * minute;
  const localMidnight = Math.floor(wallTime(earliest, formatter) / (24 * hour)) * 24 * hour;

  for (const day of [localMidnight, localMidnight + 24 * hour]) {
    const target = day + minutes * minute;
    const candidates = [-36, 0, 36].map(delta => target + delta * hour)
      .map(probe => target - (wallTime(probe, formatter) - probe))
      .filter(candidate => candidate >= earliest && wallTime(candidate, formatter) === target);
    if (candidates.length) return Math.min(...candidates);
  }
  return null;
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
        #editors { display: grid; gap: 12px; margin-top: 14px; }
        .editor {
          display: grid;
          grid-template-columns: minmax(0,1fr) minmax(60px,.5fr) minmax(60px,.6fr)
            minmax(95px,.75fr) minmax(110px,.9fr) 32px;
          align-items: end;
          gap: 8px;
          padding: 10px;
          border: 1px solid var(--planner-line);
          border-radius: 9px;
          background: color-mix(in srgb, var(--planner-muted) 7%, transparent);
        }
        .editor:focus-within { border-color: var(--planner-solar); }
        .workload-name { font-weight: 600; }
        .workload-name input { font-weight: 500; }
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
        .schedule-toggle, .automation-options { grid-column: 1 / -1; }
        .schedule-toggle { display: flex; gap: 6px; align-items: center; font-size: 12px; }
        .schedule-toggle input { width: auto; min-height: auto; margin: 0; accent-color: var(--primary-color); }
        .automation-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .repeat-days { grid-column: 1 / -1; min-width: 0; margin: 0; padding: 5px 8px 8px;
          border: 1px solid var(--planner-line); border-radius: 6px; color: var(--planner-muted); }
        .repeat-days legend { font-size: 11px; }
        .weekday-options { display: flex; flex-wrap: wrap; gap: 7px 12px; }
        #approval { margin-top: 10px; }
        #approval button { border-color: var(--primary-color, #03a9f4); font-weight: 600; }
        button:disabled { opacity: 0.55; cursor: default; }
        #approval-note, #action-status { margin-top: 5px; }
        #approved { border-top: 1px solid var(--planner-line); margin-top: 14px; padding-top: 12px; }
        #repeat-list, #approved-list, #history-list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 8px 0 0; }
        #occurrences, #history { margin-top: 12px; }
        .approved-run { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px;
          align-items: center; border: 1px solid var(--run-border, var(--planner-line));
          background: var(--run-fill, transparent); padding: 8px 10px; border-radius: 7px;
          overflow-wrap: anywhere; font-size: 13px; }
        .approved-run[data-status] {
          --run-fill: color-mix(in srgb, var(--run-color, transparent) 12%, transparent);
          --run-border: color-mix(in srgb, var(--run-color, var(--planner-line)) 75%, var(--primary-text-color, #242424) 25%);
        }
        .approved-run:is([data-status="scheduled"], [data-status="starting"], [data-status="running"], [data-status="stopping"]) {
          --run-color: #418454;
        }
        .approved-run[data-status="skipped"] { --run-color: #3b80bd; }
        .approved-run[data-status="repeat"] { --run-color: #7866ae; }
        .approved-run[data-status="delayed"] { --run-color: #a4792d; }
        .approved-run:is([data-status="failed"], [data-status="stop_failed"]) { --run-color: #b65764; }
        .approved-run small { display: block; }
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
          .schedule-toggle { grid-row: 4; }
          .automation-options { grid-row: 5; }
          .recommendation { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
          .recommendation .detail { grid-column: 1 / -1; }
        }
        @container (max-width: 410px) {
          .editor {
            grid-template-areas: "name name remove" "power duration duration"
              "deadline deadline deadline" "source source source";
          }
          .schedule-toggle { grid-row: 5; }
          .automation-options { grid-row: 6; grid-template-columns: 1fr; }
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
            <label class="workload-name">Workload<input data-field="name" type="text" maxlength="80" placeholder="Workload name"></label>
            <label class="workload-power">Power (kW)<input data-field="power" type="number" min="0.1" step="0.1" inputmode="decimal"></label>
            <label class="workload-duration">Duration (min)<input data-field="minutes" type="number" min="1" step="1" inputmode="numeric"></label>
            <label class="workload-deadline"><span class="deadline-label">Finish by (optional)</span><input data-field="deadline" type="time" step="60"></label>
            <label class="power-source">Power source<select data-field="source"></select></label>
            <button class="remove" type="button" aria-label="Remove workload" title="Remove workload">×</button>
            <label class="schedule-toggle"><input data-field="enabled" type="checkbox"> Enable schedule</label>
            <div class="automation-options" hidden>
              <label>Start automation<select data-field="start_automation" required></select></label>
              <label>Stop automation (optional)<select data-field="stop_automation"></select></label>
              <label>Timing<select data-field="timing">
                <option value="fixed">Fixed</option><option value="flexible">Flexible</option>
              </select></label>
              <label>If the forecast changes<select data-field="policy">
                <option value="defer">May be deferred</option><option value="must">Must run</option>
              </select></label>
              <label>Repeat<select data-field="cadence">
                <option value="once">Once-off</option><option value="repeated">Repeated</option>
              </select></label>
              <label class="repeat-start" hidden>Start at<input data-field="start_at" type="time" step="60"></label>
              <fieldset class="repeat-days" hidden>
                <legend>Run on</legend>
                <div class="weekday-options"></div>
              </fieldset>
            </div>
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
        <div id="approval" hidden>
          <button id="approve" type="button">Approve schedule</button>
          <p id="approval-note" class="muted"></p>
        </div>
        <p id="action-status" class="muted" role="status" hidden></p>
        <section id="approved" aria-labelledby="approved-title" hidden>
          <h3 id="approved-title">Approved workloads</h3>
          <div id="repeats" hidden>
            <h3>Repeated schedules</h3>
            <ul id="repeat-list"></ul>
          </div>
          <div id="occurrences" hidden>
            <h3>Scheduled and in-progress runs</h3>
            <ul id="approved-list"></ul>
          </div>
          <div id="history" hidden>
            <div class="schedule-heading">
              <h3>Recent workload runs</h3>
              <button id="clear-cancelled" type="button" hidden>Clear cancelled runs</button>
            </div>
            <ul id="history-list"></ul>
          </div>
        </section>
      </ha-card>`;
    this._get("add").addEventListener("click", () => this._addWorkload(false, true));
    this._get("approve").addEventListener("click", () => this._approve());
    this._get("clear-cancelled").addEventListener("click", event => this._clearCancelled(event.currentTarget));
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
    this._connectScheduler();
    if (!this._config) return;
    const { entity, capacityEntity } = this._config;
    if (!old || old.states?.[entity] !== hass.states?.[entity] ||
        old.states?.[capacityEntity] !== hass.states?.[capacityEntity] ||
        old.config?.time_zone !== hass.config?.time_zone || old.language !== hass.language ||
        old.user?.is_admin !== hass.user?.is_admin) this._render();
  }

  connectedCallback() {
    this._connectScheduler();
    this._clockTimer = setInterval(() => this._render(), minute);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._clockTimer);
    clearTimeout(this._editTimer);
    this._subscription?.unsubscribe?.();
    this._subscription = null;
    this._backend = null;
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
    const dayOptions = row.querySelector(".weekday-options");
    weekdays.forEach((day, index) => {
      const label = document.createElement("label");
      label.className = "schedule-toggle";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(index);
      checkbox.setAttribute("aria-label", day);
      label.append(checkbox, day.slice(0, 3));
      dayOptions.append(label);
    });
    for (const field of ["start_automation", "stop_automation"]) {
      input(field).addEventListener("focus", () => this._populateAutomations(row));
    }
    row.addEventListener("input", event => {
      if (event.target === input("enabled")) {
        row.querySelector(".automation-options").hidden = !input("enabled").checked;
        this._populateAutomations(row);
      }
      const repeated = input("enabled").checked && input("cadence").value === "repeated";
      row.querySelector(".repeat-days").hidden = !repeated;
      row.querySelector(".repeat-start").hidden = !repeated || input("timing").value !== "fixed";
      row.querySelector(".deadline-label").textContent = repeated ? "Finish by" : "Finish by (optional)";
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

  _automationExcluded(entityId) {
    const friendlyName = this._hass?.states?.[entityId]?.attributes?.friendly_name ?? "";
    const name = friendlyName.toLowerCase().match(/[a-z0-9]+/g)?.join("_") ?? "";
    const key = entityId.slice("automation.".length).replace(/_\d+$/, "");
    const exclusions = this._backend?.automation_exclusions;
    return !exclusions || exclusions.includes(key) || exclusions.includes(name);
  }

  _automationSelectable(entityId) {
    return entityId.startsWith("automation.") && !this._automationExcluded(entityId) &&
      ["on", "off"].includes(this._hass?.states?.[entityId]?.state);
  }

  _populateAutomations(row) {
    const states = this._hass?.states ?? {};
    const choices = Object.values(states)
      .filter(state => this._automationSelectable(state.entity_id))
      .map(state => [state.entity_id, state.attributes.friendly_name || state.entity_id])
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
    for (const field of ["start_automation", "stop_automation"]) {
      const select = row.querySelector(`[data-field="${field}"]`);
      const previous = select.value;
      select.replaceChildren(new Option(field === "start_automation" ? "Select an automation" : "None", ""));
      for (const [id, name] of choices) select.add(new Option(name, id));
      if (previous && !this._automationExcluded(previous) && !choices.some(([id]) => id === previous)) {
        select.add(new Option(previous + " (unavailable)", previous));
      }
      select.value = this._automationExcluded(previous) ? "" : previous;
    }
  }

  _connectScheduler() {
    const connection = this._hass?.connection;
    if (!this.isConnected || !connection || this._subscription?.connection === connection) return;
    this._subscription?.unsubscribe?.();
    this._backend = null;
    const subscription = { connection };
    this._subscription = subscription;
    connection.subscribeMessage(data => {
      if (this._subscription !== subscription) return;
      const filtersLoaded = !this._backend?.automation_exclusions && data.automation_exclusions;
      this._backend = data;
      if (filtersLoaded) {
        for (const row of this._get("editors").children) {
          if (row.querySelector('[data-field="enabled"]').checked) this._populateAutomations(row);
        }
      }
      this._render();
    }, { type: schedulerDomain + "/subscribe" }).then(unsubscribe => {
      if (this._subscription === subscription) subscription.unsubscribe = unsubscribe;
      else unsubscribe();
    }).catch(() => {
      if (this._subscription !== subscription) return;
      subscription.failed = true;
      this._render();
    });
  }

  _readWorkloads(timeZone, now, earliest) {
    return Array.from(this._get("editors").children, (row, index) => {
      const value = field => row.querySelector(`[data-field="${field}"]`).value;
      const power = finite(value("power"));
      const minutes = finite(value("minutes"));
      const deadlineValue = value("deadline");
      const enabled = row.querySelector('[data-field="enabled"]').checked;
      const timing = value("timing");
      const repeated = enabled && value("cadence") === "repeated";
      const repeat = repeated ? {
        days: Array.from(row.querySelectorAll(".weekday-options input:checked"), input => Number(input.value)),
        finish_by: deadlineValue,
        ...(timing === "fixed" ? { start_at: value("start_at") } : {}),
      } : null;
      const deadline = !repeated && deadlineValue ? parseDeadline(deadlineValue, timeZone, now) : null;
      let problem = "";
      if (!(power >= 0.1) || !Number.isSafeInteger(minutes) || minutes < 1) {
        problem = "Enter a power and a whole-minute duration.";
      } else if (repeat) {
        const finish = clockMinutes(repeat.finish_by);
        const start = timing === "fixed" ? clockMinutes(repeat.start_at) : 0;
        if (!repeat.days.length) problem = "Select at least one weekday.";
        else if (finish === null) problem = "Choose a finish-by time.";
        else if (start === null) problem = "Choose a fixed start time.";
        else if (finish - start < minutes) problem = "The run must fit within the selected day.";
      } else if (deadlineValue && deadline === null) {
        problem = "Choose a valid finish time in " + (timeZone ?? "your local timezone") + ".";
      } else if (deadline !== null && deadline < earliest + minutes * minute) {
        problem = "The workload cannot finish by this deadline.";
      }
      return {
        id: Number(row.dataset.id), name: value("name").trim() || "Workload " + (index + 1),
        power, duration: minutes * minute, deadline,
        source: value("source"),
        enabled, timing, repeat,
        policy: value("policy"),
        start_automation: value("start_automation"),
        stop_automation: value("stop_automation"),
        problem,
      };
    });
  }

  _render() {
    if (!this._config) return;
    const { entity, capacityEntity, capacity, maxAge, chargeEfficiency, dischargeEfficiency } = this._config;
    this._renderApproved();
    this._approval = null;
    const state = this._hass?.states?.[entity];
    const plan = state?.attributes?.energy_plan;
    const now = Date.now();
    const generated = Date.parse(plan?.meta?.generated_at ?? plan?.summary?.ts);
    const timeZone = this._hass?.config?.time_zone || undefined;
    const showStatus = message => {
      const workloads = this._readWorkloads(timeZone, now, now);
      this._renderApproval(workloads, { jobs: [] }, null, now);
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
    const workloads = this._readWorkloads(timeZone, now, intervals[0].from);
    if (!workloads.length) {
      showStatus("Add a workload to see suggested times.");
      return;
    }
    const siteCapacity = capacity || nonnegative(this._hass.states?.[capacityEntity]?.state);
    const battery = siteCapacity && intervals.every(row =>
      [row.startSoc, row.endSoc, row.floor].every(value => value !== null && value <= 100)) ?
      { capacity: siteCapacity, chargeEfficiency, dischargeEfficiency } : null;
    const schedule = recommend(intervals, workloads.filter(row => !row.problem && !row.repeat), battery);
    this._renderSchedule(workloads, schedule, intervals, battery, timeZone, now);
    this._renderApproval(workloads, schedule, intervals.at(-1).end, now);
    this._get("status").hidden = true;
    this._get("schedule").hidden = false;
  }

  _renderApproval(workloads, schedule, horizon, now) {
    const enabled = workloads.filter(row => row.enabled);
    this._get("approval").hidden = !enabled.length;
    if (!enabled.length) return;
    const backend = this._backend;
    const { entity, capacityEntity, capacity, maxAge, chargeEfficiency, dischargeEfficiency } = this._config;
    const proposed = new Map(schedule.jobs.map(row => [row.id, row.start]));
    const issues = [];
    if (!backend) {
      issues.push(this._subscription?.failed ? "Install or restart the Home Assistant workload scheduler." :
        "Connecting to the Home Assistant workload scheduler.");
    } else {
      if (!backend.automation_exclusions) issues.push("Update the Home Assistant workload scheduler.");
      const config = backend.config;
      if (config.entity !== entity || config.battery_capacity_entity !== capacityEntity ||
          (config.battery_capacity_kwh ?? null) !== (capacity || null) ||
          config.max_plan_age_minutes * minute !== maxAge ||
          config.battery_charge_efficiency !== chargeEfficiency || config.battery_discharge_efficiency !== dischargeEfficiency) {
        issues.push("The card and scheduler must use matching forecast settings.");
      }
    }
    if (!this._hass?.user?.is_admin) issues.push("A Home Assistant administrator must approve runs.");

    const jobs = [];
    for (const row of enabled) {
      const start = proposed.get(row.id) ?? null;
      const deadline = row.deadline ?? horizon;
      const label = row.name + " · ";
      if (row.problem) issues.push(label + row.problem);
      else if (!this._automationSelectable(row.start_automation)) {
        issues.push(label + "Choose a start automation.");
      } else if (row.stop_automation && (row.stop_automation === row.start_automation ||
          !this._automationSelectable(row.stop_automation))) {
        issues.push(label + "Choose a different available stop automation.");
      } else if (row.duration > 24 * hour || row.power > 1000) {
        issues.push(label + "Use a duration up to 24 hours and power up to 1,000 kW.");
      } else if (row.repeat) {
        if (!Array.isArray(backend?.repeats)) issues.push(label + "Update the Home Assistant scheduler to enable repeated runs.");
        else jobs.push({ rowId: row.id, data: {
          name: row.name, power: row.power, duration: row.duration / 1000, source: row.source,
          timing: row.timing, policy: row.policy, repeat: row.repeat,
          start_automation: row.start_automation, stop_automation: row.stop_automation,
        } });
      } else if (horizon === null) {
        issues.push(label + "Wait for an up-to-date forecast before approving a once-off run.");
      } else if (row.timing === "flexible" && row.policy === "must" && row.deadline === null) {
        issues.push(label + "Choose a finish time for Must run.");
      } else if (deadline - row.duration <= now || deadline - now > 48 * hour) {
        issues.push(label + "Choose a finish time within 48 hours that leaves enough time to run.");
      } else if (start === null && row.timing === "fixed") {
        issues.push(label + "A suitable forecast window is required for a Fixed run.");
      } else if (start === null && row.deadline === null) {
        issues.push(label + "Choose a finish time to approve a run without a suggested window.");
      } else if (start !== null && Math.floor(start / 1000) * 1000 <= now) {
        issues.push(label + "The suggested start has passed. Review the refreshed forecast.");
      } else {
        jobs.push({
          rowId: row.id,
          data: {
            name: row.name, power: row.power, duration: row.duration / 1000,
            source: row.source, timing: row.timing, policy: row.policy, start: start === null ? null : Math.floor(start / 1000),
            deadline: Math.floor(deadline / 1000), start_automation: row.start_automation, stop_automation: row.stop_automation,
          },
        });
      }
    }
    if (jobs.length > 12) issues.push("Approve up to 12 workloads at a time.");
    if (!issues.length) this._approval = jobs;
    this._get("approve").disabled = Boolean(issues.length) || Boolean(this._saving);
    this._get("approve").textContent = enabled.some(row => row.repeat) ? "Approve schedule" :
      enabled.length === 1 ? "Approve run" : "Approve " + enabled.length + " runs";
    this._get("approval-note").textContent = issues.join(" ") || (enabled.some(row => row.policy === "must") ?
      "Must run can use grid energy. A Flexible run may move up to its latest start." :
      "Home Assistant will run this schedule when the dashboard is closed.");
  }

  _actionStatus(message) {
    this._get("action-status").textContent = message;
    this._get("action-status").hidden = !message;
  }

  async _approve() {
    const shown = JSON.stringify(this._approval);
    this._render();
    if (!this._approval || this._saving) return;
    if (shown !== JSON.stringify(this._approval)) {
      this._actionStatus("The suggested schedule changed. Review the updated times before approving.");
      return;
    }
    const drafts = this._approval.map(({ rowId, data }) => {
      const row = this._get("editors").querySelector(`[data-id="${rowId}"]`);
      const signature = JSON.stringify(data);
      if (row.approval?.signature !== signature) row.approval = { signature, id: approvalId() };
      return { row, data: { ...data, id: row.approval.id } };
    });
    this._saving = true;
    this._actionStatus("Saving the approved schedule…");
    this._render();
    try {
      await this._hass.callWS({ type: schedulerDomain + "/approve", jobs: drafts.map(draft => draft.data) });
      for (const draft of drafts) draft.row.remove();
      this._actionStatus(drafts.some(draft => draft.data.repeat) ? "Schedule approved." :
        drafts.length === 1 ? "Run approved." : drafts.length + " runs approved.");
    } catch (error) {
      this._actionStatus(error?.message || "Could not save the schedule.");
    } finally {
      this._saving = false;
      this._render();
    }
  }

  async _changeRun(action, job, message) {
    try {
      await this._hass.callWS({ type: schedulerDomain + "/" + action, job_id: job.id });
      this._actionStatus(message);
    } catch (error) {
      this._actionStatus(error?.message || "Could not update the run.");
    }
  }

  async _clearCancelled(button) {
    button.disabled = true;
    try {
      const { count } = await this._hass.callWS({ type: schedulerDomain + "/clear_cancelled" });
      this._actionStatus(count === 1 ? "Cleared 1 cancelled run." : "Cleared " + count + " cancelled runs.");
    } catch (error) {
      this._actionStatus(error?.message || "Could not clear cancelled runs.");
    } finally {
      button.disabled = false;
    }
  }

  _runButton(label, action, job, message, name = job.name) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", label + " " + name);
    button.addEventListener("click", () => {
      button.disabled = true;
      this._changeRun(action, job, message).finally(() => { button.disabled = false; });
    });
    return button;
  }

  _renderApproved() {
    const jobs = this._backend?.jobs ?? [];
    const repeats = this._backend?.repeats ?? [];
    this._get("approved").hidden = !jobs.length && !repeats.length;
    this._get("repeats").hidden = !repeats.length;
    const admin = this._hass?.user?.is_admin;
    const current = new Set(["scheduled", "delayed", "starting", "running", "stopping", "stop_failed"]);
    this._get("occurrences").hidden = !jobs.some(job => current.has(job.status));
    this._get("history").hidden = !jobs.some(job => !current.has(job.status));
    this._get("clear-cancelled").hidden = !admin || !this._backend?.automation_exclusions ||
      !jobs.some(job => job.status === "cancelled");
    const repeatList = this._get("repeat-list");
    repeatList.replaceChildren();
    for (const entry of repeats) {
      const rule = entry.approval.repeat;
      const item = document.createElement("li");
      item.className = "approved-run";
      item.dataset.status = "repeat";
      const summary = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = entry.approval.name;
      const detail = document.createElement("small");
      const days = rule.days.length === 7 ? "Every day" : [...rule.days].sort((a, b) => a - b)
        .map(day => weekdays[day].slice(0, 3)).join(", ");
      detail.textContent = days + " · " + (rule.start_at ? "Start " + rule.start_at + " · " : "") +
        "Finish by " + rule.finish_by + " · " + entry.approval.duration / 60 + " min";
      summary.append(title, detail);
      item.append(summary);
      if (admin) {
        item.append(this._runButton("Cancel repeat", "cancel_repeat", entry, "Repeated schedule cancelled.", entry.approval.name));
      }
      repeatList.append(item);
    }
    const list = this._get("approved-list");
    const history = this._get("history-list");
    list.replaceChildren();
    history.replaceChildren();
    if (!jobs.length) return;
    const labels = {
      scheduled: "Scheduled", delayed: "Delayed", starting: "Starting", running: "Running",
      stopping: "Stopping", completed: "Completed", skipped: "Skipped", failed: "Failed",
      stop_failed: "Stop failed", cancelled: "Cancelled",
    };
    const formatter = new Intl.DateTimeFormat(this._hass.language || undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: this._hass.config?.time_zone || undefined,
    });
    const dateOnly = new Intl.DateTimeFormat(this._hass.language || undefined, {
      weekday: "short", month: "short", day: "numeric", timeZone: this._hass.config?.time_zone || undefined,
    });
    const now = Date.now() / 1000;
    const sorted = [...jobs].sort((a, b) => Number(current.has(b.status)) - Number(current.has(a.status)) ||
      (current.has(a.status) ? (a.actual_start ?? a.start ?? a.deadline) - (b.actual_start ?? b.start ?? b.deadline) :
        b.created - a.created));
    for (const job of sorted) {
      const item = document.createElement("li");
      item.className = "approved-run";
      const summary = document.createElement("div");
      item.dataset.status = job.status;
      const title = document.createElement("strong");
      title.textContent = job.name + " · " + (labels[job.status] ?? job.status);
      const time = document.createElement("small");
      const when = job.actual_start ?? job.start;
      time.textContent = when === null ? (job.run_date ? dateOnly.format(job.deadline * 1000) : "") :
        formatter.format(when * 1000);
      if (job.stop_at && ["starting", "running", "stopping"].includes(job.status)) {
        time.textContent += " · " + (job.stop_automation ? "Stop " : "Estimated end ") + formatter.format(job.stop_at * 1000);
      }
      const note = document.createElement("small");
      note.textContent = job.note;
      summary.append(title, time, note);
      item.append(summary);
      if (admin && ["scheduled", "delayed", "stop_failed"].includes(job.status)) {
        const action = job.status === "stop_failed" ? "retry_stop" : "cancel";
        const label = action === "retry_stop" ? "Retry stop" : job.repeat_id ? "Skip today" : "Cancel";
        const message = action === "retry_stop" ? "Stop requested." : job.repeat_id ? "Today's run skipped." : "Run cancelled.";
        item.append(this._runButton(label, action, job, message));
      } else if (admin && job.status === "skipped" && job.unskip_until > now) {
        item.append(this._runButton("Unskip today", "unskip", job, "Today's run restored."));
      }
      (current.has(job.status) ? list : history).append(item);
    }
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
        const mix = [[row.solar, "surplus solar"], [row.divertedSolar, "solar diverted from charging"],
          [row.battery, "battery"], [row.grid, "grid"]]
          .filter(([energy]) => energy > energyTolerance)
          .map(([energy, source]) => kwh(energy) + " " + source);
        detail.textContent = mix.join(" · ");
        const amount = document.createElement("small");
        amount.textContent = "During run · " + cost(row.cost);
        detail.append(amount);
        item.append(time);
      } else {
        item.dataset.source = "unplaced";
        const fallback = row.enabled && row.timing === "flexible" && row.policy === "must" && row.deadline !== null;
        const latest = fallback ? row.deadline - row.duration : null;
        detail.textContent = row.problem || (row.repeat ? "Home Assistant schedules each selected day after approval." : fallback ? "No suitable window found. If approved, latest start is " +
          startLabel(latest) + ", " + clock.format(latest) + "." : row.duration > last.end - intervals[0].from ?
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
    if (schedule.missedChargeTarget) {
      const { at, target, soc } = schedule.missedChargeTarget;
      notes.push("Battery forecast at " + startLabel(at) + ", " + clock.format(at) + " is " +
        number.format(soc) + "% vs a planned " + number.format(target) + "% charge target.");
    }
    if (schedule.afterRunGrid >= 0.005) {
      notes.push(kwh(schedule.afterRunGrid) + " extra grid use after the last run (" + cost(schedule.afterRunCost) + ").");
    }
    if (battery && schedule.deficit >= 0.005) {
      const endSoc = Math.max(0, last.endSoc - schedule.deficit / battery.capacity * 100);
      notes.push("Battery at forecast end " + number.format(endSoc) + "% vs " + number.format(last.endSoc) + "% planned.");
      if (endSoc <= last.minSoc + 0.1) notes.push("Further grid use beyond the forecast is possible.");
    }
    if (!battery && workloads.some(row => row.source !== "solar")) {
      notes.push("Battery discharge and charging diversion require capacity and state-of-charge forecast data.");
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
    description: "Plan and schedule workloads using the Energy Manager forecast.",
  });
}
