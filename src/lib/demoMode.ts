import type {
    PowerState, EnergyFlows, EnergyPeriod, MeterReadings,
    SolarStatistics, DashboardSnapshot, NormalizedValue,
} from "./types.js";
import { makeCalculated, makeEstimated } from "./normalizer.js";

const DEMO_NOTE = "DEMO MODE - synthetic data";

function demoMeasured(value: number, ts: number): NormalizedValue {
    return {
        value,
        quality: {
            provenance: "measured",
            availability: "available",
            freshness: "current",
            timestamp: ts,
            note: DEMO_NOTE,
        },
    };
}

function demoCalc(value: number, ts: number): NormalizedValue {
    return { ...makeCalculated(value, ts), quality: { ...(makeCalculated(value, ts).quality!), note: DEMO_NOTE } };
}

function demoEst(value: number, ts: number): NormalizedValue {
    return { ...makeEstimated(value, ts), quality: { ...(makeEstimated(value, ts).quality!), note: DEMO_NOTE } };
}

type DemoScenario =
    | "solar-house-battery"
    | "solar-house-grid-export"
    | "battery-house"
    | "grid-house-battery-charge"
    | "empty-battery"
    | "solar-house-ev"
    | "grid-ev"
    | "stale-data";

export function generateDemoSnapshot(scenario: DemoScenario, ts: number): DashboardSnapshot {
    let power: PowerState;
    let flows: EnergyFlows;

    switch (scenario) {
        case "solar-house-battery":
            power = buildPower({ solar: 3500, battery: -800, grid: 0, house: 2700, soc: 65, ev: 0 }, ts);
            flows = buildFlows({ solarToHouse: 2700, solarToBattery: 800, solarToGrid: 0, batteryToHouse: 0, gridToHouse: 0 }, ts);
            break;
        case "solar-house-grid-export":
            power = buildPower({ solar: 5000, battery: 0, grid: -1500, house: 3500, soc: 100, ev: 0 }, ts);
            flows = buildFlows({ solarToHouse: 3500, solarToGrid: 1500, solarToBattery: 0, batteryToHouse: 0, gridToHouse: 0 }, ts);
            break;
        case "battery-house":
            power = buildPower({ solar: 0, battery: 2000, grid: 0, house: 2000, soc: 45, ev: 0 }, ts);
            flows = buildFlows({ solarToHouse: 0, batteryToHouse: 2000, gridToHouse: 0 }, ts);
            break;
        case "grid-house-battery-charge":
            power = buildPower({ solar: 0, battery: -1000, grid: 4000, house: 3000, soc: 20, ev: 0 }, ts);
            flows = buildFlows({ gridToHouse: 3000, gridToBattery: 1000 }, ts);
            break;
        case "empty-battery":
            power = buildPower({ solar: 1000, battery: 0, grid: 1500, house: 2500, soc: 0, ev: 0 }, ts);
            flows = buildFlows({ solarToHouse: 1000, gridToHouse: 1500 }, ts);
            break;
        case "solar-house-ev":
            power = buildPower({ solar: 7000, battery: 0, grid: -1000, house: 2500, soc: 80, ev: 3500 }, ts);
            flows = buildFlows({ solarToHouse: 2500, solarToGrid: 1000, solarToEv: 3500 }, ts);
            break;
        case "grid-ev":
            power = buildPower({ solar: 0, battery: 0, grid: 5500, house: 1500, soc: 30, ev: 4000 }, ts);
            flows = buildFlows({ gridToHouse: 1500, gridToEv: 4000 }, ts);
            break;
        case "stale-data":
        default:
            power = buildPower({ solar: null, battery: null, grid: 2000, house: 2000, soc: null, ev: 0 }, ts);
            flows = buildFlows({ gridToHouse: 2000 }, ts);
    }

    const today: EnergyPeriod = {
        solar: demoCalc(18.5, ts),
        consumption: demoCalc(12.3, ts),
        gridImport: demoCalc(2.1, ts),
        gridExport: demoCalc(8.3, ts),
        batteryCharge: demoCalc(4.2, ts),
        batteryDischarge: demoCalc(3.8, ts),
        evCharging: demoCalc(scenario.includes("ev") ? 15.2 : 0, ts),
    };

    const month: EnergyPeriod = {
        solar: demoCalc(312.5, ts),
        consumption: demoCalc(198.7, ts),
        gridImport: demoCalc(45.2, ts),
        gridExport: demoCalc(158.9, ts),
        batteryCharge: demoCalc(62.1, ts),
        batteryDischarge: demoCalc(58.3, ts),
        evCharging: demoCalc(scenario.includes("ev") ? 210.0 : 0, ts),
    };

    const year: EnergyPeriod = {
        solar: demoCalc(2847.3, ts),
        consumption: demoCalc(1923.4, ts),
        gridImport: demoCalc(412.1, ts),
        gridExport: demoCalc(1336.0, ts),
        batteryCharge: demoCalc(587.4, ts),
        batteryDischarge: demoCalc(541.2, ts),
        evCharging: demoCalc(scenario.includes("ev") ? 1850.0 : 0, ts),
    };

    const stats: SolarStatistics = {
        highestDayKwh: demoCalc(35.2, ts),
        highestDayDate: "2025-07-15",
        lowestDayKwh: demoCalc(0.8, ts),
        lowestDayDate: "2025-12-21",
        averageDayKwh: demoCalc(12.1, ts),
        peakPowerKw: demoCalc(8.7, ts),
        peakPowerDate: "2025-07-15",
        peakPowerTime: "13:24",
        daysIncluded: 245,
        daysExcluded: 12,
    };

    const meters: MeterReadings = {
        gridImport: demoMeasured(12345.6, ts),
        gridExport: demoMeasured(8765.4, ts),
        solar: demoMeasured(45678.9, ts),
        consumption: demoMeasured(23456.7, ts),
        evCharging: scenario.includes("ev") ? demoMeasured(1234.5, ts) : { value: null, quality: { provenance: "measured", availability: "unavailable", freshness: "current", timestamp: ts } },
    };

    return {
        power,
        flows,
        energy: { today, month, year, total: { periodStart: "", solar: 2847.3, consumption: 1923.4, gridImport: 412.1, gridExport: 1336.0, batteryCharge: 587.4, batteryDischarge: 541.2, evCharging: 0, lastSolarMeterKwh: null, lastConsumptionMeterKwh: null, lastGridImportMeterKwh: null, lastGridExportMeterKwh: null, lastEvMeterKwh: null, lastUpdate: new Date(ts).toISOString() } },
        meters,
        stats,
        ts,
        demo: true,
    };
}

function buildPower(opts: { solar: number | null; battery: number | null; grid: number; house: number; soc: number | null; ev: number }, ts: number): PowerState {
    const solar = opts.solar !== null ? demoMeasured(opts.solar, ts) : { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "stale" as const, timestamp: ts, note: "stale in demo" } };
    const battery = opts.battery !== null ? demoMeasured(opts.battery, ts) : { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "current" as const, timestamp: ts } };
    const grid = demoMeasured(opts.grid, ts);
    const house = demoMeasured(opts.house, ts);
    const soc = opts.soc !== null ? demoMeasured(opts.soc, ts) : { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "current" as const, timestamp: ts } };
    const ev = demoMeasured(opts.ev, ts);

    const battVal = opts.battery ?? 0;
    const battStatus: PowerState["batteryStatus"] = opts.battery !== null
        ? battVal > 10 ? "discharging" : battVal < -10 ? "charging" : "idle"
        : "unavailable";

    return {
        solar,
        battery,
        grid,
        house,
        houseCalculated: demoCalc(opts.house, ts),
        balanceDiscrepancyW: demoCalc(0, ts),
        evCharging: ev,
        siteConsumption: demoCalc(opts.house + opts.ev, ts),
        houseExcludingEv: demoCalc(opts.house, ts),
        batterySoc: soc,
        batteryStatus: battStatus,
        evStatus: opts.ev > 100 ? "charging" : "idle",
    };
}

function buildFlows(partial: Partial<Record<string, number>>, ts: number): EnergyFlows {
    const get = (k: string) => demoEst(partial[k] ?? 0, ts);
    return {
        solarToHouse: get("solarToHouse"),
        solarToBattery: get("solarToBattery"),
        solarToGrid: get("solarToGrid"),
        batteryToHouse: get("batteryToHouse"),
        batteryToGrid: get("batteryToGrid"),
        gridToHouse: get("gridToHouse"),
        gridToBattery: get("gridToBattery"),
        solarToEv: get("solarToEv"),
        gridToEv: get("gridToEv"),
        batteryToEv: get("batteryToEv"),
        flowsEstimated: true,
    };
}
