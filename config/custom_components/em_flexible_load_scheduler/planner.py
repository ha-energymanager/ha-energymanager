"""Server-side forecast replay for approved loads, using epoch seconds."""

from collections.abc import Mapping
from datetime import datetime
from functools import cmp_to_key
from math import inf, isfinite

SOURCES = ("solar", "priority", "battery", "grid")
EPS = 1e-7
ROUNDING_KW = 0.005
BEAM_WIDTH = 12


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        result = float(value)
    except (ValueError, OverflowError):
        return None
    return result if isfinite(result) else None


def nonnegative(value):
    result = number(value)
    return result if result is not None and result >= 0 else None


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def mapping(value):
    return value if isinstance(value, Mapping) else {}


def read_forecast(plan, earliest, now, max_age, capacity):
    plan = mapping(plan)
    generated = timestamp(mapping(plan.get("meta")).get("generated_at")
                          or mapping(plan.get("summary")).get("ts"))
    if generated is None or not -60 <= now - generated <= max_age:
        return [], None
    timeline = plan.get("timeline")
    if not isinstance(timeline, (list, tuple)):
        return [], None
    rows = []
    for raw in timeline:
        if not isinstance(raw, Mapping):
            continue
        start = timestamp(raw.get("ts"))
        minutes = number(raw.get("interval_minutes"))
        if start is None or minutes is None or minutes <= 0 or start + minutes * 60 <= earliest:
            continue
        inputs = mapping(raw.get("inputs"))
        expected = mapping(raw.get("expected"))
        ev = mapping(raw.get("ev"))
        controls = mapping(raw.get("setpoints"))
        constraints = mapping(raw.get("constraints"))
        solar = nonnegative(inputs.get("pv_kw"))
        load = nonnegative(inputs.get("total_load_kw"))
        if load is None:
            house = nonnegative(inputs.get("load_kw"))
            ev_load = nonnegative(inputs.get("ev_charge_kw"))
            if inputs.get("ev_charge_kw") is None:
                ev_load = nonnegative(ev.get("charge_kw"))
            if house is not None and ev_load is not None:
                load = house + ev_load
        charge, discharge, grid_import, grid_export = (
            nonnegative(expected.get(key)) for key in
            ("battery_charge_kw", "battery_discharge_kw", "grid_import_kw", "grid_export_kw")
        )
        if None in (solar, load, charge, discharge, grid_import, grid_export):
            continue
        headroom = max(0, min(solar - load - charge, grid_export - discharge)) if grid_import <= ROUNDING_KW else 0
        force_export = nonnegative(controls.get("force_export_kw")) or 0
        forced = raw.get("mode") == "FORCED_EXPORT" or force_export > 0
        self_consume = (raw.get("mode") == "SELF_CONSUMPTION" and not forced
                        and nonnegative(controls.get("force_charge_kw")) == 0)
        minimum = nonnegative(constraints.get("min_soc_pct"))
        reserve = nonnegative(controls.get("soc_reserve_pct"))
        start_soc = nonnegative(inputs.get("soc_pct_start"))
        end_soc = nonnegative(expected.get("soc_pct_end"))
        tapered = forced and discharge > 0 and grid_export + ROUNDING_KW < force_export
        floor = None if None in (minimum, reserve) else max(
            minimum, reserve, (nonnegative(constraints.get("peak_reserve_pct")) or 0) if forced else 0,
            (end_soc or 0) if tapered else 0,
        )
        flexible = (min(charge, max(0, solar - load - headroom))
                    if self_consume and grid_import <= ROUNDING_KW and discharge <= ROUNDING_KW else 0)
        rows.append(dict(
            start=start, end=start + minutes * 60, headroom=headroom, flexible=flexible,
            charge=charge, discharge=discharge, grid_import=grid_import, grid_export=grid_export,
            start_soc=start_soc, end_soc=end_soc, floor=floor, self_consume=self_consume,
            ev_battery=nonnegative(inputs.get("ev_battery_kw", ev.get("battery_kw"))) or 0,
            import_limit=nonnegative(controls.get("import_limit_kw")),
            target=nonnegative(constraints.get("max_soc_pct")),
            buy=number(inputs.get("buy_price")), sell=number(inputs.get("sell_price")),
            restricted=(nonnegative(constraints.get("battery_discharge_restriction_under_pct")) or 0
                        if constraints.get("battery_discharge_restriction_enabled") is True else 0),
            charge_limit=nonnegative(controls.get("charge_limit_kw")),
            discharge_limit=nonnegative(controls.get("discharge_limit_kw")),
        ))

    intervals = []
    cursor = max(earliest, min((row["start"] for row in rows), default=earliest))
    for row in sorted(rows, key=lambda row: row["start"]):
        if row["end"] <= cursor:
            continue
        if row["start"] > cursor:
            break
        intervals.append(dict(row, begin=cursor))
        cursor = row["end"]
    if not capacity or any(row[key] is None or row[key] > 100 for row in intervals
                           for key in ("start_soc", "end_soc", "floor")):
        capacity = None
    return intervals, capacity


def add_cost(total, energy, rate):
    if energy <= EPS:
        return total
    return None if total is None or rate is None else total + energy * rate


def replay(intervals, jobs, capacity, charge_eff, discharge_eff, report_job=None):
    """Apply the card's battery, reserve, tariff and import-limit model."""
    ordered = sorted(jobs, key=lambda job: (not job.get("reserved", False),
                                            SOURCES.index(job["source"]), job["id"]))
    deficit = protected = grid = solar = 0
    grid_cost = export_cost = 0
    mix = dict(solar=0, diverted=0, battery=0, grid=0) if report_job is not None else None
    for row in intervals:
        end, begin = row["end"], row["begin"]
        active = [job for job in ordered if job["start"] < end and job["end"] > begin]
        if not active and deficit <= EPS:
            continue
        cuts = {begin, end}
        for job in active:
            cuts.update((max(begin, job["start"]), min(end, job["end"])))
        bounds = sorted(cuts)
        for start, stop in zip(bounds, bounds[1:]):
            hours = (stop - start) / 3600
            lost = discharge = 0
            if capacity:
                base = row["start_soc"] + ((row["end_soc"] - row["start_soc"])
                                           * (stop - row["start"]) / (end - row["start"]))
                floor = min(base, row["floor"])
                lost = min(row["discharge"] * hours,
                           max(0, deficit - capacity * (base - floor) / 100) * discharge_eff)
                if lost > max(0, row["discharge"] - row["ev_battery"]) * hours + EPS:
                    return None
                if lost > EPS:
                    deficit -= lost / discharge_eff
                if row["self_consume"] and row["charge"] <= ROUNDING_KW and row["discharge_limit"] is not None:
                    reserve = max(row["floor"], row["restricted"])
                    usable = max(0, (base - reserve) * capacity / 100 - deficit)
                    room = max(0, (row["discharge_limit"] - row["discharge"]) * hours + lost)
                    discharge = min(usable * discharge_eff, room)
            export = min(lost, row["grid_export"] * hours)
            extra_grid = lost - export
            surplus = row["headroom"] * hours
            flexible = row["flexible"] * hours if capacity else 0
            diverted_total = 0
            for job in active:
                if job["start"] >= stop or job["end"] <= start:
                    continue
                demand = job["power"] * hours
                direct = min(surplus, demand)
                surplus -= direct
                diverted = min(flexible, demand - direct) if job["source"] == "priority" else 0
                flexible -= diverted
                diverted_total += diverted
                stored = min(discharge, demand - direct) if job["source"] in ("battery", "grid") else 0
                discharge -= stored
                imported = max(0, demand - direct - diverted - stored)
                if imported > EPS and job["source"] != "grid":
                    return None
                if stored > EPS:
                    deficit += stored / discharge_eff
                if mix is not None and job["id"] == report_job:
                    mix["solar"] += direct
                    mix["diverted"] += diverted
                    mix["battery"] += stored
                    mix["grid"] += imported
                solar += direct + diverted
                extra_grid += imported
                export += direct
            if diverted_total > EPS:
                deferred = diverted_total * charge_eff
                deficit += deferred
                protected += deferred
            if (capacity and deficit > EPS and row["self_consume"]
                    and row["discharge"] <= ROUNDING_KW and row["charge_limit"] is not None):
                room = max(0, (row["charge_limit"] - row["charge"]) * hours + diverted_total)
                refill = min(surplus, room, deficit / charge_eff)
                deficit = max(0, deficit - refill * charge_eff)
                export += refill
            protected = min(protected, deficit)
            if (capacity and stop == end and row["charge"] > ROUNDING_KW and row["target"] is not None
                    and row["end_soc"] >= row["target"] - 0.05):
                shortfall = max(0, (base - row["target"] + 0.05) * capacity / 100)
                if deficit - protected > shortfall:
                    return None
            if (row["import_limit"] is not None
                    and extra_grid > max(0, row["import_limit"] - row["grid_import"]) * hours + EPS):
                return None
            grid += extra_grid
            grid_cost = add_cost(grid_cost, extra_grid, row["buy"])
            export_cost = add_cost(export_cost, export, row["sell"])
    total_cost = None if grid_cost is None or export_cost is None else grid_cost + export_cost
    if mix is not None:
        return dict(mix=mix, total_cost=total_cost, grid_cost=grid_cost, export_cost=export_cost,
                    grid=grid, deficit=deficit)
    return total_cost, grid, deficit, -solar


def edit_impact(intervals, job, reserved, capacity, charge_eff, discharge_eff):
    start = job["start"]
    end = start + job["duration"]
    window = dict(job, end=end)
    if (not intervals or start < intervals[0]["begin"] or end > intervals[-1]["end"]
            or overlaps(window, reserved)):
        return None
    args = capacity, charge_eff, discharge_eff
    baseline = replay(intervals, reserved, *args, report_job=job["id"])
    scenario = replay(intervals, [*reserved, window], *args, report_job=job["id"])
    if baseline is None or scenario is None:
        return None
    mix = scenario.pop("mix")
    changes = {key: scenario[key] - baseline[key] if None not in (scenario[key], baseline[key]) else None
               for key in scenario}
    if not capacity:
        changes["deficit"] = None
    return dict(mix=mix, **changes)


def possible_starts(intervals, job, placements=()):
    duration = job["duration"]
    earliest = intervals[0]["begin"]
    latest = min(job["deadline"], intervals[-1]["end"]) - duration
    starts = {earliest, latest}
    for row in intervals:
        starts.update((row["begin"], row["end"] - duration))
    for placement in placements:
        starts.update((placement["start"], placement["end"], placement["start"] - duration,
                       placement["end"] - duration))
    return sorted(start for start in starts if earliest <= start <= latest)


def overlaps(candidate, placements):
    targets = {candidate["start_automation"], candidate["stop_automation"]} - {""}
    return any(targets.intersection((job["start_automation"], job["stop_automation"]))
               and candidate["start"] < job["end"] and candidate["end"] > job["start"]
               for job in placements)


def recommend(intervals, jobs, reserved, capacity, charge_eff, discharge_eff):
    if not intervals or not jobs:
        return {}

    def evaluate(placements):
        return replay(intervals, placements, capacity, charge_eff, discharge_eff)

    def window(job, start):
        return dict(job, start=start, end=start + job["duration"])

    def compare(a, b):
        left, left_places = a
        right, right_places = b
        if len(left_places) != len(right_places):
            return len(right_places) - len(left_places)
        if (left[0] is None) != (right[0] is None):
            return 1 if left[0] is None else -1
        for x, y in zip(left, right, strict=True):
            if abs((x or 0) - (y or 0)) > EPS:
                return -1 if (x or 0) < (y or 0) else 1
        left_times = [job["start"] for job in left_places]
        right_times = [job["start"] for job in right_places]
        left_key = max((job["end"] for job in left_places), default=0), sum(left_times), left_times
        right_key = max((job["end"] for job in right_places), default=0), sum(right_times), right_times
        return (left_key > right_key) - (left_key < right_key)

    candidates = []
    for job in jobs:
        known = {}
        for start in possible_starts(intervals, job, reserved):
            candidate = window(job, start)
            result = None if overlaps(candidate, reserved) else evaluate([*reserved, candidate])
            if result is not None:
                known[start] = result
        candidates.append((job, known))
    candidates.sort(key=lambda pair: (len(pair[1]) or inf, pair[0]["deadline"],
                                      SOURCES.index(pair[0]["source"]), -pair[0]["duration"], pair[0]["id"]))
    empty = ((None, 0, 0, 0), [])
    beam = [empty]
    for job, known in candidates:
        alternatives = list(beam)
        seen = set()
        for _, placed in beam:
            starts = possible_starts(intervals, job, [*reserved, *placed]) if placed else known
            for start in starts:
                candidate = window(job, start)
                if overlaps(candidate, [*reserved, *placed]):
                    continue
                result = evaluate([*reserved, *placed, candidate]) if placed else known[start]
                if result is not None:
                    placements = [*placed, candidate]
                    key = tuple((item["id"], item["start"]) for item in placements)
                    if key not in seen:
                        seen.add(key)
                        alternatives.append((result, placements))
        beam = sorted(alternatives, key=cmp_to_key(compare))[:BEAM_WIDTH]
        if empty not in beam:
            beam.append(empty)
    return {job["id"]: job["start"] for job in beam[0][1]}
