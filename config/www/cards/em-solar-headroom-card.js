const cardType = "em-solar-headroom-card";
const defaultEntity = "sensor.energy_manager_plan";
const defaultCapacityEntity = "input_number.battery_capacity";
const minute = 60000;
const hour = 60 * minute;
const tolerance = 1e-7;

function finite(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegative(value) {
  const number = finite(value);
  return number !== null && number >= 0 ? number : null;
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
    const totalLoad = nonnegative(inputs?.total_load_kw) ?? (house !== null && ev !== null ? house + ev : null);
    const charge = nonnegative(expected?.battery_charge_kw);
    const discharge = nonnegative(expected?.battery_discharge_kw);
    const gridImport = nonnegative(expected?.grid_import_kw);
    const gridExport = nonnegative(expected?.grid_export_kw);
    if ([solar, totalLoad, charge, discharge, gridImport, gridExport].includes(null)) continue;
    const headroom = gridImport > 0.005 ? 0 : Math.max(0, Math.min(solar - totalLoad - charge, gridExport - discharge));
    const controls = row.setpoints;
    const constraints = row.constraints;
    const forcedExport = row.mode === "FORCED_EXPORT" || nonnegative(controls?.force_export_kw) > 0;
    const canSelfConsume = row.mode === "SELF_CONSUMPTION" && !forcedExport && nonnegative(controls?.force_charge_kw) === 0;
    const flexibleSolarCharge = canSelfConsume && gridImport <= 0.005 && discharge <= 0.005 ?
      Math.min(charge, Math.max(0, solar - totalLoad)) : 0;
    const minSoc = nonnegative(constraints?.min_soc_pct);
    const reserve = nonnegative(controls?.soc_reserve_pct);
    const startSoc = nonnegative(inputs?.soc_pct_start);
    const endSoc = nonnegative(expected?.soc_pct_end);
    const tapered = forcedExport && discharge > 0 && gridExport + 0.005 < nonnegative(controls?.force_export_kw);
    intervals.push({
      start, end, headroom, flexibleSolarCharge, charge, discharge, gridExport, startSoc, endSoc,
      buyPrice: finite(inputs?.buy_price), sellPrice: finite(inputs?.sell_price), minSoc,
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

function applianceSolar(interval, power, hours) {
  const fromExport = Math.min(power, interval.headroom);
  const fromCharge = Math.min(power - fromExport, interval.flexibleSolarCharge);
  return { fromExport: fromExport * hours, fromCharge: fromCharge * hours };
}

function scoreWindow(intervals, start, duration, power) {
  const end = start + duration;
  const required = power * duration / hour;
  let cursor = start;
  let covered = 0;
  let surplusSolar = 0;
  let shiftedCharge = 0;
  let exportImpact = 0;
  let allPricesKnown = true;
  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start > cursor) return null;
    const segmentEnd = Math.min(interval.end, end);
    const { fromExport, fromCharge } = applianceSolar(interval, power, (segmentEnd - cursor) / hour);
    surplusSolar += fromExport;
    covered += fromExport + fromCharge;
    shiftedCharge += fromCharge;
    if (fromExport > tolerance) {
      if (interval.sellPrice === null) allPricesKnown = false;
      else exportImpact += fromExport * interval.sellPrice;
    }
    cursor = segmentEnd;
    if (cursor === end) return {
      start, end, required, covered: Math.min(required, covered), surplusSolar, shiftedCharge,
      fullSolar: required - covered <= tolerance,
      exportImpact: allPricesKnown ? exportImpact : null,
    };
  }
  return null;
}

function replayWindow(intervals, window, power, battery) {
  if (!battery.capacity) return null;
  const { start, end } = window;
  const { capacity, chargeEfficiency, dischargeEfficiency } = battery;
  let cursor = start;
  let deficit = 0;
  let fromBattery = 0;
  let gridDuring = 0;
  let gridLater = 0;
  let gridLaterCost = 0;
  let gridAdded = 0;
  let gridCost = 0;
  let exportImpact = 0;
  let plannedMin = 100;
  let replayMin = 100;
  let plannedEndSoc = null;
  let endMinSoc = null;
  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start > cursor || [interval.startSoc, interval.endSoc, interval.floor].some(soc => soc === null || soc > 100)) return null;
    const socAt = ts => interval.startSoc + (interval.endSoc - interval.startSoc) *
      (ts - interval.start) / (interval.end - interval.start);
    while (cursor < interval.end) {
      const running = cursor < end;
      const segmentEnd = running ? Math.min(interval.end, end) : interval.end;
      const hours = (segmentEnd - cursor) / hour;
      const baseStart = socAt(cursor);
      const baseEnd = socAt(segmentEnd);
      plannedEndSoc = baseEnd;
      endMinSoc = interval.minSoc;
      const floor = Math.min(baseEnd, interval.floor);
      plannedMin = Math.min(plannedMin, baseStart, baseEnd);
      replayMin = Math.min(replayMin, Math.max(0, baseStart - deficit / capacity * 100));
      const shortage = Math.max(0, deficit - capacity * (baseEnd - floor) / 100);
      const lostDischarge = Math.min(interval.discharge * hours, shortage * dischargeEfficiency);
      deficit = Math.max(0, deficit - lostDischarge / dischargeEfficiency);
      const exported = interval.gridExport * hours;
      let lostExport = Math.min(exported, lostDischarge);
      let extraGrid = lostDischarge - lostExport;
      const solarExport = interval.headroom * hours;
      const { fromExport, fromCharge } = applianceSolar(interval, running ? power : 0, hours);
      deficit += fromCharge * chargeEfficiency;
      const remainingCharge = Math.max(0, interval.charge * hours - fromCharge);
      let applianceRemainder = running ? Math.max(0, power * hours - fromExport - fromCharge) : 0;
      const plannedBatteryExport = Math.min(interval.discharge * hours - lostDischarge,
        Math.max(0, exported - lostExport - solarExport));
      const divertedBattery = Math.min(applianceRemainder, plannedBatteryExport);
      applianceRemainder -= divertedBattery;
      lostExport += fromExport + divertedBattery;
      let extraBattery = 0;
      if (interval.canSelfConsume && remainingCharge <= 0.005 * hours && applianceRemainder > tolerance) {
        if (interval.dischargeLimit === null) return null;
        const reserve = Math.max(interval.floor, interval.restrictedBelow);
        const storedAvailable = Math.max(0, capacity * (baseEnd - reserve) / 100 - deficit);
        const powerAvailable = Math.max(0, (interval.dischargeLimit - interval.discharge) * hours + lostDischarge);
        extraBattery = Math.min(applianceRemainder, storedAvailable * dischargeEfficiency, powerAvailable);
        deficit += extraBattery / dischargeEfficiency;
      }
      const applianceGrid = Math.max(0, applianceRemainder - extraBattery);
      const spareSolar = Math.max(0, solarExport - fromExport);
      if (interval.canSelfConsume && interval.discharge <= 0.005 &&
          deficit > tolerance && spareSolar > tolerance && interval.chargeLimit !== null) {
        const chargeRoom = Math.max(0, interval.chargeLimit * hours - remainingCharge);
        const refill = Math.min(spareSolar, chargeRoom, deficit / chargeEfficiency);
        deficit = Math.max(0, deficit - refill * chargeEfficiency);
        lostExport += refill;
      }
      fromBattery += divertedBattery + extraBattery;
      if (running) gridDuring += applianceGrid;
      extraGrid += applianceGrid;
      gridAdded += extraGrid;
      if (extraGrid > tolerance) {
        const cost = interval.buyPrice === null ? null : extraGrid * interval.buyPrice;
        gridCost = gridCost === null || cost === null ? null : gridCost + cost;
        if (!running) {
          gridLater += extraGrid;
          gridLaterCost = gridLaterCost === null || cost === null ? null : gridLaterCost + cost;
        }
      }
      if (lostExport > tolerance && exportImpact !== null) {
        exportImpact = interval.sellPrice === null ? null : exportImpact + lostExport * interval.sellPrice;
      }
      replayMin = Math.min(replayMin, Math.max(0, baseEnd - deficit / capacity * 100));
      cursor = segmentEnd;
    }
  }
  if (cursor < end || plannedEndSoc === null) return null;
  const replayEndSoc = Math.max(0, plannedEndSoc - deficit / capacity * 100);
  return {
    fromBattery, gridDuring, gridLater, gridLaterCost, gridAdded, gridCost, exportImpact,
    totalCost: gridCost === null || exportImpact === null ? null : gridCost + exportImpact,
    plannedMin, replayMin, plannedEndSoc, replayEndSoc, endMinSoc, deficit, through: cursor,
  };
}

function bestWindow(intervals, earliest, minutes, power, battery) {
  const duration = minutes * minute;
  const starts = new Set([earliest]);
  for (const interval of intervals) {
    starts.add(interval.start);
    starts.add(interval.end);
    starts.add(interval.start - duration);
    starts.add(interval.end - duration);
  }
  let best = null;
  for (const start of [...starts].filter(value => value >= earliest).sort((a, b) => a - b)) {
    const candidate = scoreWindow(intervals, start, duration, power);
    if (!candidate) continue;
    const replay = replayWindow(intervals, candidate, power, battery);
    candidate.replay = replay;
    candidate.totalCost = replay?.totalCost ?? (candidate.fullSolar && candidate.shiftedCharge <= tolerance ? candidate.exportImpact : null);
    candidate.endDeficit = replay?.deficit ?? null;
    if (!best) { best = candidate; continue; }
    const surplusDifference = candidate.surplusSolar - best.surplusSolar;
    if (surplusDifference > tolerance) { best = candidate; continue; }
    if (surplusDifference < -tolerance) continue;
    const candidateCost = candidate.totalCost ?? Infinity;
    const bestCost = best.totalCost ?? Infinity;
    if (candidateCost < bestCost - tolerance) { best = candidate; continue; }
    if (candidateCost > bestCost + tolerance) continue;
    if (candidate.shiftedCharge < best.shiftedCharge - tolerance) { best = candidate; continue; }
    if (candidate.shiftedCharge > best.shiftedCharge + tolerance) continue;
    const candidateDeficit = candidate.endDeficit ?? Infinity;
    const bestDeficit = best.endDeficit ?? Infinity;
    if (candidateDeficit < bestDeficit - tolerance) best = candidate;
  }
  return best;
}

class EmSolarHeadroomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { --headroom-muted: var(--secondary-text-color, #626974); --headroom-accent: var(--energy-solar-color, #d89013); --headroom-border: var(--divider-color, #d9dde2); color: var(--primary-text-color, #202329); padding: 16px; container-type: inline-size; }
        [hidden] { display: none !important; }
        h2, h3, p { margin: 0; }
        header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        ha-icon { --mdc-icon-size: 20px; color: var(--headroom-accent); }
        h2 { font-size: 16px; line-height: 1.25; font-weight: 600; }
        .controls, .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
        .controls { margin: 0 0 12px; }
        label, .metric span, #status, #note, #result-label { font-size: 12px; color: var(--headroom-muted); line-height: 1.35; }
        label { display: grid; gap: 4px; min-width: 0; }
        input { box-sizing: border-box; border-radius: 7px; border: 1px solid var(--headroom-border); background: var(--card-background-color, transparent); color: var(--primary-text-color, #202329); font: inherit; font-size: 16px; min-width: 0; width: 100%; padding: 6px 8px; }
        input:focus-visible { outline: 2px solid var(--primary-color, #007f79); outline-offset: 1px; }
        #result { --coverage-color: #d97706; --coverage-track: var(--divider-color, #8885); }
        #result[data-coverage="full"] { --coverage-color: #eab308; }
        #result[data-coverage="mostly-grid"], #result[data-coverage="none"] { --coverage-color: #dc2626; }
        #result[data-coverage="none"] { --coverage-track: var(--coverage-color); }
        .window { border-radius: 8px; border-left: 3px solid var(--coverage-color); background: color-mix(in srgb, var(--coverage-color) 9%, transparent); padding: 8px 10px; margin-bottom: 8px; }
        h3 { font-size: 15px; line-height: 1.35; margin-top: 2px; }
        .metric { padding: 8px; min-width: 0; border-radius: 8px; background: color-mix(in srgb, var(--headroom-muted) 9%, transparent); }
        .metric strong { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
        .metric span { display: block; margin-top: 3px; }
        progress { display: block; width: 100%; height: 6px; margin: 8px 0; appearance: none; border: 0; border-radius: 3px; overflow: hidden; background: var(--coverage-track); }
        progress::-webkit-progress-bar { background: var(--coverage-track); }
        progress::-webkit-progress-value { background: var(--coverage-color); }
        progress::-moz-progress-bar { background: var(--coverage-color); }
        .battery-impact { --battery-impact-color: var(--warning-color, #d89013); margin: 8px 0; padding: 8px 10px; border-inline-start: 3px solid var(--battery-impact-color); border-radius: 8px; background: color-mix(in srgb, var(--battery-impact-color) 12%, transparent); }
        .battery-impact p { margin-top: 3px; }
        #note { margin-top: 8px; }
        @container (max-width: 225px) { .metric strong { font-size: 14px; } }
      </style>
      <ha-card>
        <header><ha-icon icon="mdi:solar-power-variant" aria-hidden="true"></ha-icon><h2 id="title"></h2></header>
        <div class="controls">
          <label>Appliance power (kW)<input id="power" type="number" min="0.1" step="0.1" inputmode="decimal" required></label>
          <label>Run time (minutes)<input id="duration" type="number" min="1" step="1" inputmode="numeric" required></label>
        </div>
        <p id="status" role="status"></p>
        <section id="result" aria-labelledby="result-label" hidden>
          <div class="window"><p id="result-label"></p><h3 id="window"></h3></div>
          <div class="metrics">
            <div class="metric"><strong id="coverage"></strong><span id="energy"></span></div>
            <div class="metric"><strong id="battery"></strong><span>Battery during run</span></div>
            <div class="metric"><strong id="grid"></strong><span>Grid during run</span></div>
            <div class="metric"><strong id="grid-cost"></strong><span id="grid-cost-label"></span></div>
            <div class="metric"><strong id="money"></strong><span id="money-label"></span></div>
            <div class="metric"><strong id="total-cost"></strong><span>Cost through forecast</span></div>
          </div>
          <progress id="bar" max="1" aria-label="Forecast solar coverage"></progress>
          <div id="later-grid-impact" class="battery-impact" role="status" hidden><strong id="later-grid-impact-title"></strong><p id="later-grid-impact-detail"></p></div>
          <div id="battery-impact" class="battery-impact" role="status" hidden><strong>Load lowers the forecast battery level</strong><p id="battery-impact-detail"></p></div>
          <p id="note"></p>
        </section>
      </ha-card>`;
    for (const id of ["power", "duration"]) this.shadowRoot.getElementById(id).addEventListener("input", () => this._render());
  }

  static getStubConfig() { return { entity: defaultEntity }; }

  setConfig(config = {}) {
    const power = finite(config.default_power_kw ?? 2);
    const duration = finite(config.default_duration_minutes ?? 120);
    const maxAge = finite(config.max_plan_age_minutes ?? 20);
    if (!(power >= 0.1)) throw new Error("default_power_kw must be at least 0.1");
    if (!Number.isInteger(duration) || duration < 1) throw new Error("default_duration_minutes must be a positive whole number");
    if (!(maxAge > 0)) throw new Error("max_plan_age_minutes must be greater than zero");
    const chargeEfficiency = finite(config.battery_charge_efficiency ?? 0.95);
    const dischargeEfficiency = finite(config.battery_discharge_efficiency ?? 0.95);
    if (!(chargeEfficiency > 0 && chargeEfficiency <= 1 && dischargeEfficiency > 0 && dischargeEfficiency <= 1)) throw new Error("Battery efficiencies must be greater than zero and at most 1");
    this._config = {
      entity: config.entity ?? defaultEntity,
      capacityEntity: config.battery_capacity_entity ?? defaultCapacityEntity,
      capacity: nonnegative(config.battery_capacity_kwh),
      chargeEfficiency, dischargeEfficiency,
      name: config.name ?? "Solar Headroom", maxAge: maxAge * minute,
    };
    this.shadowRoot.getElementById("power").value = power;
    this.shadowRoot.getElementById("duration").value = duration;
    this._render();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (!this._config) return;
    const entity = this._config.entity;
    if (!previous || previous.language !== hass?.language || previous.config?.time_zone !== hass?.config?.time_zone ||
        previous.states?.[entity] !== hass?.states?.[entity] ||
        previous.states?.[this._config.capacityEntity] !== hass?.states?.[this._config.capacityEntity]) this._render();
  }

  connectedCallback() { this._timer = setInterval(() => this._render(), minute); this._render(); }
  disconnectedCallback() { clearInterval(this._timer); }
  getCardSize() { return 3; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  _render() {
    if (!this._config) return;
    const { entity, name, maxAge } = this._config;
    const get = id => this.shadowRoot.getElementById(id);
    const set = (id, value) => { get(id).textContent = value; };
    const state = this._hass?.states?.[entity];
    const plan = state?.attributes?.energy_plan;
    const now = Date.now();
    const generated = Date.parse(plan?.meta?.generated_at ?? plan?.summary?.ts);
    const power = finite(get("power").value);
    const minutes = finite(get("duration").value);
    set("title", name);
    const showStatus = message => { set("status", message); get("status").hidden = false; get("result").hidden = true; };
    if (!(power >= 0.1) || !Number.isInteger(minutes) || minutes < 1) { showStatus("Enter at least 0.1 kW and a whole number of minutes."); return; }
    if (!plan || state.state === "unavailable" || state.state === "unknown") { showStatus("Waiting for the Energy Manager plan."); return; }
    if (!Number.isFinite(generated) || now - generated > maxAge || generated - now > minute) { showStatus("Waiting for an up-to-date solar forecast."); return; }
    const earliest = Math.ceil(now / minute) * minute;
    const intervals = extractIntervals(plan.timeline, earliest);
    const configuredCapacity = this._config.capacity;
    const entityCapacity = nonnegative(this._hass.states?.[this._config.capacityEntity]?.state);
    const capacity = configuredCapacity || entityCapacity;
    const battery = { capacity, chargeEfficiency: this._config.chargeEfficiency, dischargeEfficiency: this._config.dischargeEfficiency };
    const best = bestWindow(intervals, earliest, minutes, power, battery);
    if (!best) { showStatus("The forecast doesn’t contain a continuous window this long."); return; }
    const hasSolar = best.covered > tolerance;
    const usesFlexibleCharge = best.shiftedCharge > tolerance;
    const usesSurplusOnly = best.fullSolar && !usesFlexibleCharge;
    const replay = best.replay;
    const locale = this._hass.language || undefined;
    const timeZone = this._hass.config?.time_zone;
    const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone });
    const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone });
    const from = clock.format(best.start);
    const to = clock.format(best.end);
    const date = day.format(best.start);
    const endDate = day.format(best.end);
    const startLabel = date === day.format(now) ? "Today" : date;
    const endLabel = date === endDate ? to : endDate + ", " + to;
    const fraction = best.covered / best.required;
    const displayedFraction = best.fullSolar ? 1 : Math.min(0.99, fraction);
    const percentage = new Intl.NumberFormat(locale, { style: "percent" });
    const energy = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    const amount = replay ? replay.exportImpact : usesFlexibleCharge ? null : best.exportImpact;
    const gridCost = replay?.gridCost ?? (usesSurplusOnly ? 0 : null);
    const totalCost = replay?.totalCost ?? (usesSurplusOnly ? amount : null);
    const cents = amount !== null ? Math.round(Math.abs(amount) * 100) : null;
    const currency = new Intl.NumberFormat(locale, { style: "currency", currency: "AUD", currencyDisplay: "narrowSymbol" });
    get("status").hidden = true;
    const result = get("result");
    result.hidden = false;
    let coverage = hasSolar ? "partial" : "none";
    if (best.fullSolar) coverage = "full";
    else if (replay) coverage = replay.gridDuring >= best.required - tolerance ? "none" : replay.gridDuring - best.required / 2 > tolerance ? "mostly-grid" : "partial";
    result.dataset.coverage = coverage;
    set("result-label", !hasSolar ? "No excess solar · Earliest window" :
      best.fullSolar && best.shiftedCharge <= tolerance ? "Best time to run on surplus solar" :
      best.fullSolar ? "Best time to run on solar" : "Best surplus-solar window");
    set("window", startLabel + ", " + from + " – " + endLabel);
    set("coverage", percentage.format(displayedFraction));
    set("energy", energy.format(best.covered) + " of " + energy.format(best.required) + " kWh from solar");
    get("bar").value = fraction;
    set("money", cents === null ? "—" : currency.format(Math.abs(amount)));
    const tradeOff = amount > 0 ? "Feed-in credit forgone" : "Export charges avoided";
    set("money-label", cents === null ? "Feed-in impact unavailable" : cents ? tradeOff : "Feed-in impact");
    const formatEnergy = value => value === null ? "—" : energy.format(value) + " kWh";
    const formatCost = value => value === null ? "—" : currency.format(value);
    set("battery", formatEnergy(replay?.fromBattery ?? (usesSurplusOnly ? 0 : null)));
    set("grid", formatEnergy(replay?.gridDuring ?? (usesSurplusOnly ? 0 : null)));
    set("grid-cost", formatCost(gridCost));
    const noExtraGrid = usesSurplusOnly || (replay && replay.gridAdded <= tolerance);
    set("grid-cost-label", noExtraGrid ? "No extra grid use forecast" : "Extra grid cost");
    set("total-cost", formatCost(totalCost));
    const endSoc = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
    const batteryEndsLower = replay && replay.plannedEndSoc - replay.replayEndSoc >= 0.1;
    const endsNearMinimum = batteryEndsLower && replay.endMinSoc !== null && replay.replayEndSoc <= replay.endMinSoc + 0.1;
    const laterGridImpact = get("later-grid-impact");
    const showLaterGridImpact = replay?.gridLater >= 0.005;
    laterGridImpact.hidden = !(showLaterGridImpact || endsNearMinimum);
    if (showLaterGridImpact) {
      const cost = replay.gridLaterCost === null ? "Some forecast rates are unavailable." : formatCost(replay.gridLaterCost) + " included in the grid cost above.";
      set("later-grid-impact-title", "Extra grid use after the run");
      set("later-grid-impact-detail", "The battery reserve limits discharge, adding " + formatEnergy(replay.gridLater) + " of forecast grid import after the run. " + cost);
    } else if (endsNearMinimum) {
      set("later-grid-impact-title", "Possible grid use after the forecast");
      set("later-grid-impact-detail", "This run leaves the battery at or near its " + endSoc.format(replay.endMinSoc / 100) +
        " minimum when the forecast ends at " + clock.format(replay.through) + ". Further grid use and cost are outside the forecast.");
    }
    const batteryImpact = get("battery-impact");
    batteryImpact.hidden = !batteryEndsLower;
    if (batteryEndsLower) {
      set("battery-impact-detail", "At forecast end, " + endSoc.format(replay.replayEndSoc / 100) + " with this load vs " +
        endSoc.format(replay.plannedEndSoc / 100) + " planned (" + formatEnergy(replay.deficit) + " lower).");
    }
    if (usesSurplusOnly) {
      set("note", "Uses forecast surplus after house demand, EV and battery charging.");
    } else if (!replay) {
      set("note", capacity ? "Battery and grid impact are unavailable with the current plan data." : "Set the battery capacity to estimate battery and grid impact.");
    } else {
      const charging = usesFlexibleCharge ? formatEnergy(best.shiftedCharge) + " diverted from planned solar charging. " : "";
      const lowest = "Lowest battery SoC " + percentage.format(replay.replayMin / 100) + " · plan " + percentage.format(replay.plannedMin / 100) + ".";
      set("note", charging + lowest + " Through " + day.format(replay.through) + ", " + clock.format(replay.through) + ".");
    }
  }
}

if (!customElements.get(cardType)) {
  customElements.define(cardType, EmSolarHeadroomCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: cardType, name: "Solar Headroom", description: "Best forecast time to run an appliance on surplus solar." });
}
