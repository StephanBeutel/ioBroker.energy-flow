"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculatePowerBalance = calculatePowerBalance;
const normalizer_js_1 = require("./normalizer.js");
function makeUnavailable(note, ts) {
    return {
        value: null,
        quality: {
            provenance: "calculated",
            availability: "unavailable",
            freshness: "current",
            timestamp: ts,
            note,
        },
    };
}
function calculatePowerBalance(inputs) {
    const { solar, battery, grid, houseDirect, ev, nowMs } = inputs;
    // houseCalculated = solar + grid + battery (all positive into house)
    // solar: always non-negative
    // grid: positive = import
    // battery: positive = discharging (positive contribution to house)
    const houseCalcParts = [];
    if (solar.value !== null)
        houseCalcParts.push((0, normalizer_js_1.clampNonNegative)(solar));
    if (grid.value !== null)
        houseCalcParts.push(grid);
    if (battery.value !== null)
        houseCalcParts.push(battery);
    const houseCalculated = houseCalcParts.length >= 2
        ? (0, normalizer_js_1.sumAvailable)(houseCalcParts, nowMs)
        : makeUnavailable("insufficient inputs for balance", nowMs);
    // If houseCalculated is negative (e.g. big export + charging), clamp to 0
    const houseCalcClamped = houseCalculated.value !== null
        ? { ...houseCalculated, value: Math.max(0, houseCalculated.value) }
        : houseCalculated;
    // Discrepancy between measured and calculated house power
    let balanceDiscrepancy;
    if (houseDirect.value !== null && houseCalcClamped.value !== null) {
        balanceDiscrepancy = (0, normalizer_js_1.makeCalculated)(houseDirect.value - houseCalcClamped.value, nowMs);
    }
    else {
        balanceDiscrepancy = makeUnavailable("missing house or balance", nowMs);
    }
    // Choose best house value: prefer direct measurement
    const house = houseDirect.value !== null ? houseDirect : houseCalcClamped;
    // Site consumption = house + ev (if ev is NOT already in house)
    let siteConsumption;
    let houseExcludingEv;
    if (inputs.evConfig.enabled && ev.value !== null) {
        if (inputs.evConfig.includedInHousehold) {
            // EV is already counted in house measurement
            siteConsumption = house;
            if (house.value !== null) {
                const remaining = house.value - ev.value;
                houseExcludingEv = (0, normalizer_js_1.makeCalculated)(Math.max(0, remaining), nowMs);
                // conflict if ev > house beyond tolerance
                if (remaining < -inputs.balanceToleranceW) {
                    houseExcludingEv = {
                        ...houseExcludingEv,
                        quality: {
                            ...houseExcludingEv.quality,
                            note: `CONFLICT: EV ${ev.value}W > house ${house.value}W`,
                        },
                    };
                }
            }
            else {
                houseExcludingEv = makeUnavailable("house unavailable", nowMs);
            }
        }
        else {
            // EV is separate; add to house for site consumption
            siteConsumption = house.value !== null
                ? (0, normalizer_js_1.makeCalculated)(house.value + ev.value, nowMs)
                : makeUnavailable("house unavailable", nowMs);
            houseExcludingEv = house;
        }
    }
    else {
        siteConsumption = house;
        houseExcludingEv = house;
    }
    // Battery status
    let batteryStatus = "unavailable";
    if (inputs.batteryConfig.enabled && battery.value !== null) {
        const IDLE_THRESHOLD = 10;
        if (battery.value > IDLE_THRESHOLD)
            batteryStatus = "discharging";
        else if (battery.value < -IDLE_THRESHOLD)
            batteryStatus = "charging";
        else
            batteryStatus = "idle";
    }
    // EV status
    let evStatus = "unavailable";
    if (inputs.evConfig.enabled && ev.value !== null) {
        const { chargingThresholdW, chargingHysteresisW } = inputs.evConfig;
        evStatus = ev.value >= (chargingThresholdW ?? 100) ? "charging" : "idle";
        void chargingHysteresisW;
    }
    const power = {
        solar: (0, normalizer_js_1.clampNonNegative)(solar),
        battery,
        grid,
        house,
        houseCalculated: houseCalcClamped,
        balanceDiscrepancyW: balanceDiscrepancy,
        evCharging: ev,
        siteConsumption,
        houseExcludingEv,
        batterySoc: makeUnavailable("not set here", nowMs),
        batteryStatus,
        evStatus,
    };
    return { power };
}
//# sourceMappingURL=powerBalance.js.map