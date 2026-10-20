"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeToW = normalizeToW;
exports.normalizeToKwh = normalizeToKwh;
exports.normalizePct = normalizePct;
exports.makeMeasured = makeMeasured;
exports.makeCalculated = makeCalculated;
exports.makeEstimated = makeEstimated;
exports.normalizeRawState = normalizeRawState;
exports.sumAvailable = sumAvailable;
exports.clampNonNegative = clampNonNegative;
const MAX_SAFE_W = 1_000_000_000;
function normalizeToW(raw, unit, factor, invert) {
    let val = raw * factor;
    if (unit === "kW")
        val *= 1000;
    if (invert)
        val = -val;
    return val;
}
function normalizeToKwh(raw, unit, factor) {
    let val = raw * factor;
    if (unit === "Wh")
        val /= 1000;
    return val;
}
function normalizePct(raw, factor) {
    return Math.max(0, Math.min(100, raw * factor));
}
function makeUnavailable(note, ts) {
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
function makeMeasured(value, ts, sourceId) {
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
function makeCalculated(value, ts, note) {
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
function makeEstimated(value, ts, note) {
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
function normalizeRawState(state, config, nowMs) {
    if (!state)
        return makeUnavailable("state not found", nowMs);
    const raw = state.val;
    if (raw === null || raw === undefined)
        return makeUnavailable("null value", nowMs);
    if (typeof raw !== "number") {
        const parsed = parseFloat(String(raw));
        if (isNaN(parsed))
            return makeUnavailable(`non-numeric: ${String(raw)}`, nowMs);
        return normalizeRawState({ ...state, val: parsed }, config, nowMs);
    }
    if (!isFinite(raw))
        return makeUnavailable(`non-finite: ${raw}`, nowMs);
    const ts = state.ts ?? nowMs;
    const ageMs = nowMs - ts;
    const maxAgeMs = (config.maxAgeSeconds ?? 300) * 1000;
    const stale = ageMs > maxAgeMs;
    const unit = config.unit;
    let value;
    if (unit === "W" || unit === "kW") {
        value = normalizeToW(raw, unit, config.factor ?? 1, config.invert ?? false);
    }
    else if (unit === "Wh" || unit === "kWh") {
        value = normalizeToKwh(raw, unit, config.factor ?? 1);
    }
    else {
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
    const quality = {
        provenance: "measured",
        availability: "available",
        freshness: stale ? "stale" : "current",
        timestamp: ts,
        sourceId: undefined,
    };
    return { value, quality };
}
function sumAvailable(values, nowMs) {
    const available = values.filter((v) => v.value !== null);
    if (available.length === 0) {
        return makeUnavailable("no values available", nowMs);
    }
    let sum = 0;
    let anyEstimated = false;
    let anyStale = false;
    for (const v of available) {
        sum += v.value;
        if (v.quality.provenance === "estimated")
            anyEstimated = true;
        if (v.quality.freshness === "stale")
            anyStale = true;
    }
    const result = anyEstimated ? makeEstimated(sum, nowMs) : makeCalculated(sum, nowMs);
    if (anyStale && result.quality)
        result.quality.freshness = "stale";
    return result;
}
function clampNonNegative(val) {
    if (val.value === null)
        return val;
    return { ...val, value: Math.max(0, val.value) };
}
//# sourceMappingURL=normalizer.js.map