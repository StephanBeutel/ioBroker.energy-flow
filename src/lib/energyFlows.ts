import type { EnergyFlows, NormalizedValue, BatteryConfig, EvConfig } from "./types";
import { makeEstimated } from "./normalizer";

function unavailable(ts: number): NormalizedValue {
    return {
        value: null,
        quality: {
            provenance: "estimated",
            availability: "unavailable",
            freshness: "current",
            timestamp: ts,
        },
    };
}

function zero(ts: number): NormalizedValue {
    return makeEstimated(0, ts);
}

export interface FlowInputs {
    solarW: number | null;
    batteryW: number | null;    // positive=discharging, negative=charging
    gridW: number | null;       // positive=import, negative=export
    houseW: number | null;
    evW: number | null;
    batteryConfig: Pick<BatteryConfig, "enabled" | "gridChargingEnabled" | "gridExportEnabled">;
    evConfig: Pick<EvConfig, "enabled" | "includedInHousehold">;
    nowMs: number;
}

/**
 * Deterministic flow estimation (documented algorithm):
 *
 * 0. Demand: if solar, grid and battery are all measured, demand = sources - sinks (energy
 *    balance), so every measured watt appears in a flow. Otherwise the measured house value.
 * 1. Solar priority: solar first covers house + ev consumption, then excess to battery/grid.
 * 2. Battery second: remaining house/ev covered by battery if discharging.
 * 3. Grid last: remaining demand covered by grid.
 *
 * Sign conventions:
 *   battery: positive=discharging, negative=charging
 *   grid: positive=import, negative=export
 *
 * All flows are non-negative (unidirectional).
 *
 * NOTE: This estimation assumes AC measurement boundaries. DC/AC mismatches
 * are not modelled. Values are marked estimated.
 */
export function estimateFlows(inputs: FlowInputs): EnergyFlows {
    const { solarW, batteryW, gridW, houseW, evW, nowMs } = inputs;

    const solarAvail = solarW !== null && isFinite(solarW);
    const battAvail = batteryW !== null && isFinite(batteryW) && inputs.batteryConfig.enabled;
    const gridAvail = gridW !== null && isFinite(gridW);
    const houseAvail = houseW !== null && isFinite(houseW);
    const evAvail = evW !== null && isFinite(evW) && inputs.evConfig.enabled;

    if (!solarAvail && !battAvail && !gridAvail) {
        // Cannot estimate any flows
        const u = () => unavailable(nowMs);
        return {
            solarToHouse: u(), solarToBattery: u(), solarToGrid: u(),
            batteryToHouse: u(), batteryToGrid: u(),
            gridToHouse: u(), gridToBattery: u(),
            solarToEv: u(), gridToEv: u(), batteryToEv: u(),
            flowsEstimated: true,
        };
    }

    const solar = Math.max(0, solarW ?? 0);
    const battDischarge = battAvail ? Math.max(0, batteryW!) : 0;
    const battCharge = battAvail ? Math.max(0, -(batteryW!)) : 0;
    const gridImport = gridAvail ? Math.max(0, gridW!) : 0;
    const gridExport = gridAvail ? Math.max(0, -(gridW!)) : 0;

    // Total demand = house + ev
    let houseConsumed = houseAvail ? Math.max(0, houseW!) : 0;
    let evConsumed = evAvail ? Math.max(0, evW!) : 0;
    const evSeparate = inputs.evConfig.enabled && !inputs.evConfig.includedInHousehold;

    // If EV is included in house, don't double count
    let totalDemand = evSeparate ? houseConsumed + evConsumed : houseConsumed;

    // When solar, grid and battery are all measured, derive demand from the balance so the
    // flows add up to the measured sources/sinks. Otherwise a mismatch with the measured house
    // value would make grid import/export (or battery power) disappear from the flows.
    if (solarAvail && gridAvail && (battAvail || !inputs.batteryConfig.enabled)) {
        totalDemand = Math.max(0, solar + battDischarge + gridImport - battCharge - gridExport);
        if (evSeparate) {
            evConsumed = Math.min(evConsumed, totalDemand);
            houseConsumed = totalDemand - evConsumed;
        } else {
            houseConsumed = totalDemand;
        }
    }

    // --- Allocation: solar first, then battery, then grid ---

    let remainingSolar = solar;
    let remainingDemand = totalDemand;

    // Without grid charging the battery can only be charged from solar, and without battery
    // export its discharge can only go to demand - reserve those shares before solar → demand.
    const solarReservedForBatt = inputs.batteryConfig.gridChargingEnabled ? 0 : Math.min(solar, battCharge);
    const demandReservedForBatt = inputs.batteryConfig.gridExportEnabled ? 0 : Math.min(battDischarge, totalDemand);

    // Solar → demand
    const solarToDemand = Math.min(remainingSolar - solarReservedForBatt, remainingDemand - demandReservedForBatt);
    remainingSolar -= solarToDemand;
    remainingDemand -= solarToDemand;

    // Solar → battery charging (if battery is charging)
    const solarToBattCharge = Math.min(remainingSolar, battCharge);
    remainingSolar -= solarToBattCharge;

    // Solar → grid export
    const solarToGridExport = Math.min(remainingSolar, gridExport);
    remainingSolar -= solarToGridExport;

    // Battery discharge → remaining demand
    const battToDemand = Math.min(battDischarge, remainingDemand);
    remainingDemand -= battToDemand;

    // Battery discharge → grid export
    const battToGridExport = inputs.batteryConfig.gridExportEnabled
        ? Math.min(battDischarge - battToDemand, gridExport - solarToGridExport)
        : 0;

    // Grid import → battery charging (if grid charging enabled)
    const gridToBattCharge = inputs.batteryConfig.gridChargingEnabled
        ? Math.min(gridImport, Math.max(0, battCharge - solarToBattCharge))
        : 0;

    // Grid import → remaining demand
    const gridToDemand = Math.min(Math.max(0, gridImport - gridToBattCharge), remainingDemand);

    // Now split demand flows into house vs ev
    let solarToHouseW: number;
    let solarToEvW: number;
    let battToHouseW: number;
    let battToEvW: number;
    let gridToHouseW: number;
    let gridToEvW: number;

    if (evAvail && !inputs.evConfig.includedInHousehold && totalDemand > 0) {
        // Proportional allocation of supply to house vs ev
        const houseShare = houseConsumed / totalDemand;
        const evShare = evConsumed / totalDemand;
        solarToHouseW = solarToDemand * houseShare;
        solarToEvW = solarToDemand * evShare;
        battToHouseW = battToDemand * houseShare;
        battToEvW = battToDemand * evShare;
        gridToHouseW = gridToDemand * houseShare;
        gridToEvW = gridToDemand * evShare;
    } else {
        solarToHouseW = solarToDemand;
        solarToEvW = 0;
        battToHouseW = battToDemand;
        battToEvW = 0;
        gridToHouseW = gridToDemand;
        gridToEvW = 0;
    }

    const est = (v: number) => makeEstimated(Math.max(0, v), nowMs);
    const z = () => zero(nowMs);

    return {
        solarToHouse: solarAvail ? est(solarToHouseW) : z(),
        solarToBattery: solarAvail && battAvail ? est(solarToBattCharge) : z(),
        solarToGrid: solarAvail && gridAvail ? est(solarToGridExport) : z(),
        batteryToHouse: battAvail ? est(battToHouseW) : z(),
        batteryToGrid: battAvail && gridAvail ? est(battToGridExport) : z(),
        gridToHouse: gridAvail ? est(gridToHouseW) : z(),
        gridToBattery: battAvail && gridAvail ? est(gridToBattCharge) : z(),
        solarToEv: evAvail ? est(solarToEvW) : z(),
        gridToEv: evAvail ? est(gridToEvW) : z(),
        batteryToEv: evAvail ? est(battToEvW) : z(),
        flowsEstimated: true,
    };
}
