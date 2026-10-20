import type {
    PowerState,
    NormalizedValue,
    BatteryConfig,
    EvConfig,
} from "./types.js";
import {
    makeCalculated,
    sumAvailable,
    clampNonNegative,
} from "./normalizer.js";

function makeUnavailable(note: string, ts: number): NormalizedValue {
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

export interface PowerBalanceInputs {
    solar: NormalizedValue;
    battery: NormalizedValue;
    grid: NormalizedValue;
    houseDirect: NormalizedValue;
    ev: NormalizedValue;
    batteryConfig: Pick<BatteryConfig, "enabled">;
    evConfig: Pick<EvConfig, "enabled" | "includedInHousehold"> & Partial<Pick<EvConfig, "chargingThresholdW" | "chargingHysteresisW">>;
    balanceToleranceW: number;
    nowMs: number;
}

export interface PowerBalanceResult {
    power: PowerState;
}

export function calculatePowerBalance(inputs: PowerBalanceInputs): PowerBalanceResult {
    const { solar, battery, grid, houseDirect, ev, nowMs } = inputs;

    // houseCalculated = solar + grid + battery (all positive into house)
    // solar: always non-negative
    // grid: positive = import
    // battery: positive = discharging (positive contribution to house)
    const houseCalcParts: NormalizedValue[] = [];
    if (solar.value !== null) houseCalcParts.push(clampNonNegative(solar));
    if (grid.value !== null) houseCalcParts.push(grid);
    if (battery.value !== null) houseCalcParts.push(battery);

    const houseCalculated = houseCalcParts.length >= 2
        ? sumAvailable(houseCalcParts, nowMs)
        : makeUnavailable("insufficient inputs for balance", nowMs);

    // If houseCalculated is negative (e.g. big export + charging), clamp to 0
    const houseCalcClamped: NormalizedValue = houseCalculated.value !== null
        ? { ...houseCalculated, value: Math.max(0, houseCalculated.value) }
        : houseCalculated;

    // Discrepancy between measured and calculated house power
    let balanceDiscrepancy: NormalizedValue;
    if (houseDirect.value !== null && houseCalcClamped.value !== null) {
        balanceDiscrepancy = makeCalculated(
            houseDirect.value - houseCalcClamped.value,
            nowMs,
        );
    } else {
        balanceDiscrepancy = makeUnavailable("missing house or balance", nowMs);
    }

    // Choose best house value: prefer direct measurement
    const house = houseDirect.value !== null ? houseDirect : houseCalcClamped;

    // Site consumption = house + ev (if ev is NOT already in house)
    let siteConsumption: NormalizedValue;
    let houseExcludingEv: NormalizedValue;

    if (inputs.evConfig.enabled && ev.value !== null) {
        if (inputs.evConfig.includedInHousehold) {
            // EV is already counted in house measurement
            siteConsumption = house;
            if (house.value !== null) {
                const remaining = house.value - ev.value;
                houseExcludingEv = makeCalculated(Math.max(0, remaining), nowMs);
                // conflict if ev > house beyond tolerance
                if (remaining < -inputs.balanceToleranceW) {
                    houseExcludingEv = {
                        ...houseExcludingEv,
                        quality: {
                            ...houseExcludingEv.quality!,
                            note: `CONFLICT: EV ${ev.value}W > house ${house.value}W`,
                        },
                    };
                }
            } else {
                houseExcludingEv = makeUnavailable("house unavailable", nowMs);
            }
        } else {
            // EV is separate; add to house for site consumption
            siteConsumption = house.value !== null
                ? makeCalculated(house.value + ev.value, nowMs)
                : makeUnavailable("house unavailable", nowMs);
            houseExcludingEv = house;
        }
    } else {
        siteConsumption = house;
        houseExcludingEv = house;
    }

    // Battery status
    let batteryStatus: PowerState["batteryStatus"] = "unavailable";
    if (inputs.batteryConfig.enabled && battery.value !== null) {
        const IDLE_THRESHOLD = 10;
        if (battery.value > IDLE_THRESHOLD) batteryStatus = "discharging";
        else if (battery.value < -IDLE_THRESHOLD) batteryStatus = "charging";
        else batteryStatus = "idle";
    }

    // EV status
    let evStatus: PowerState["evStatus"] = "unavailable";
    if (inputs.evConfig.enabled && ev.value !== null) {
        const { chargingThresholdW, chargingHysteresisW } = inputs.evConfig as EvConfig;
        evStatus = ev.value >= (chargingThresholdW ?? 100) ? "charging" : "idle";
        void chargingHysteresisW;
    }

    const power: PowerState = {
        solar: clampNonNegative(solar),
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
