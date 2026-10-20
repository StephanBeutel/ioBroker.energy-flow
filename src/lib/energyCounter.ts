import type {
    PersistenceData,
    EnergyAccumulator,
    DailyRecord,
    PowerIntegrationState,
    MeterSnapshot,
    NormalizedValue as _NormalizedValue,
    SolarStatistics,
    EnergyPeriod,
} from "./types";
import { makeCalculated, makeEstimated } from "./normalizer";

const PERSISTENCE_VERSION = 1;
const MAX_INTEGRATION_GAP_MS = 60_000;  // 60 s gap = skip integration

export interface CounterInputs {
    solarW: number | null;
    gridImportW: number | null;
    gridExportW: number | null;
    houseW: number | null;
    batteryChargeW: number | null;
    batteryDischargeW: number | null;
    evW: number | null;
    solarMeterKwh: number | null;
    gridImportMeterKwh: number | null;
    gridExportMeterKwh: number | null;
    consumptionMeterKwh: number | null;
    batteryChargeMeterKwh: number | null;
    batteryDischargeMeterKwh: number | null;
    evMeterKwh: number | null;
    nowMs: number;
}

function emptyAccumulator(periodStart: string): EnergyAccumulator {
    return {
        periodStart,
        solar: 0,
        consumption: 0,
        gridImport: 0,
        gridExport: 0,
        batteryCharge: 0,
        batteryDischarge: 0,
        evCharging: 0,
        lastSolarMeterKwh: null,
        lastConsumptionMeterKwh: null,
        lastGridImportMeterKwh: null,
        lastGridExportMeterKwh: null,
        lastEvMeterKwh: null,
        lastUpdate: periodStart,
    };
}

function emptyMeterSnapshot(ts: string): MeterSnapshot {
    return {
        gridImportKwh: null,
        gridExportKwh: null,
        solarKwh: null,
        consumptionKwh: null,
        batteryChargeKwh: null,
        batteryDischargeKwh: null,
        evChargingKwh: null,
        timestamp: ts,
    };
}

function emptyPowerIntegration(): PowerIntegrationState {
    return {
        lastTimestamp: null,
        lastSolarW: null,
        lastGridImportW: null,
        lastGridExportW: null,
        lastHouseW: null,
        lastBatteryChargeW: null,
        lastBatteryDischargeW: null,
        lastEvW: null,
    };
}

export function createEmptyPersistence(nowIso: string): PersistenceData {
    return {
        version: PERSISTENCE_VERSION,
        today: emptyAccumulator(nowIso),
        month: emptyAccumulator(nowIso),
        year: emptyAccumulator(nowIso),
        total: emptyAccumulator(nowIso),
        dailyHistory: [],
        lastMeterSnapshot: emptyMeterSnapshot(nowIso),
        powerIntegration: emptyPowerIntegration(),
        evTotalRecorded: 0,
        lastPeriodBoundary: nowIso,
    };
}

export function migratePersistence(data: unknown): PersistenceData {
    if (!data || typeof data !== "object") {
        return createEmptyPersistence(new Date().toISOString());
    }
    const d = data as Record<string, unknown>;
    if (!d["version"] || d["version"] !== PERSISTENCE_VERSION) {
        const nowIso = new Date().toISOString();
        return createEmptyPersistence(nowIso);
    }
    return data as PersistenceData;
}

/**
 * Calculate energy delta from meter reading.
 * Returns null if the delta is implausible (negative = rollover, too large = reset).
 */
export function meterDelta(
    current: number | null,
    previous: number | null,
    maxDeltaKwh = 1_000_000,
): number | null {
    if (current === null || previous === null) return null;
    const delta = current - previous;
    if (delta < 0) return null;       // rollover / meter replacement - skip
    if (delta > maxDeltaKwh) return null;  // implausible jump
    return delta;
}

/**
 * Integrate power over time using trapezoid rule.
 * Returns kWh or null if gap is too large.
 */
export function integratePowerKwh(
    prevW: number | null,
    currW: number | null,
    prevTs: number,
    currTs: number,
): number | null {
    if (prevW === null || currW === null) return null;
    const dtS = (currTs - prevTs) / 1000;
    if (dtS <= 0) return null;
    if ((currTs - prevTs) > MAX_INTEGRATION_GAP_MS) return null;
    const avgW = (prevW + currW) / 2;
    return (avgW * dtS) / 3_600_000; // W * s → kWh: divide by 3,600,000
}

function addDelta(acc: number, delta: number | null): number {
    if (delta === null || delta < 0) return acc;
    return acc + delta;
}

/**
 * Update an accumulator with meter delta or power integration.
 * Meter takes priority; falls back to power integration.
 */
function updateAccumulatorField(
    current: number,
    meterCurrent: number | null,
    meterPrevious: number | null,
    powerCurrent: number | null,
    powerPrevious: number | null,
    prevTs: number | null,
    currTs: number,
): { value: number; lastMeter: number | null } {
    const meterDelta_ = meterDelta(meterCurrent, meterPrevious);
    if (meterDelta_ !== null) {
        return { value: current + meterDelta_, lastMeter: meterCurrent };
    }
    const powerDelta = prevTs !== null
        ? integratePowerKwh(powerPrevious, powerCurrent, prevTs, currTs)
        : null;
    return { value: addDelta(current, powerDelta), lastMeter: meterPrevious };
}

export interface UpdateCountersResult {
    data: PersistenceData;
    todayEnergyPeriod: EnergyPeriod;
    monthEnergyPeriod: EnergyPeriod;
    yearEnergyPeriod: EnergyPeriod;
}

export function updateCounters(
    data: PersistenceData,
    inputs: CounterInputs,
    timezone: string,
): UpdateCountersResult {
    const nowMs = inputs.nowMs;
    const nowDate = new Date(nowMs);
    const nowIso = nowDate.toISOString();

    const todayLocal = getLocalDateString(nowDate, timezone);
    const monthLocal = todayLocal.substring(0, 7);
    const yearLocal = todayLocal.substring(0, 4);

    const todayStart = getLocalPeriodStart(nowDate, "day", timezone);
    const monthStart = getLocalPeriodStart(nowDate, "month", timezone);
    const yearStart = getLocalPeriodStart(nowDate, "year", timezone);

    // Detect period boundary crossings and archive/reset accumulators
    let { today, month, year, total } = data;

    const prevTodayDate = today.periodStart
        ? getLocalDateString(new Date(today.periodStart), timezone)
        : null;
    const prevMonthStr = month.periodStart
        ? getLocalDateString(new Date(month.periodStart), timezone).substring(0, 7)
        : null;
    const prevYearStr = year.periodStart
        ? getLocalDateString(new Date(year.periodStart), timezone).substring(0, 4)
        : null;

    // Archive completed day before resetting
    if (prevTodayDate && prevTodayDate !== todayLocal) {
        const dailyRec: DailyRecord = {
            date: prevTodayDate,
            solar: today.solar > 0 ? today.solar : today.solar,
            consumption: today.consumption,
            gridImport: today.gridImport,
            gridExport: today.gridExport,
            batteryCharge: today.batteryCharge,
            batteryDischarge: today.batteryDischarge,
            evCharging: today.evCharging,
            peakSolarW: null,
            peakSolarTime: null,
            complete: true,
            estimatedAllocation: false,
        };
        data = { ...data, dailyHistory: [...data.dailyHistory, dailyRec] };
        today = emptyAccumulator(todayStart);
    }

    if (prevMonthStr && prevMonthStr !== monthLocal) {
        month = emptyAccumulator(monthStart);
    }
    if (prevYearStr && prevYearStr !== yearLocal) {
        year = emptyAccumulator(yearStart);
    }

    const pi = data.powerIntegration;
    const prevTs = pi.lastTimestamp;

    // Helper: update one accumulator
    function updateAcc(acc: EnergyAccumulator): EnergyAccumulator {
        const solarR = updateAccumulatorField(
            acc.solar, inputs.solarMeterKwh, acc.lastSolarMeterKwh,
            inputs.solarW ? Math.max(0, inputs.solarW) : null,
            pi.lastSolarW, prevTs, nowMs,
        );
        const gridImpR = updateAccumulatorField(
            acc.gridImport, inputs.gridImportMeterKwh, acc.lastGridImportMeterKwh,
            inputs.gridImportW ? Math.max(0, inputs.gridImportW) : null,
            pi.lastGridImportW, prevTs, nowMs,
        );
        const gridExpR = updateAccumulatorField(
            acc.gridExport, inputs.gridExportMeterKwh, acc.lastGridExportMeterKwh,
            inputs.gridExportW ? Math.max(0, inputs.gridExportW) : null,
            pi.lastGridExportW, prevTs, nowMs,
        );
        const houseR = updateAccumulatorField(
            acc.consumption, inputs.consumptionMeterKwh, acc.lastConsumptionMeterKwh,
            inputs.houseW ? Math.max(0, inputs.houseW) : null,
            pi.lastHouseW, prevTs, nowMs,
        );
        const battChargeR = updateAccumulatorField(
            acc.batteryCharge, inputs.batteryChargeMeterKwh, null,
            inputs.batteryChargeW ? Math.max(0, inputs.batteryChargeW) : null,
            pi.lastBatteryChargeW, prevTs, nowMs,
        );
        const battDischargeR = updateAccumulatorField(
            acc.batteryDischarge, inputs.batteryDischargeMeterKwh, null,
            inputs.batteryDischargeW ? Math.max(0, inputs.batteryDischargeW) : null,
            pi.lastBatteryDischargeW, prevTs, nowMs,
        );
        const evR = updateAccumulatorField(
            acc.evCharging, inputs.evMeterKwh, acc.lastEvMeterKwh,
            inputs.evW ? Math.max(0, inputs.evW) : null,
            pi.lastEvW, prevTs, nowMs,
        );

        return {
            ...acc,
            solar: solarR.value,
            consumption: houseR.value,
            gridImport: gridImpR.value,
            gridExport: gridExpR.value,
            batteryCharge: battChargeR.value,
            batteryDischarge: battDischargeR.value,
            evCharging: evR.value,
            lastSolarMeterKwh: solarR.lastMeter ?? inputs.solarMeterKwh,
            lastConsumptionMeterKwh: houseR.lastMeter ?? inputs.consumptionMeterKwh,
            lastGridImportMeterKwh: gridImpR.lastMeter ?? inputs.gridImportMeterKwh,
            lastGridExportMeterKwh: gridExpR.lastMeter ?? inputs.gridExportMeterKwh,
            lastEvMeterKwh: evR.lastMeter ?? inputs.evMeterKwh,
            lastUpdate: nowIso,
        };
    }

    today = updateAcc(today);
    month = updateAcc(month);
    year = updateAcc(year);
    total = updateAcc(total);

    // Update power integration state
    const newPi: PowerIntegrationState = {
        lastTimestamp: nowMs,
        lastSolarW: inputs.solarW,
        lastGridImportW: inputs.gridImportW,
        lastGridExportW: inputs.gridExportW,
        lastHouseW: inputs.houseW,
        lastBatteryChargeW: inputs.batteryChargeW,
        lastBatteryDischargeW: inputs.batteryDischargeW,
        lastEvW: inputs.evW,
    };

    const newData: PersistenceData = {
        ...data,
        today,
        month,
        year,
        total,
        powerIntegration: newPi,
        lastPeriodBoundary: nowIso,
        evTotalRecorded: total.evCharging,
    };

    return {
        data: newData,
        todayEnergyPeriod: accumulatorToEnergyPeriod(today, nowMs),
        monthEnergyPeriod: accumulatorToEnergyPeriod(month, nowMs),
        yearEnergyPeriod: accumulatorToEnergyPeriod(year, nowMs),
    };
}

function accumulatorToEnergyPeriod(acc: EnergyAccumulator, ts: number): EnergyPeriod {
    const c = (v: number) => makeCalculated(v, ts);
    return {
        solar: c(acc.solar),
        consumption: c(acc.consumption),
        gridImport: c(acc.gridImport),
        gridExport: c(acc.gridExport),
        batteryCharge: c(acc.batteryCharge),
        batteryDischarge: c(acc.batteryDischarge),
        evCharging: c(acc.evCharging),
    };
}

export function getLocalDateString(date: Date, timezone: string): string {
    return date.toLocaleDateString("sv-SE", { timeZone: timezone });
}

export function getLocalPeriodStart(date: Date, period: "day" | "month" | "year", timezone: string): string {
    const local = date.toLocaleDateString("sv-SE", { timeZone: timezone });
    if (period === "day") return new Date(local + "T00:00:00").toISOString();
    if (period === "month") return new Date(local.substring(0, 7) + "-01T00:00:00").toISOString();
    return new Date(local.substring(0, 4) + "-01-01T00:00:00").toISOString();
}

export function calculateSolarStatistics(
    dailyHistory: DailyRecord[],
    nowMs: number,
    excludeIncomplete = true,
): SolarStatistics {
    const ts = nowMs;
    const eligible = excludeIncomplete
        ? dailyHistory.filter((d) => d.complete && d.solar !== null)
        : dailyHistory.filter((d) => d.solar !== null);

    if (eligible.length === 0) {
        return {
            highestDayKwh: makeEstimated(null, ts, "no complete days"),
            highestDayDate: null,
            lowestDayKwh: makeEstimated(null, ts, "no complete days"),
            lowestDayDate: null,
            averageDayKwh: makeEstimated(null, ts, "no complete days"),
            peakPowerKw: makeEstimated(null, ts, "no data"),
            peakPowerDate: null,
            peakPowerTime: null,
            daysIncluded: 0,
            daysExcluded: dailyHistory.length - eligible.length,
        };
    }

    let highest = eligible[0];
    let lowest = eligible[0];
    let totalKwh = 0;
    let peakW = 0;
    let peakRec: DailyRecord | null = null;

    for (const rec of eligible) {
        const kWh = rec.solar!;
        totalKwh += kWh;
        if (kWh > highest.solar!) highest = rec;
        if (kWh < lowest.solar!) lowest = rec;
        if (rec.peakSolarW !== null && rec.peakSolarW > peakW) {
            peakW = rec.peakSolarW;
            peakRec = rec;
        }
    }

    return {
        highestDayKwh: makeCalculated(highest.solar!, ts),
        highestDayDate: highest.date,
        lowestDayKwh: makeCalculated(lowest.solar!, ts),
        lowestDayDate: lowest.date,
        averageDayKwh: makeCalculated(totalKwh / eligible.length, ts),
        peakPowerKw: peakRec ? makeCalculated(peakW / 1000, ts) : makeEstimated(null, ts, "no peak data"),
        peakPowerDate: peakRec?.date ?? null,
        peakPowerTime: peakRec?.peakSolarTime ?? null,
        daysIncluded: eligible.length,
        daysExcluded: dailyHistory.length - eligible.length,
    };
}

export function pruneHistory(data: PersistenceData, retentionDays: number): PersistenceData {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().substring(0, 10);
    const pruned = data.dailyHistory.filter((r) => r.date >= cutoffStr);
    return { ...data, dailyHistory: pruned };
}
