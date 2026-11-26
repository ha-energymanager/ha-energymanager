const cardType = "em-flexible-load-scheduler-card";
const schedulerDomain = "em_flexible_load_scheduler";
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
const policies = {
  defer: "Skip if the forecast can’t support it",
  must: "Must run",
  search: "Keep looking on future days",
};
const sourceOrder = { solar: 0, priority: 1, battery: 2, grid: 3 };
const beamWidth = 12;
const forecastRoundingKw = 0.005;
const mustRun = job => job.policy === "must" && job.enabled !== false;
const overrideEnergy = job => !mustRun(job) || job.source === "grid" ? 0 :
  (job.source === "solar" || job.source === "priority" ? job.battery : 0) +
  (job.source === "solar" || job.source === "battery" ? job.divertedSolar : 0) + job.grid;
const unverifiedWarning = "Must run — the forecast does not cover the entire run. Battery or grid energy may be needed; the full energy mix and power limits cannot yet be verified.";
const blockedWarning = "Must run — forecast power limits, battery reserve or other scheduled loads prevent a verified run before this deadline. Change the power, duration or finish time.";

function preferenceWarning(job, number) {
  if (job.unverified) return unverifiedWarning;
  if (!(overrideEnergy(job) > energyTolerance)) return "";
  const battery = ["solar", "priority"].includes(job.source) ? job.battery : 0;
  const diverted = ["solar", "battery"].includes(job.source) ? job.divertedSolar : 0;
  const parts = [[diverted, "solar diverted from charging"], [battery, "battery"], [job.grid, "grid"]]
    .filter(([value]) => value > energyTolerance)
    .map(([value, name]) => (value < 0.01 ? "less than 0.01" : number.format(value)) + " kWh " + name);
  return "Must run — power source preference overridden. Estimated energy outside the selected preference: " +
    parts.join(" and ") + ".";
}

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

function evaluateSchedule(intervals, placements, battery, after = null) {
  const jobs = placements.map(window => ({
    ...window, solar: 0, divertedSolar: 0, battery: 0, grid: 0, cost: 0,
  }));
  
  jobs.sort((a, b) => Number(Boolean(b.reserved)) - Number(Boolean(a.reserved)) ||
    sourceOrder[a.source] - sourceOrder[b.source] || Number(mustRun(a)) - Number(mustRun(b)) ||
    String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  let deficit = 0;
  let protectedDeficit = 0;
  let missedChargeTarget = null;
  let grid = 0;
  let solar = 0;
  let gridCost = 0;
  let exportImpact = 0;
  let afterRunGrid = 0;
  let afterRunCost = 0;
  const lastFinish = after ?? Math.max(...jobs.filter(job => !job.reserved).map(job => job.end));

  for (const row of intervals) {
    const intervalJobs = jobs.filter(job => job.start < row.end && job.end > row.from);
    if (!intervalJobs.length && deficit <= energyTolerance) continue;
    const cuts = new Set([row.from, row.end]);
    for (const job of intervalJobs) {
      cuts.add(Math.max(row.from, job.start));
      cuts.add(Math.min(row.end, job.end));
    }
    if (lastFinish > row.from && lastFinish < row.end) cuts.add(lastFinish);
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

      const allocations = [];

      for (const job of intervalJobs) {
        if (job.start >= to || job.end <= from) continue;
        const demand = job.power * hours;
        const direct = Math.min(surplus, demand);
        surplus -= direct;
        const canDivert = job.source === "priority" || (job.reserved && mustRun(job) && ["solar", "battery"].includes(job.source));
        const diverted = canDivert ? Math.min(flexibleCharge, demand - direct) : 0;
        flexibleCharge -= diverted;
        divertedCharge += diverted;
        const canUseBattery = job.reserved || job.source === "battery" || job.source === "grid";
        const stored = canUseBattery ? Math.min(discharge, demand - direct - diverted) : 0;
        discharge -= stored;
        const remaining = Math.max(0, demand - direct - diverted - stored);
        if (remaining > energyTolerance && !job.reserved && job.source !== "grid" && !mustRun(job)) return null;
        allocations.push({ job, direct, diverted, stored, remaining });
      }

      for (const allocation of allocations) {
        const { job, direct } = allocation;
        let { diverted, stored, remaining } = allocation;
        if (mustRun(job) && !job.reserved) {
          if (["solar", "battery"].includes(job.source)) {
            const extraDiverted = Math.min(flexibleCharge, remaining);
            diverted += extraDiverted;
            flexibleCharge -= extraDiverted;
            divertedCharge += extraDiverted;
            remaining -= extraDiverted;
          }
          if (["solar", "priority"].includes(job.source)) {
            const extraStored = Math.min(discharge, remaining);
            stored += extraStored;
            discharge -= extraStored;
            remaining -= extraStored;
          }
        }
        const imported = Math.max(0, remaining);
        if (stored > energyTolerance) {
          const used = stored / battery.dischargeEfficiency;
          deficit += used;
          if (mustRun(job)) protectedDeficit += used;
        }
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
        protectedDeficit += deferredEnergy;
      }

      if (battery && deficit > energyTolerance && row.canSelfConsume &&
          row.discharge <= forecastRoundingKw && row.chargeLimit !== null) {
        const room = Math.max(0, (row.chargeLimit - row.charge) * hours + divertedCharge);
        const refill = Math.min(surplus, room, deficit / battery.chargeEfficiency);
        deficit = Math.max(0, deficit - refill * battery.chargeEfficiency);
        exportUsed += refill;
      }

      protectedDeficit = Math.min(protectedDeficit, deficit);
      if (battery && to === row.end && row.charge > forecastRoundingKw &&
          row.chargeTarget !== null && row.endSoc >= row.chargeTarget - 0.05) {
        const allowedShortfall = Math.max(0, (baseEnd - row.chargeTarget + 0.05) * battery.capacity / 100);
        if (deficit - protectedDeficit > allowedShortfall) return null;
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
  const proposed = jobs.filter(job => !job.reserved);
  const overrides = proposed.map(overrideEnergy);
  return {
    jobs: proposed, grid, solar, deficit, gridCost, exportImpact, afterRunGrid, afterRunCost, missedChargeTarget,
    overrideCount: overrides.filter(value => value > energyTolerance).length,
    overrideKwh: overrides.reduce((total, value) => total + value, 0),
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
  const mustDifference = b.jobs.filter(mustRun).length - a.jobs.filter(mustRun).length;
  if (mustDifference) return mustDifference;
  if (b.jobs.length !== a.jobs.length) return b.jobs.length - a.jobs.length;
  for (const difference of [(a.overrideCount ?? 0) - (b.overrideCount ?? 0),
      (a.overrideKwh ?? 0) - (b.overrideKwh ?? 0)]) {
    if (Math.abs(difference) > energyTolerance) return difference;
  }
  if ((a.totalCost === null) !== (b.totalCost === null)) return a.totalCost === null ? 1 : -1;
  for (const difference of [
    (a.totalCost ?? 0) - (b.totalCost ?? 0), a.grid - b.grid,
    a.deficit - b.deficit, b.solar - a.solar,
  ]) {
    if (Math.abs(difference) > energyTolerance) return difference;
  }
  return a.finish - b.finish || a.starts - b.starts;
}

function automationClash(window, placements) {
  const targets = [window.start_automation, window.stop_automation].filter(Boolean);
  return placements.some(job => window.start < job.end && window.end > job.start &&
    targets.some(target => target === job.start_automation || target === job.stop_automation));
}

function approvedWindows(jobs, now) {
  return jobs.filter(job => job.start != null &&
    ["scheduled", "delayed", "starting", "running", "stopping", "stop_failed"].includes(job.status))
    .map(job => {
      const start = (job.actual_start ?? job.start) * 1000;
      let end = job.stop_at == null ? start + job.duration * 1000 : job.stop_at * 1000;
      if (["stopping", "stop_failed"].includes(job.status) || (job.status === "running" && end <= now)) {
        end = Math.max(end, now + minute);
      }
      return { ...job, start, end, source: job.source === "priority" || mustRun(job) ? job.source : "grid", reserved: true };
    }).filter(job => job.end > now);
}

function recommend(intervals, loads, battery, reserved) {
  const baseline = evaluateSchedule(intervals, reserved, battery);
  const empty = { jobs: [], placements: [], finish: 0, starts: 0 };
  if (!baseline) return empty;
  const evaluate = placements => automationClash(placements.at(-1), [...reserved, ...placements.slice(0, -1)]) ?
    null : evaluateSchedule(intervals, [...reserved, ...placements], battery);
  const horizon = intervals.at(-1).end;
  const jobs = loads.map(job => {
    const latest = Math.min(job.deadline ?? horizon, horizon) - job.duration;
    const candidates = [...new Set([...possibleStarts(intervals, job, latest),
      ...possibleStarts(intervals, job, latest, reserved)])]
      .map(start => ({ ...job, start, end: start + job.duration }))
      .map(window => ({ window, result: evaluate([window]) }))
      .filter(candidate => candidate.result);
    if (mustRun(job) && !candidates.length) {
      for (let start = Math.ceil(intervals[0].from / minute) * minute; start <= latest; start += minute) {
        const window = { ...job, start, end: start + job.duration };
        const result = evaluate([window]);
        if (result) candidates.push({ window, result });
      }
    }
    return { ...job, latest, candidates };
  });

  jobs.sort((a, b) => Number(mustRun(b)) - Number(mustRun(a)) ||
    (a.candidates.length || Infinity) - (b.candidates.length || Infinity) ||
    (a.deadline ?? horizon) - (b.deadline ?? horizon) || sourceOrder[a.source] - sourceOrder[b.source] ||
    b.duration - a.duration || a.id - b.id);

  Object.assign(empty, baseline);
  let schedules = [empty];
  for (const job of jobs) {
    const { candidates, latest, ...load } = job;
    const known = new Map(candidates.map(({ window, result }) => [window.start, result]));
    const alternatives = [...schedules];
    for (const schedule of schedules) {
      const starts = schedule.placements.length ?
        new Set([...known.keys(), ...possibleStarts(intervals, load, latest, schedule.placements)]) : known.keys();
      for (const start of starts) {
        const window = { ...load, start, end: start + load.duration };
        const placements = [...schedule.placements, window];
        const result = schedule.placements.length ? evaluate(placements) : known.get(start);
        if (result) alternatives.push({ ...result, placements, finish: Math.max(schedule.finish, window.end),
          starts: schedule.starts + start });
      }
    }
    alternatives.sort(compareSchedules);
    schedules = alternatives.slice(0, beamWidth);

    if (!schedules.includes(empty)) schedules.push(empty);
  }
  let best = schedules[0];
  const placed = [...best.placements];
  const placedIds = new Set(placed.map(job => job.id));
  for (const job of [...loads].sort((a, b) => (a.deadline ?? horizon) - (b.deadline ?? horizon) || a.id - b.id)) {
    if (!mustRun(job) || placedIds.has(job.id) || job.deadline === null || job.deadline <= horizon) continue;
    const latest = job.deadline - job.duration;
    const earliest = intervals[0].from;
    const windows = [...reserved, ...placed];
    const starts = new Set([latest, horizon, earliest]);
    for (const row of intervals) {
      starts.add(row.from);
      starts.add(row.end - job.duration);
    }
    for (const other of windows) {
      starts.add(other.start - job.duration);
      starts.add(other.end);
    }
    for (const start of [...starts].sort((a, b) => b - a)) {
      if (start < earliest || start > latest || start + job.duration <= horizon) continue;
      const window = { ...job, start, end: start + job.duration, unverified: true };
      if (automationClash(window, windows)) continue;
      const result = evaluateSchedule(intervals, [...windows, window], battery);
      if (!result) continue;
      placed.push(window);
      best = { ...result, placements: [...placed], finish: Math.max(best.finish, window.end), starts: best.starts + start };
      break;
    }
  }
  if (!best.jobs.length || !reserved.length) return best;
  const baselineAfterRun = evaluateSchedule(intervals, reserved, battery, best.finish);
  for (const key of ["totalCost", "gridCost", "exportImpact", "afterRunGrid", "afterRunCost"]) {
    const before = (key.startsWith("afterRun") ? baselineAfterRun : baseline)?.[key] ?? null;
    best[key] = best[key] === null || before === null ? null : best[key] - before;
  }
  best.baselineDeficit = baseline.deficit;
  if (baseline.missedChargeTarget && best.missedChargeTarget?.at === baseline.missedChargeTarget.at &&
      best.missedChargeTarget.soc >= baseline.missedChargeTarget.soc - 0.05) best.missedChargeTarget = null;
  return best;
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

function localDateTime(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23",
  }).formatToParts(timestamp);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return value.year + "-" + value.month + "-" + value.day + "T" + value.hour + ":" + value.minute;
}

function parseDeadline(value, timeZone, now, date = null) {
  const minutes = clockMinutes(value);
  if (minutes === null) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23",
  });
  const earliest = Math.floor(now / minute) * minute;
  const localMidnight = Math.floor(wallTime(earliest, formatter) / (24 * hour)) * 24 * hour;

  const days = date === null ? [localMidnight, localMidnight + 24 * hour] : [Date.parse(date + "T00:00:00Z")];
  for (const day of days) {
    const target = day + minutes * minute;
    const candidates = [-36, 0, 36].map(delta => target + delta * hour)
      .map(probe => target - (wallTime(probe, formatter) - probe))
      .filter(candidate => candidate >= earliest && wallTime(candidate, formatter) === target);
    if (candidates.length) return Math.min(...candidates);
  }
  return null;
}

class EmFlexibleLoadSchedulerCard extends HTMLElement {
  constructor() {
    super();
    this._nextId = 1;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; color-scheme: light dark; }
        :host([data-theme="light"]) { color-scheme: light; }
        :host([data-theme="dark"]) { color-scheme: dark; }
        [hidden] { display: none !important; }
        ha-card {
          --planner-text: var(--primary-text-color, light-dark(#242424, #f1f3f5));
          --planner-card-bg: var(--ha-card-background, var(--card-background-color, light-dark(#ffffff, #1c1c1c)));
          --planner-muted: light-dark(var(--secondary-text-color, #565e67),
            color-mix(in srgb, var(--planner-text) 74%, var(--planner-card-bg)));
          --planner-line: light-dark(var(--divider-color, #dddddd), #4b5157);
          --planner-control-line: light-dark(var(--planner-line), #879099);
          --planner-control-bg: light-dark(var(--secondary-background-color, #f4f5f6),
            color-mix(in srgb, var(--planner-text) 11%, var(--planner-card-bg)));
          --planner-approved-bg: light-dark(#f2f3f5,
            color-mix(in srgb, var(--planner-text) 7%, var(--planner-card-bg)));
          --planner-solar: var(--energy-solar-color, #e8a21c);
          --planner-grid: var(--info-color, #478fe0);
          padding: 16px;
          container-type: inline-size;
          color: var(--planner-text);
        }
        * { box-sizing: border-box; }
        h2, h3, p { margin: 0; }
        h2 { font-size: 19px; }
        h3 { font-size: 15px; }
        header { display: flex; align-items: flex-start; gap: 9px; }
        header ha-icon { color: var(--primary-color, #3b80bd); --mdc-icon-size: 22px; }
        header p, .muted, small { color: var(--planner-muted); font-size: 13px; }
        header p { margin-top: 2px; }
        #favourites { margin-top: 14px; border: 1px solid var(--planner-line); border-radius: 8px; padding: 10px; }
        #favourites summary { cursor: pointer; font-weight: 600; }
        #favourite-count { float: right; font-weight: 400; }
        #favourite-list { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 6px; }
        .favourite-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
          padding: 8px; border: 1px solid var(--planner-line); border-radius: 7px; }
        .favourite-summary { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
        .favourite-summary small { display: block; }
        .favourite-actions, .favourite-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
        .favourite-actions button, .favourite-toolbar button { font-size: 12px; }
        .favourite-toolbar { grid-column: 1 / -1; }
        .favourite-toolbar input { flex: 1 1 140px; width: auto; }
        #favourite-status { margin-top: 6px; }
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
        .load-name { font-weight: 600; }
        .load-name input { font-weight: 500; }
        label { display: grid; min-width: 0; gap: 4px; font-size: 12px; font-weight: 500; color: var(--planner-muted); }
        input, select, button {
          min-height: 34px;
          min-width: 0;
          border: 1px solid var(--planner-control-line);
          border-radius: 6px;
          color: var(--planner-text);
          font: inherit;
        }
        input, select {
          width: 100%;
          padding: 4px 6px;
          background: var(--planner-control-bg);
          font-size: 13px;
          color-scheme: inherit;
        }
        input::placeholder { color: var(--planner-muted); opacity: 1; }
        button { background: light-dark(transparent, var(--planner-control-bg)); padding: 4px 10px; cursor: pointer; }
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
        .repeat-days legend { font-size: 12px; }
        .weekday-options { display: flex; flex-wrap: wrap; gap: 7px 12px; }
        #load-guide { margin-top: 16px; padding: 10px 12px; border: 1px solid var(--planner-line);
          border-radius: 8px; font-size: 13px; line-height: 1.5; }
        #load-guide summary { cursor: pointer; font-weight: 600; }
        #load-guide ol, #load-guide ul { padding-inline-start: 20px; }
        #load-guide li + li { margin-top: 4px; }
        #load-guide h4 { margin: 12px 0 0; font-size: inherit; }
        #load-guide p { margin-top: 8px; }
        #history-actions { display: flex; flex-wrap: wrap; gap: 6px; }
        #edit-impact { margin-top: 12px; }
        #edit-impact table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 13px; }
        #edit-impact th, #edit-impact td { padding: 6px; text-align: start; border-bottom: 1px solid var(--planner-line);
          vertical-align: top; overflow-wrap: anywhere; }
        #edit-impact thead th { background: var(--planner-approved-bg); }
        #edit-impact td[data-changed] {
          background: color-mix(in srgb, var(--primary-color, #3b80bd) 13%, var(--planner-card-bg));
          font-weight: 600;
        }
        #edit-impact-note, #edit-impact-delta { margin-top: 6px; }
        #edit-impact-note[data-fallback] {
          padding: 8px 10px;
          border-inline-start: 3px solid var(--planner-solar);
          background: color-mix(in srgb, var(--planner-solar) 11%, var(--planner-card-bg));
          color: var(--planner-text);
        }
        #approval { margin-top: 10px; }
        #approval button { border-color: var(--primary-color, #03a9f4); font-weight: 600; }
        button:disabled { opacity: 0.55; cursor: default; }
        #approval-note, #action-status { margin-top: 5px; }
        #approved { margin-top: 18px; padding: 14px; background: var(--planner-approved-bg);
          border: 1px solid var(--planner-line); border-radius: 10px; }
        #approved-title { font-size: 16px; margin-bottom: 10px; }
        #repeat-list, #approved-list, #history-list { display: grid; gap: 6px; list-style: none; padding: 0; margin: 8px 0 0; }
        #occurrences, #history { margin-top: 12px; }
        .approved-run { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px;
          align-items: center; border: 1px solid var(--run-border, var(--planner-line));
          background: var(--run-fill, transparent); padding: 8px 10px; border-radius: 7px;
          overflow-wrap: anywhere; font-size: 13px; }
        .approved-run[data-status] {
          --run-fill: color-mix(in srgb, var(--run-color, transparent) 12%, transparent);
          --run-border: color-mix(in srgb, var(--run-color, var(--planner-line)) 75%, var(--planner-text) 25%);
        }
        .approved-run:is([data-status="scheduled"], [data-status="starting"], [data-status="stopping"]) {
          --run-color: #2aad4f;
        }
        .approved-run[data-status="running"] {
          --run-color: #18db59;
          --run-fill: color-mix(in srgb, var(--run-color) 22%, transparent);
          border-inline-start-width: 4px;
        }
        .run-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
        .approved-run[data-status="skipped"] { --run-color: #c45c1b; }
        .approved-run[data-status="repeat"] { --run-color: #2051e3; }
        .approved-run[data-status="delayed"] { --run-color: #f0820c; }
        .approved-run:is([data-status="failed"], [data-status="stop_failed"]) { --run-color: #e0341d; }
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
        .must-run-warning {
          grid-column: 1 / -1; display: block; padding: 8px 10px; margin-top: 5px;
          border: 1px solid var(--planner-solar); border-inline-start-width: 3px; border-radius: 6px;
          background: color-mix(in srgb, var(--planner-solar) 13%, var(--planner-card-bg));
          color: var(--planner-text); font-size: 13px; font-weight: 600; line-height: 1.4;
          overflow-wrap: anywhere;
        }
        .recommendation[data-source="unplaced"] .detail { grid-column: span 2; }
        #totals { margin-top: 10px; font-size: 13px; }
        #effects { margin-top: 5px; }
        @container (max-width: 610px) {
          .editor {
            grid-template-columns: minmax(0,1fr) minmax(0,1fr) 32px;
            grid-template-areas: "name name remove" "power duration duration" "deadline source source";
          }
          .load-name { grid-area: name; }
          .load-power { grid-area: power; }
          .load-duration { grid-area: duration; }
          .load-deadline { grid-area: deadline; }
          .power-source { grid-area: source; }
          .remove { grid-area: remove; }
          .schedule-toggle { grid-row: 4; }
          .automation-options { grid-row: 5; }
          .recommendation { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
          .recommendation .detail { grid-column: 1 / -1; }
        }
        @container (max-width: 410px) {
          #approved { padding: 10px; }
          .approved-run { grid-template-columns: minmax(0, 1fr); }
          .approved-run > button { justify-self: start; }
          .run-actions { justify-content: flex-start; }
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
          <ha-icon icon="mdi:calendar-clock" aria-hidden="true"></ha-icon>
          <div><h2 id="title"></h2><p>Suggested times based on your energy forecast</p></div>
        </header>
        <details id="favourites" hidden>
          <summary>★ Favourite workloads <span id="favourite-count" class="muted"></span></summary>
          <ul id="favourite-list"></ul>
          <p id="favourite-empty" class="muted" hidden>No favourites yet. Configure a load and save it as a favourite.</p>
        </details>
        <p id="favourite-status" class="muted" role="status" hidden></p>
        <div id="editors"></div>
        <template id="editor">
          <div class="editor">
            <label class="load-name">Load<input data-field="name" type="text" maxlength="80" placeholder="Load name"></label>
            <label class="load-power">Power (kW)<input data-field="power" type="number" min="0.1" step="0.1" inputmode="decimal"></label>
            <label class="load-duration">Duration (min)<input data-field="minutes" type="number" min="1" step="1" inputmode="numeric"></label>
            <label class="load-deadline"><span class="deadline-label">Finish by (optional)</span><input data-field="deadline" type="time" step="60"></label>
            <label class="power-source">Power source<select data-field="source"></select></label>
            <button class="remove" type="button" aria-label="Remove load" title="Remove load">×</button>
            <label class="schedule-toggle"><input data-field="enabled" type="checkbox"> Enable schedule</label>
            <div class="automation-options" hidden>
              <label>Start automation<select data-field="start_automation" required></select></label>
              <label>Stop automation (optional)<select data-field="stop_automation"></select></label>
              <label>Timing<select data-field="timing">
                <option value="fixed">Fixed</option><option value="flexible">Flexible</option>
              </select></label>
              <label>If the forecast changes<select data-field="policy">
                <option value="defer">${policies.defer}</option><option value="must">${policies.must}</option>
                <option value="search" hidden disabled>${policies.search}</option>
              </select></label>
              <label>Repeat<select data-field="cadence">
                <option value="once">Once-off</option><option value="repeated">Repeated</option>
              </select></label>
              <label class="future-search" hidden>Keep looking for<select data-field="search_days">
                <option value="3">3 days</option><option value="7">7 days</option>
                <option value="unlimited">Until cancelled</option>
              </select></label>
              <fieldset class="repeat-days" hidden>
                <legend>Run on</legend>
                <div class="weekday-options"></div>
              </fieldset>
            </div>
            <div class="favourite-toolbar" hidden>
              <input class="favourite-name" type="text" maxlength="80" placeholder="Favourite name (optional)" aria-label="Favourite name">
              <button class="save-favourite" type="button">☆ Save as favourite</button>
              <button class="update-favourite" type="button" hidden>Update favourite</button>
            </div>
          </div>
        </template>
        <div class="editor-toolbar"><button id="add" type="button">+ Add load</button></div>
        <p id="status" role="status" hidden></p>
        <section id="schedule" aria-labelledby="schedule-title" hidden>
          <div class="schedule-heading"><h3 id="schedule-title">Suggested schedule</h3><span id="horizon" class="muted"></span></div>
          <ul id="recommendations"></ul>
          <p id="totals"></p>
          <p id="effects" class="muted" hidden></p>
        </section>
        <section id="edit-impact" aria-labelledby="edit-impact-title" hidden>
          <h3 id="edit-impact-title">Forecast impact</h3>
          <p id="edit-impact-note" class="muted" role="status"></p>
          <table id="edit-impact-table" hidden>
            <thead><tr><th scope="col">Estimate</th><th scope="col">Current schedule</th><th scope="col">With your edits</th></tr></thead>
            <tbody id="edit-impact-rows"></tbody>
          </table>
          <p id="edit-impact-delta" hidden></p>
        </section>
        <div id="approval" hidden>
          <button id="approve" type="button">Save schedule</button>
          <button id="cancel-edit" type="button" hidden>Cancel edit</button>
          <p id="approval-note" class="muted"></p>
        </div>
        <p id="action-status" class="muted" role="status" hidden></p>
        <section id="approved" aria-labelledby="approved-title" hidden>
          <h3 id="approved-title">Load schedules</h3>
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
              <h3>Recent load runs</h3>
              <div id="history-actions">
                <button id="clear-completed" type="button" hidden>Clear completed runs</button>
                <button id="clear-cancelled" type="button" hidden>Clear cancelled runs</button>
              </div>
            </div>
            <ul id="history-list"></ul>
          </div>
        </section>
        <details id="load-guide">
          <summary>How to schedule a load</summary>
          <ol>
            <li>Select <strong>Add load</strong>. Enter a name, power in kW, and duration in minutes.
              For example, a 1,500 W dryer is 1.5 kW.</li>
            <li>Choose a <strong>Power source</strong> and, if needed, a <strong>Finish by</strong> time.</li>
            <li>Turn on <strong>Enable schedule</strong>. Select the Home Assistant automation that starts the appliance,
              and optionally one that stops it. Create these in <strong>Settings → Automations &amp; scenes</strong>
              if they do not appear in the list.</li>
            <li>Choose <strong>Timing</strong>, what to do <strong>If the forecast changes</strong>, and whether to <strong>Repeat</strong>.</li>
            <li>Review the suggested time and estimated energy and cost when available, then save the schedule.
              Only a Home Assistant administrator can schedule loads. Home Assistant runs them even when this page is closed.</li>
          </ol>
          <h4>Power source</h4>
          <ul>
            <li><strong>Surplus solar only</strong> uses solar left after other demand and planned battery charging.</li>
            <li><strong>Solar + battery</strong> can also use available battery energy within its limits.</li>
            <li><strong>Solar before battery charging</strong> can use solar that would otherwise go into flexible battery charging.</li>
            <li><strong>Grid allowed</strong> can use surplus solar, available battery energy, then grid power for the shortfall.</li>
          </ul>
          <h4>Timing and automation settings</h4>
          <ul>
            <li><strong>Finish by</strong> is the latest time the run should end. Repeats and flexible <strong>Must run</strong>
              loads require it. For a new once-off run, the card uses the next occurrence of that local time.</li>
            <li><strong>Start automation</strong> is required. <strong>Stop automation</strong> runs after the duration.
              Leave it blank when the appliance finishes on its own.</li>
            <li><strong>Fixed</strong> keeps the first suitable start the scheduler selects for that occurrence.
              <strong>Flexible</strong> can move the start as the forecast changes.</li>
            <li><strong>Must run</strong> prefers a window that meets the selected power source. If no such window fits,
              the scheduler finds the best available time using additional solar, battery or grid energy and displays a warning.
              A Fixed load keeps its start time; a Flexible load can move with the forecast. Power limits, battery reserves
              and automation conflicts still apply. A time beyond the forecast is shown as unverified.</li>
            <li><strong>${policies.defer}</strong> skips a Fixed load if the forecast cannot cover it at the scheduled time.
              A Flexible load looks for a suitable time before the deadline and skips the run if no time fits.</li>
            <li><strong>Keep looking on future days</strong> is for Flexible, once-off loads. The scheduler uses the same
              finish time each day and starts the load once when a suitable time is forecast. Choose 3 days, 7 days or
              Until cancelled. The first day with enough time before the deadline counts as day one.</li>
            <li><strong>Once-off</strong> runs once. <strong>Repeated</strong> runs on the selected weekdays.
              The scheduler chooses a start that fits before <strong>Finish by</strong> on each selected day.</li>
          </ul>
          <p><strong>Example</strong> To run a pool pump for four hours on selected days, set the duration to 240 minutes and
            <strong>Finish by</strong> to 4 pm. Choose <strong>Repeated</strong>, <strong>Flexible</strong>,
            <strong>Must run</strong> and <strong>Grid allowed</strong>. The planner looks for a suitable window and can start by noon
            if grid power is needed.</p>
          <p><strong>Favourite workloads</strong> save reusable settings without scheduling anything.
            Choose <strong>Use</strong> to create a new draft, or <strong>Edit / rename</strong> and then
            <strong>Update favourite</strong> to save permanent changes. <strong>Duplicate</strong> creates a draft for a new favourite.
            A completed run can be loaded again using <strong>Use again</strong>.</p>
          <p>Under <strong>Load schedules</strong>, use <strong>Edit</strong> or <strong>Edit today</strong> to preview changes
            before saving. <strong>Clear completed runs</strong> removes finished entries from <strong>Recent load runs</strong>.</p>
        </details>
      </ha-card>`;
    this._get("add").addEventListener("click", () => this._addLoad());
    this._get("approve").addEventListener("click", () => this._approve());
    this._get("cancel-edit").addEventListener("click", () => this._endEdit());
    for (const status of ["cancelled", "completed"]) {
      this._get("clear-" + status).addEventListener("click", event => this._clearHistory(event.currentTarget, status));
    }
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
      title: config.name ?? "Flexible Load Scheduler",
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
    const darkMode = hass.themes?.darkMode;
    if (typeof darkMode === "boolean") this.setAttribute("data-theme", darkMode ? "dark" : "light");
    else this.removeAttribute("data-theme");
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

  _addLoad(job = null, favourite = null) {
    const row = this._get("editor").content.firstElementChild.cloneNode(true);
    row.dataset.id = String(this._nextId++);
    const input = field => row.querySelector(`[data-field="${field}"]`);
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
    const updateScheduleFields = () => {
      const enabled = input("enabled").checked;
      const repeated = enabled && input("cadence").value === "repeated";
      const searchOption = input("policy").querySelector('[value="search"]');
      const canSearch = enabled && input("timing").value === "flexible" && !repeated && !job?.repeat_id;
      searchOption.hidden = searchOption.disabled = !canSearch;
      if (!canSearch && input("policy").value === "search") input("policy").value = "defer";
      const searching = canSearch && input("policy").value === "search";
      row.querySelector(".repeat-days").hidden = !repeated;
      row.querySelector(".future-search").hidden = !searching;
      row.querySelector(".deadline-label").textContent = searching ? "Finish by each day" :
        repeated || job ? "Finish by" : "Finish by (optional)";
    };
    row.addEventListener("input", event => {
      if (event.target === input("enabled")) {
        row.querySelector(".automation-options").hidden = !input("enabled").checked;
        this._populateAutomations(row);
      }
      updateScheduleFields();
      clearTimeout(this._editTimer);
      this._editTimer = setTimeout(() => this._render(), 200);
    });
    row.querySelector(".save-favourite").addEventListener("click", () => this._saveFavourite(row, false));
    row.querySelector(".update-favourite").addEventListener("click", () => this._saveFavourite(row, true));
    row.querySelector(".remove").hidden = Boolean(job);
    row.querySelector(".remove").addEventListener("click", () => {
      row.remove();
      this._get("add").focus();
      this._render();
    });
    if (job) {
      const timeZone = this._hass.config?.time_zone || undefined;
      input("enabled").checked = true;
      input("enabled").closest("label").hidden = true;
      input("cadence").closest("label").hidden = true;
      row.querySelector(".automation-options").hidden = false;
      row.querySelector(".deadline-label").textContent = "Finish by";
      input("deadline").value = job.search?.finish_by ?? localDateTime(job.deadline * 1000, timeZone).slice(11);
      if (job.search) input("search_days").value = job.search.days ?? "unlimited";
      input("minutes").value = job.duration / 60;
      this._populateAutomations(row);
      for (const field of ["name", "power", "source", "timing", "policy", "start_automation", "stop_automation"]) {
        input(field).value = job[field];
      }
      this._editing = { row, job };
    }
    if (favourite) {
      const settings = favourite.settings;
      for (const field of ["name", "power", "minutes", "deadline", "source", "timing", "policy", "cadence"]) {
        input(field).value = settings[field];
      }
      input("enabled").checked = settings.enabled;
      input("search_days").value = settings.search_days ?? "unlimited";
      for (const checkbox of row.querySelectorAll(".weekday-options input")) {
        checkbox.checked = settings.weekdays.includes(Number(checkbox.value));
      }
      row.querySelector(".automation-options").hidden = !settings.enabled;
      this._populateAutomations(row);
      for (const field of ["start_automation", "stop_automation"]) {
        const select = input(field);
        const entity = settings[field];
        if (entity && !Array.from(select.options).some(option => option.value === entity)) {
          select.add(new Option(entity + " (unavailable)", entity));
        }
        select.value = entity;
      }
      row.favouriteId = favourite.id ?? null;
      row.querySelector(".favourite-name").value = favourite.name ?? "";
    }
    updateScheduleFields();
    this._get("editors").append(row);
    input("name").focus();
    this._render();
    return row;
  }

  _favouriteStatus(message) {
    const status = this._get("favourite-status");
    status.textContent = message;
    status.hidden = !message;
  }

  _favouriteSettings(row) {
    const input = field => row.querySelector(`[data-field="${field}"]`);
    const value = field => input(field).value;
    return {
      name: value("name").trim(), power: finite(value("power")), minutes: finite(value("minutes")),
      deadline: value("deadline"), source: value("source"), enabled: input("enabled").checked,
      timing: value("timing"), policy: value("policy"), cadence: value("cadence"),
      search_days: value("search_days") === "unlimited" ? null : Number(value("search_days")),
      weekdays: Array.from(row.querySelectorAll(".weekday-options input:checked"), item => Number(item.value)),
      start_automation: value("start_automation"), stop_automation: value("stop_automation"),
    };
  }

  async _favouriteRequest(action, payload, message) {
    if (!this._backend?.supports_favourites || !this._hass?.user?.is_admin ||
        this._editing || this._saving || this._favouriteSaving) return null;
    this._favouriteSaving = true;
    this._renderFavourites();
    try {
      const result = await this._hass.callWS({ type: schedulerDomain + "/" + action, ...payload });
      this._favouriteStatus(message);
      return result ?? true;
    } catch (error) {
      this._favouriteStatus(error?.message || "Could not save the favourite change.");
      return null;
    } finally {
      this._favouriteSaving = false;
      this._renderFavourites();
    }
  }

  async _saveFavourite(row, update) {
    if (this._editing || this._saving || this._favouriteSaving) return;
    const settings = this._favouriteSettings(row);
    if (!settings.name || !(settings.power >= 0.1 && settings.power <= 1000) ||
        !Number.isInteger(settings.minutes) || settings.minutes < 1 || settings.minutes > 1440) {
      this._favouriteStatus("Enter a load name, valid power and whole-minute duration before saving a favourite.");
      return;
    }
    const nameField = row.querySelector(".favourite-name");
    const name = nameField.value.trim() || settings.name;
    if (update && !row.favouriteId) return;
    const result = await this._favouriteRequest(update ? "update_favourite" : "save_favourite", {
      name, settings, ...(update ? { favourite_id: row.favouriteId } : {}),
    }, update ? "Favourite updated." : "Favourite saved.");
    if (result?.id) {
      row.favouriteId = result.id;
      nameField.value = result.name;
      this._get("favourites").open = true;
      this._renderFavourites();
    }
  }

  _useFavourite(favourite, mode = "use") {
    if (this._editing || this._saving || this._favouriteSaving) return;
    const copy = { ...favourite, settings: { ...favourite.settings, weekdays: [...favourite.settings.weekdays] } };
    if (mode === "duplicate") {
      copy.id = null;
      copy.name = (copy.name.slice(0, 73) + " (copy)");
    }
    const row = this._addLoad(null, copy);
    row.scrollIntoView({ block: "nearest" });
    if (mode === "edit" || mode === "duplicate") row.querySelector(".favourite-name").focus();
    this._favouriteStatus(mode === "edit" ? "Change the settings or name, then select Update favourite." :
      mode === "duplicate" ? "Change the settings or name, then select Save as favourite." :
        "Favourite loaded. Review the settings and suggested schedule before scheduling.");
  }

  _useCompletedRun(job) {
    if (this._editing || this._saving || this._favouriteSaving) return;
    const timeZone = this._hass.config?.time_zone || undefined;
    const finish = job.search?.finish_by ?? (job.deadline == null ? "" : localDateTime(job.deadline * 1000, timeZone).slice(11));
    const settings = {
      name: job.name, power: job.power, minutes: job.duration / 60, deadline: finish,
      source: job.source, enabled: true, timing: job.timing, policy: job.policy, cadence: "once",
      search_days: job.search ? job.search.days : 3, weekdays: [],
      start_automation: job.start_automation, stop_automation: job.stop_automation,
    };
    const row = this._addLoad(null, { name: job.name, settings });
    row.scrollIntoView({ block: "nearest" });
    this._favouriteStatus("Completed run loaded as a new once-off load. Review the finish time before scheduling.");
  }

  _renderFavourites() {
    const supported = Boolean(this._backend?.supports_favourites);
    const admin = Boolean(this._hass?.user?.is_admin);
    const entries = this._backend?.favourites ?? [];
    const limit = this._backend?.max_favourites ?? 20;
    const busy = Boolean(this._editing || this._saving || this._favouriteSaving);
    const full = entries.length >= limit;
    const section = this._get("favourites");
    section.hidden = !supported || !entries.length || Boolean(this._editing);
    this._get("favourite-count").textContent = entries.length + " / " + limit + " saved";
    this._get("favourite-empty").hidden = Boolean(entries.length);
    for (const row of this._get("editors").children) {
      row.querySelector(".favourite-toolbar").hidden = !supported || !admin || Boolean(this._editing);
      const save = row.querySelector(".save-favourite");
      save.disabled = busy || full;
      save.title = full ? "Delete a favourite before saving another." : "Save a new favourite without scheduling the load.";
      const update = row.querySelector(".update-favourite");
      update.hidden = !row.favouriteId || !entries.some(entry => entry.id === row.favouriteId);
      update.disabled = busy;
    }
    const list = this._get("favourite-list");
    const signature = JSON.stringify([entries, limit, admin, busy]);
    if (this._favouriteSignature === signature) return;
    this._favouriteSignature = signature;
    list.replaceChildren();
    for (const entry of entries) {
      const settings = entry.settings;
      const item = document.createElement("li");
      item.className = "favourite-row";
      const summary = document.createElement("div");
      summary.className = "favourite-summary";
      const title = document.createElement("strong");
      title.textContent = entry.name;
      const detail = document.createElement("small");
      detail.textContent = [settings.power + " kW", settings.minutes + " min",
        sources.find(([value]) => value === settings.source)?.[1] ?? settings.source,
        settings.deadline ? "Finish by " + settings.deadline : "", settings.cadence === "repeated" ? "Repeated" : ""].filter(Boolean).join(" · ");
      summary.append(title, detail);
      const actions = document.createElement("div");
      actions.className = "favourite-actions";
      const button = (label, handler, disabled = false) => {
        const control = document.createElement("button");
        control.type = "button";
        control.textContent = label;
        control.setAttribute("aria-label", label + " " + entry.name);
        control.disabled = busy || disabled;
        control.addEventListener("click", handler);
        actions.append(control);
      };
      button("Use", () => this._useFavourite(entry));
      if (admin) {
        button("Edit / rename", () => this._useFavourite(entry, "edit"));
        button("Duplicate", () => this._useFavourite(entry, "duplicate"), full);
        button("Delete", () => {
          if (window.confirm("Delete favourite \"" + entry.name + "\"? Existing schedules will not change.")) {
            this._favouriteRequest("delete_favourite", { favourite_id: entry.id }, "Favourite deleted.");
          }
        });
      }
      item.append(summary, actions);
      list.append(item);
    }
  }

  _editRun(job) {
    if (this._editing || this._saving) return;
    for (const row of this._get("editors").children) row.hidden = true;
    this._get("add").hidden = true;
    this._actionStatus("Editing " + job.name + (job.repeat_id ? " for this occurrence." : "."));
    this._addLoad(job);
    this._editing.row.scrollIntoView({ block: "nearest" });
  }

  _endEdit(message = "") {
    if (!this._editing) return;
    this._editing.row.remove();
    this._editing = null;
    for (const row of this._get("editors").children) row.hidden = false;
    this._get("add").hidden = false;
    this._actionStatus(message);
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
      this._hass?.states?.[entityId]?.state === "on";
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
      if (previous && !choices.some(([id]) => id === previous)) {
        select.add(new Option(previous + " (unavailable)", previous));
      }
      select.value = previous;
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

  _readLoads(timeZone, now, earliest) {
    const rows = this._editing ? [this._editing.row] : Array.from(this._get("editors").children);
    return rows.map((row, index) => {
      const value = field => row.querySelector(`[data-field="${field}"]`).value;
      const power = finite(value("power"));
      const minutes = finite(value("minutes"));
      const deadlineValue = value("deadline");
      const enabled = row.querySelector('[data-field="enabled"]').checked;
      const timing = value("timing");
      const policy = value("policy");
      const days = value("search_days");
      const search = enabled && policy === "search" ? {
        finish_by: deadlineValue, days: days === "unlimited" ? null : Number(days),
      } : null;
      const repeated = enabled && value("cadence") === "repeated";
      const repeat = repeated ? {
        days: Array.from(row.querySelectorAll(".weekday-options input:checked"), input => Number(input.value)),
        finish_by: deadlineValue,
      } : null;
      const edit = this._editing?.job;
      const finishDate = edit ? localDateTime(edit.deadline * 1000, timeZone).slice(0, 10) : null;
      const deadline = !repeated && !search && deadlineValue ? parseDeadline(deadlineValue, timeZone, now, finishDate) : null;
      let problem = "";
      if (!(power >= 0.1) || !Number.isSafeInteger(minutes) || minutes < 1) {
        problem = "Enter a power and a whole-minute duration.";
      } else if (search) {
        const finish = clockMinutes(search.finish_by);
        if (finish === null || finish < minutes) problem = "Choose a daily finish time that leaves enough time to run.";
      } else if (edit) {
        if (deadline === null || deadline - minutes * minute <= now || deadline - now > 48 * hour) {
          problem = "Choose a finish time that leaves enough time to run on the original day.";
        }
      } else if (repeat) {
        const finish = clockMinutes(repeat.finish_by);
        if (!repeat.days.length) problem = "Select at least one weekday.";
        else if (finish === null) problem = "Choose a finish-by time.";
        else if (finish < minutes) problem = "The run must fit within the selected day.";
      } else if (deadlineValue && deadline === null) {
        problem = "Choose a valid finish time in " + (timeZone ?? "your local timezone") + ".";
      } else if (deadline !== null && deadline < earliest + minutes * minute) {
        problem = "The load cannot finish by this deadline.";
      }
      return {
        id: Number(row.dataset.id), name: value("name").trim() || "Load " + (index + 1),
        power, duration: minutes * minute, deadline,
        source: value("source"),
        enabled, timing, repeat, policy, search,
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
    this._renderFavourites();
    this._approval = null;
    this._get("cancel-edit").hidden = !this._editing;
    this._get("cancel-edit").disabled = Boolean(this._saving);
    this._get("edit-impact").hidden = !this._editing;
    if (this._editing) {
      const now = Date.now();
      this._get("status").hidden = true;
      this._get("schedule").hidden = true;
      this._renderApproval(this._readLoads(this._hass.config?.time_zone || undefined, now, now), { jobs: [] }, null, now);
      this._renderEditPreview(now);
      return;
    }
    const now = Date.now();
    const timeZone = this._hass?.config?.time_zone || undefined;
    const showStatus = message => {
      const loads = this._readLoads(timeZone, now, now);
      this._renderApproval(loads, { jobs: [] }, null, now);
      this._get("status").textContent = message;
      this._get("status").hidden = false;
      this._get("schedule").hidden = true;
    };
    if (!this._get("editors").childElementCount) {
      showStatus("Add a load to see suggested times.");
      return;
    }
    const state = this._hass?.states?.[entity];
    const plan = state?.attributes?.energy_plan;
    const generated = Date.parse(plan?.meta?.generated_at ?? plan?.summary?.ts);
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
    const loads = this._readLoads(timeZone, now, intervals[0].from);
    const siteCapacity = capacity || nonnegative(this._hass.states?.[capacityEntity]?.state);
    const battery = siteCapacity && intervals.every(row =>
      [row.startSoc, row.endSoc, row.floor].every(value => value !== null && value <= 100)) ?
      { capacity: siteCapacity, chargeEfficiency, dischargeEfficiency } : null;
    const reserved = approvedWindows(this._backend?.jobs ?? [], now);
    const schedule = recommend(intervals, loads.filter(row => !row.problem && !row.repeat && !row.search), battery, reserved);
    this._renderSchedule(loads, schedule, intervals, battery, timeZone, now, reserved);
    this._renderApproval(loads, schedule, intervals.at(-1).end, now);
    this._get("status").hidden = true;
    this._get("schedule").hidden = false;
  }

  _renderEditPreview(now) {
    const edit = this._editing;
    const draft = this._approval?.[0]?.data;
    const note = this._get("edit-impact-note");
    const table = this._get("edit-impact-table");
    const delta = this._get("edit-impact-delta");
    table.hidden = true;
    delta.hidden = true;
    note.removeAttribute("data-fallback");
    if (!draft || !this._backend?.supports_edit_preview) {
      edit.preview = null;
      note.textContent = draft ? "Update the load scheduler to preview and save changes." :
        "Enter valid settings to see their forecast impact.";
      this._approval = null;
      this._get("approve").disabled = true;
      return;
    }

    const job = { ...draft, id: edit.job.id };
    const key = JSON.stringify([job, Math.floor(now / minute)]);
    const forecast = this._hass.states?.[this._config.entity];
    const capacity = this._hass.states?.[this._config.capacityEntity];
    if (edit.preview?.key !== key || edit.preview.backend !== this._backend ||
        edit.preview.forecast !== forecast || edit.preview.capacity !== capacity) {
      const preview = { key, backend: this._backend, forecast, capacity };
      edit.preview = preview;
      this._hass.callWS({ type: schedulerDomain + "/edit_preview", job }).then(result => {
        if (this._editing !== edit || edit.preview !== preview) return;
        preview.result = result;
        this._render();
      }).catch(error => {
        if (this._editing !== edit || edit.preview !== preview) return;
        preview.error = error?.message || "Could not estimate this change.";
        this._render();
      });
    }
    const { result, error } = edit.preview;
    note.textContent = error || result?.message || (result ? "" : "Checking the energy forecast…");
    if (result && typeof result.changed !== "boolean") {
      note.textContent = "Restart Home Assistant with the updated load scheduler to compare schedules.";
      this._approval = null;
      this._get("approve").disabled = true;
      return;
    }
    if (!result?.can_save) {
      this._approval = null;
      this._get("approve").disabled = true;
    }
    if (!result) return;
    this._showEditComparison(result);
  }

  _showEditComparison({ current, proposed, changed, message }) {
    const locale = this._hass.language || undefined;
    const time = new Intl.DateTimeFormat(locale, {
      weekday: "short", hour: "numeric", minute: "2-digit", timeZone: this._hass.config?.time_zone || undefined,
    });
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const money = new Intl.NumberFormat(locale, {
      style: "currency", currency: this._hass.config?.currency || "AUD", currencyDisplay: "narrowSymbol",
    });
    const window = booking => booking.start === null ? "No start forecast" :
      time.format(booking.start * 1000) + " – " + time.format(booking.end * 1000);
    const cost = (booking, field) => booking.impact?.[field] == null ? "Unavailable" : money.format(booking.impact[field]);
    const mix = booking => {
      if (!booking.impact) return "Unavailable";
      const amounts = booking.impact.mix;
      return [["solar", "solar"], ["diverted", "solar diverted from charging"], ["battery", "battery"], ["grid", "grid"]]
        .filter(([key]) => amounts[key] > energyTolerance)
        .map(([key, label]) => number.format(amounts[key]) + " kWh " + label).join(" · ");
    };
    const grid = booking => booking.impact ? number.format(booking.impact.grid) + " kWh" : "Unavailable";
    const source = new Map(sources);
    const outcome = {
      forecast: "Fits the selected power source",
      fixed: "Starts at the saved time",
      must_override: "Must run · preferred power source overridden",
      must_unverified: "Must run · forecast coverage incomplete",
      blocked: "Must run · blocked by known constraints",
      latest_start: "Must run · battery or grid may be used",
      fixed_must: "Must run at the fixed time · battery or grid may be used",
      fixed_at_risk: "May be skipped if the forecast cannot cover the fixed start",
      conflict: "Overlaps another load using the same automation",
      no_window: "No time fits the selected settings",
      searching: "Still looking for a suitable time",
      no_forecast: "Waiting for an up-to-date forecast",
    };
    const note = this._get("edit-impact-note");
    const fallback = ["latest_start", "fixed_must"].includes(proposed.outcome);
    if (proposed.warning) {
      note.textContent = proposed.warning + (message ? " " + message : "");
      note.setAttribute("data-fallback", "");
    } else if (fallback) {
      const start = time.format(proposed.start * 1000);
      const reason = proposed.outcome === "fixed_must" ? " (the fixed start time)" :
        " if no suitable time opens up before then";
      const subject = changed ? "With your edits, Must run can start this load at " :
        "Your current schedule already allows Must run to start this load at ";
      note.textContent = subject + start + reason + ". Battery or grid power may cover the shortfall." +
        (changed ? "" : " No changes are needed.") + (message ? " " + message : "");
      note.setAttribute("data-fallback", "");
    } else {
      note.textContent = message || (changed ? "" : "No changes to save.");
    }
    const rows = this._get("edit-impact-rows");
    rows.replaceChildren();
    for (const [label, format] of [
      ["Finish by", booking => booking.search ? booking.search.finish_by + " each day" : time.format(booking.deadline * 1000)],
      ["Power source preference", booking => source.get(booking.source)],
      ["Timing", booking => booking.timing === "fixed" ? "Fixed" : "Flexible"],
      ["If the forecast changes", booking => policies[booking.policy]],
      ...(current.search || proposed.search ? [["Keep looking for", booking =>
        !booking.search ? "—" : booking.search.days === null ? "Until cancelled" : booking.search.days + " days"]] : []),
      ["Power and duration", booking => number.format(booking.power) + " kW · " + booking.duration / 60 + " min"],
      ["Expected run time", window],
      ["How it would run", booking => outcome[booking.outcome]],
      ["Load energy mix", mix],
      ["Additional site grid use", grid],
      ["Battery energy change at forecast end", booking => booking.impact?.deficit != null ?
        number.format(-booking.impact.deficit || 0) + " kWh" : "Unavailable"],
      ["Extra grid cost", booking => cost(booking, "grid_cost")],
      ["Feed-in impact", booking => cost(booking, "export_cost")],
      ["Estimated added cost", booking => cost(booking, "total_cost")],
    ]) {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      const before = format(current);
      const after = format(proposed);
      const savedCell = document.createElement("td");
      savedCell.textContent = before;
      const draftCell = document.createElement("td");
      draftCell.textContent = after;
      if (after !== before) draftCell.setAttribute("data-changed", "");
      row.append(savedCell, draftCell);
      rows.append(row);
    }
    this._get("edit-impact-table").hidden = false;
    if (changed && current.impact?.total_cost != null && proposed.impact?.total_cost != null) {
      const diff = proposed.impact.total_cost - current.impact.total_cost;
      const delta = this._get("edit-impact-delta");
      delta.hidden = false;
      delta.textContent = Math.abs(diff) < 0.005 ? "No estimated cost change." :
        "Estimated change · " + money.format(Math.abs(diff)) + (diff < 0 ? " less" : " more");
    }
  }

  _renderApproval(loads, schedule, horizon, now) {
    const enabled = loads.filter(row => row.enabled);
    this._get("approval").hidden = !enabled.length;
    if (!enabled.length) return;
    const backend = this._backend;
    const { entity, capacityEntity, capacity, maxAge, chargeEfficiency, dischargeEfficiency } = this._config;
    const proposed = new Map(schedule.jobs.map(row => [row.id, row.start]));
    const windows = approvedWindows(backend?.jobs ?? [], now);
    const approvalWindows = enabled.filter(row => !row.problem && !row.repeat).flatMap(row => {
      const start = proposed.get(row.id) ?? null;
      return start === null ? [] : [{ ...row, start, end: start + row.duration }];
    });
    const issues = [];
    if (!backend) {
      issues.push(this._subscription?.failed ? "Install or restart the Home Assistant load scheduler." :
        "Connecting to the Home Assistant load scheduler.");
    } else {
      if (!backend.automation_exclusions) issues.push("Update the Home Assistant load scheduler.");
      if (enabled.some(mustRun) && !backend.supports_must_run_fallback) {
        issues.push("Update and restart the Home Assistant scheduler to use the new Must run behaviour.");
      }
      const config = backend.config;
      if (config.entity !== entity || config.battery_capacity_entity !== capacityEntity ||
          (config.battery_capacity_kwh ?? null) !== (capacity || null) ||
          config.max_plan_age_minutes * minute !== maxAge ||
          config.battery_charge_efficiency !== chargeEfficiency || config.battery_discharge_efficiency !== dischargeEfficiency) {
        issues.push("The card and scheduler must use matching forecast settings.");
      }
    }
    if (!this._hass?.user?.is_admin) issues.push("Only a Home Assistant administrator can schedule loads.");

    const edit = this._editing?.job;
    if (edit && !backend?.jobs?.some(job => job.id === edit.id && ["scheduled", "delayed"].includes(job.status))) {
      issues.push("This run is no longer scheduled or delayed.");
    }
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
        if (!backend?.supports_forecast_repeats) issues.push(label + "Update the Home Assistant scheduler to enable repeated runs.");
        else jobs.push({ rowId: row.id, data: {
          name: row.name, power: row.power, duration: row.duration / 1000, source: row.source,
          timing: row.timing, policy: row.policy, repeat: row.repeat,
          start_automation: row.start_automation, stop_automation: row.stop_automation,
        } });
      } else if (row.search) {
        if (!backend?.supports_future_day_search) issues.push(label + "Update the Home Assistant scheduler to search future days.");
        else jobs.push({ rowId: row.id, data: {
          name: row.name, power: row.power, duration: row.duration / 1000, source: row.source,
          timing: row.timing, policy: row.policy, search: row.search,
          start_automation: row.start_automation, stop_automation: row.stop_automation,
        } });
      } else if (!edit && horizon === null) {
        issues.push(label + "Wait for an up-to-date forecast before scheduling this load.");
      } else if (row.timing === "flexible" && row.policy === "must" && row.deadline === null) {
        issues.push(label + "Choose a finish time for Must run.");
      } else if (deadline - row.duration <= now || deadline - now > 48 * hour) {
        issues.push(label + "Choose a finish time within 48 hours that leaves enough time to run.");
      } else if (!edit && start === null && mustRun(row)) {
        issues.push(label + blockedWarning);
      } else if (!edit && start === null && row.timing === "fixed") {
        issues.push(label + "A suitable forecast window is required for a Fixed run.");
      } else if (start === null && row.deadline === null) {
        issues.push(label + "Choose a finish time to schedule this load without a suggested start time.");
      } else if (!edit && approvalWindows.some(window => window.id === row.id &&
          automationClash(window, [...windows, ...approvalWindows.filter(other => other.id !== row.id)]))) {
        issues.push(label + "Another load uses the same automation at this time. Change the finish time or reschedule the other load.");
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
    if (jobs.length > 12) issues.push("You can schedule up to 12 loads at a time.");
    if (!issues.length) this._approval = jobs;
    this._get("approve").disabled = Boolean(issues.length) || Boolean(this._saving);
    this._get("approve").textContent = edit ? "Save changes" : enabled.some(row => row.repeat) ? "Save schedule" :
      enabled.length === 1 ? "Schedule load" : "Schedule " + enabled.length + " loads";
    this._get("approval-note").textContent = issues.join(" ") || (edit ? "" :
      enabled.some(row => row.policy === "must") ?
      "Must run prefers your selected power source, but may use battery or grid power if necessary. A Flexible run can move with the forecast." :
      "Home Assistant will run this schedule when the dashboard is closed.");
  }

  _actionStatus(message) {
    this._get("action-status").textContent = message;
    this._get("action-status").hidden = !message;
  }

  async _approve() {
    const shown = JSON.stringify(this._approval);
    const review = this._editing?.preview?.result?.review;
    this._render();
    if (!this._approval || this._saving) return;
    if (shown !== JSON.stringify(this._approval)) {
      this._actionStatus("The suggested schedule changed. Review the updated times before saving.");
      return;
    }
    const drafts = this._approval.map(({ rowId, data }) => {
      const row = this._get("editors").querySelector(`[data-id="${rowId}"]`);
      if (this._editing) return { row, data: { ...data, id: this._editing.job.id } };
      const signature = JSON.stringify(data);
      if (row.approval?.signature !== signature) row.approval = { signature, id: approvalId() };
      return { row, data: { ...data, id: row.approval.id } };
    });
    this._saving = true;
    this._actionStatus("Saving the schedule…");
    this._render();
    try {
      if (this._editing) {
        await this._hass.callWS({ type: schedulerDomain + "/edit", job: drafts[0].data, review });
        this._endEdit("Run updated.");
        return;
      }
      await this._hass.callWS({ type: schedulerDomain + "/approve", jobs: drafts.map(draft => draft.data) });
      for (const draft of drafts) draft.row.remove();
      this._actionStatus(drafts.some(draft => draft.data.repeat) ? "Schedule saved." :
        drafts.length === 1 ? "Load scheduled." : drafts.length + " loads scheduled.");
    } catch (error) {
      const message = error?.message
        ?.replace("The forecast or approved runs no longer support this schedule.", "The forecast or other scheduled loads no longer allow these times.")
        .replace("overlaps another approved run using the same automation.", "overlaps another scheduled load that uses the same automation.");
      this._actionStatus(message || "Could not save the schedule.");
      if (this._editing) this._editing.preview = null;
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

  async _clearHistory(button, status) {
    button.disabled = true;
    try {
      const { count } = await this._hass.callWS({ type: schedulerDomain + "/clear_" + status });
      this._actionStatus("Cleared " + count + " " + status + (count === 1 ? " run." : " runs."));
    } catch (error) {
      this._actionStatus(error?.message || "Could not clear " + status + " runs.");
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
    this._get("clear-completed").hidden = !admin || !this._backend?.supports_clear_completed ||
      !jobs.some(job => job.status === "completed");
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
      detail.textContent = days + " · " +
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
      if (job.search) {
        const limit = job.search.days === null ? "until cancelled" : "up to " + job.search.days + " days";
        note.textContent = ["scheduled", "delayed"].includes(job.status) ?
          [job.note, "Finish by " + job.search.finish_by + " each day · Looking " + limit].filter(Boolean).join(" ") :
          job.note;
      }
      summary.append(title, time, note);
      if (job.source_warning && job.status !== "cancelled") {
        const warning = document.createElement("div");
        warning.className = "must-run-warning";
        warning.textContent = "⚠ " + job.source_warning;
        summary.append(warning);
      }
      item.append(summary);
      if (admin && ["scheduled", "delayed", "stop_failed"].includes(job.status)) {
        const action = job.status === "stop_failed" ? "retry_stop" : "cancel";
        const label = action === "retry_stop" ? "Retry stop" : job.repeat_id ? "Skip today" : "Cancel";
        const message = action === "retry_stop" ? "Stop requested." : job.repeat_id ? "Today's run skipped." : "Run cancelled.";
        const actions = document.createElement("div");
        actions.className = "run-actions";
        if (action === "cancel" && this._backend.supports_edit) {
          const edit = document.createElement("button");
          edit.type = "button";
          edit.textContent = job.repeat_id ? "Edit today" : "Edit";
          edit.setAttribute("aria-label", edit.textContent + " " + job.name);
          edit.disabled = Boolean(this._editing || this._saving);
          edit.addEventListener("click", () => this._editRun(job));
          actions.append(edit);
        }
        actions.append(this._runButton(label, action, job, message));
        item.append(actions);
      } else if (admin && job.status === "skipped" && job.unskip_until > now) {
        item.append(this._runButton("Unskip today", "unskip", job, "Today's run restored."));
      }
      if (job.status === "completed" && this._backend?.supports_favourites) {
        const reuse = document.createElement("button");
        reuse.type = "button";
        reuse.textContent = "Use again";
        reuse.setAttribute("aria-label", "Use again " + job.name);
        reuse.disabled = Boolean(this._editing || this._saving);
        reuse.addEventListener("click", () => this._useCompletedRun(job));
        item.append(reuse);
      }
      (current.has(job.status) ? list : history).append(item);
    }
  }

  _renderSchedule(loads, schedule, intervals, battery, timeZone, now, reserved) {
    const last = intervals.at(-1);
    const locale = this._hass.language || undefined;
    const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone });
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone });
    const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const money = new Intl.NumberFormat(locale, {
      style: "currency", currency: this._hass.config?.currency || "AUD", currencyDisplay: "narrowSymbol",
    });
    const kwh = value => value > energyTolerance && value < 0.01 ? "<0.01 kWh" : number.format(value) + " kWh";
    const cost = value => value === null ? "Cost unavailable" : money.format(value);
    const startLabel = date => day.format(date) === day.format(now) ? "Today" : day.format(date);
    const jobs = new Set(schedule.jobs.map(job => job.id));
    const list = this._get("recommendations");
    list.replaceChildren();
    const rows = [...schedule.jobs.sort((a, b) => a.start - b.start || a.id - b.id),
      ...loads.filter(row => !jobs.has(row.id))];
    for (const row of rows) {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const detail = document.createElement("div");
      item.className = "recommendation";
      title.textContent = row.name;
      detail.className = "detail";
      item.append(title);
      let warningText = "";
      if (row.start !== undefined) {
        const time = document.createElement("span");
        const endDay = day.format(row.start) === day.format(row.end) ? "" : day.format(row.end) + ", ";
        time.textContent = startLabel(row.start) + ", " + clock.format(row.start) + "–" + endDay + clock.format(row.end);
        item.dataset.source = row.unverified ? "unverified" : row.grid > energyTolerance ? "grid" : row.battery > energyTolerance ? "battery" : "solar";
        if (row.unverified) {
          detail.textContent = "Full energy mix and cost unavailable (forecast coverage incomplete).";
        } else {
          const mix = [[row.solar, "surplus solar"], [row.divertedSolar, "solar diverted from charging"],
            [row.battery, "battery"], [row.grid, "grid"]]
            .filter(([energy]) => energy > energyTolerance)
            .map(([energy, source]) => kwh(energy) + " " + source);
          detail.textContent = mix.join(" · ");
          const amount = document.createElement("small");
          amount.textContent = "During run · " + cost(row.cost);
          detail.append(amount);
        }
        warningText = preferenceWarning(row, number);
        item.append(time);
      } else {
        item.dataset.source = "unplaced";
        if (row.problem) detail.textContent = row.problem;
        else if (row.search) detail.textContent = "Home Assistant will look for a suitable time after you save.";
        else if (row.repeat) detail.textContent = "Home Assistant will pick a start time on each selected day.";
        else if (mustRun(row)) {
          detail.textContent = row.timing === "flexible" && row.deadline === null ?
            "Choose a finish time for Must run." : "The requested run cannot fit within known constraints.";
          if (row.deadline !== null || row.timing === "fixed") warningText = blockedWarning;
        } else detail.textContent = row.duration > last.end - intervals[0].from ?
          "The forecast is too short for this duration." : reserved.length ?
            "No time in the forecast fits this load. Other scheduled loads may be limiting the available times. Try a later finish time or a shorter run." :
            "No time in the forecast fits this load. Try a later finish time or a shorter run.";
      }
      item.append(detail);
      if (warningText) {
        const warning = document.createElement("div");
        warning.className = "must-run-warning";
        warning.textContent = "⚠ " + warningText;
        item.append(warning);
      }
      list.append(item);
    }

    this._get("horizon").textContent = "Forecast through " + startLabel(last.end) + ", " + clock.format(last.end);
    const totals = this._get("totals");
    const incomplete = schedule.jobs.some(job => job.unverified);
    totals.hidden = !schedule.jobs.some(job => job.start < last.end && job.end > intervals[0].from);
    totals.textContent = (incomplete ? "Forecast-covered portion only · " : "") +
      "Estimated added cost " + cost(schedule.totalCost) +
      " · Extra grid cost " + cost(schedule.gridCost) + " · Feed-in impact " + cost(schedule.exportImpact);
    const notes = [];
    if (reserved.length) notes.push("Suggested times take other scheduled loads into account.");
    if (schedule.jobs.length && schedule.missedChargeTarget) {
      const { at, target, soc } = schedule.missedChargeTarget;
      notes.push("Battery forecast at " + startLabel(at) + ", " + clock.format(at) + " is " +
        number.format(soc) + "% vs a planned " + number.format(target) + "% charge target.");
    }
    if (schedule.afterRunGrid >= 0.005) {
      notes.push(kwh(schedule.afterRunGrid) + " extra grid use after the last run (" + cost(schedule.afterRunCost) + ").");
    }
    const baselineDeficit = schedule.baselineDeficit ?? 0;
    if (battery && schedule.jobs.length && schedule.deficit - baselineDeficit >= 0.005) {
      const endSoc = Math.max(0, last.endSoc - schedule.deficit / battery.capacity * 100);
      const baselineSoc = Math.max(0, last.endSoc - baselineDeficit / battery.capacity * 100);
      notes.push("Battery at forecast end " + number.format(endSoc) + "% with these loads (" +
        number.format(baselineSoc) + "% before adding them).");
      if (endSoc <= last.minSoc + 0.1) notes.push("Further grid use beyond the forecast is possible.");
    }
   if (!battery && loads.some(row => row.source !== "solar")) {
      notes.push("Battery discharge and charging diversion require capacity and state-of-charge forecast data.");
    }
    const effects = this._get("effects");
    effects.hidden = !notes.length;
    effects.textContent = notes.join(" ");
  }
}

if (!customElements.get(cardType)) {
  customElements.define(cardType, EmFlexibleLoadSchedulerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: cardType,
    name: "Flexible Load Scheduler",
    description: "Plan and schedule loads using the Energy Manager forecast.",
  });
}
