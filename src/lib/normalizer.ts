import type { InputConfig, MeasurementUnit, NormalizedValue, MeasurementQuality } from "./types.js";

const MAX_SAFE_W = 1_000_000_000;

export function normalizeToW(raw: number, unit: "W" | "kW", factor: number, invert: boolean): number {
    let val = raw * factor;
    if (unit === "kW") val *= 1000;
    if (invert) val = -val;
    return val;
}

export function normalizeToKwh(raw: number, unit: "Wh" | "kWh", factor: number): number {
    let val = raw * factor;
    if (unit === "Wh") val /= 1000;
    return val;
}

export function normalizePct(raw: number, factor: number): number {
    return Math.max(0, Math.min(100, raw * factor));
}

function makeUnavailable(note: string, ts: number): NormalizedValue {
    return {
        value: null,
        quality: {
            provenance: "measured",
            availability: "unavailable",
            freshness: "current",
            timestamp: ts,
            note,
        },
    };
}

export function makeMeasured(value: number, ts: number, sourceId?: string): NormalizedValue {
    return {
        value,
        quality: {
            provenance: "measured",
            availability: "available",
            freshness: "current",
            timestamp: ts,
            sourceId,
        },
    };
}

export function makeCalculated(value: number | null, ts: number, note?: string): NormalizedValue {
    if (value === null) {
        return {
            value: null,
            quality: {
                provenance: "calculated",
                availability: "unavailable",
                freshness: "current",
                timestamp: ts,
                note: note ?? "input unavailable",
            },
        };
    }
    return {
        value,
        quality: {
            provenance: "calculated",
            availability: "available",
            freshness: "current",
            timestamp: ts,
            note,
        },
    };
}

export function makeEstimated(value: number | null, ts: number, note?: string): NormalizedValue {
    if (value === null) {
        return {
            value: null,
            quality: {
                provenance: "estimated",
                availability: "unavailable",
                freshness: "current",
                timestamp: ts,
                note: note ?? "input unavailable",
            },
        };
    }
    return {
        value,
        quality: {
            provenance: "estimated",
            availability: "available",
            freshness: "current",
            timestamp: ts,
            note,
        },
    };
}

export function normalizeRawState(
    state: ioBroker.State | null | undefined,
    config: Pick<InputConfig, "unit" | "factor" | "invert" | "maxAgeSeconds" | "minValue" | "maxValue">,
    nowMs: number,
): NormalizedValue {
    if (!state) return makeUnavailable("state not found", nowMs);

    const raw = state.val;
    if (raw === null || raw === undefined) return makeUnavailable("null value", nowMs);
    if (typeof raw !== "number") {
        const parsed = parseFloat(String(raw));
        if (isNaN(parsed)) return makeUnavailable(`non-numeric: ${String(raw)}`, nowMs);
        return normalizeRawState({ ...state, val: parsed }, config, nowMs);
    }
    if (!isFinite(raw)) return makeUnavailable(`non-finite: ${raw}`, nowMs);

    const ts = state.ts ?? nowMs;
    const ageMs = nowMs - ts;
    const maxAgeMs = (config.maxAgeSeconds ?? 300) * 1000;
    const stale = ageMs > maxAgeMs;

    const unit = config.unit as MeasurementUnit;
    let value: number;

    if (unit === "W" || unit === "kW") {
        value = normalizeToW(raw, unit as "W" | "kW", config.factor ?? 1, config.invert ?? false);
    } else if (unit === "Wh" || unit === "kWh") {
        value = normalizeToKwh(raw, unit as "Wh" | "kWh", config.factor ?? 1);
    } else {
        value = raw * (config.factor ?? 1);
    }

    if (!isFinite(value) || Math.abs(value) > MAX_SAFE_W) {
        return makeUnavailable(`implausible value after conversion: ${value}`, nowMs);
    }

    if (config.minValue !== undefined && value < config.minValue) {
        return makeUnavailable(`below min ${config.minValue}: ${value}`, nowMs);
    }
    if (config.maxValue !== undefined && value > config.maxValue) {
        return makeUnavailable(`above max ${config.maxValue}: ${value}`, nowMs);
    }

    const quality: MeasurementQuality = {
        provenance: "measured",
        availability: "available",
        freshness: stale ? "stale" : "current",
        timestamp: ts,
        sourceId: undefined,
    };

    return { value, quality };
}

export function sumAvailable(values: NormalizedValue[], nowMs: number): NormalizedValue {
    const available = values.filter((v) => v.value !== null);
    if (available.length === 0) {
        return makeUnavailable("no values available", nowMs);
    }
    let sum = 0;
    let anyEstimated = false;
    let anyStale = false;
    for (const v of available) {
        sum += v.value!;
        if (v.quality.provenance === "estimated") anyEstimated = true;
        if (v.quality.freshness === "stale") anyStale = true;
    }
    const result = anyEstimated ? makeEstimated(sum, nowMs) : makeCalculated(sum, nowMs);
    if (anyStale && result.quality) result.quality.freshness = "stale";
    return result;
}

export function clampNonNegative(val: NormalizedValue): NormalizedValue {
    if (val.value === null) return val;
    return { ...val, value: Math.max(0, val.value) };
}
