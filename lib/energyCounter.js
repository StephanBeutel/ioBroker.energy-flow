"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEmptyPersistence = createEmptyPersistence;
exports.migratePersistence = migratePersistence;
exports.meterDelta = meterDelta;
exports.integratePowerKwh = integratePowerKwh;
exports.updateCounters = updateCounters;
exports.getLocalDateString = getLocalDateString;
exports.getLocalPeriodStart = getLocalPeriodStart;
exports.calculateSolarStatistics = calculateSolarStatistics;
exports.pruneHistory = pruneHistory;
const normalizer_1 = require("./normalizer");
const PERSISTENCE_VERSION = 1;
const MAX_INTEGRATION_GAP_MS = 60_000; // 60 s gap = skip integration
function emptyAccumulator(periodStart) {
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
function emptyMeterSnapshot(ts) {
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
function emptyPowerIntegration() {
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
function createEmptyPersistence(nowIso) {
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
function migratePersistence(data) {
    if (!data || typeof data !== "object") {
        return createEmptyPersistence(new Date().toISOString());
    }
    const d = data;
    if (!d["version"] || d["version"] !== PERSISTENCE_VERSION) {
        const nowIso = new Date().toISOString();
        return createEmptyPersistence(nowIso);
    }
    return data;
}
/**
 * Calculate energy delta from meter reading.
 * Returns null if the delta is implausible (negative = rollover, too large = reset).
 */
function meterDelta(current, previous, maxDeltaKwh = 1_000_000) {
    if (current === null || previous === null)
        return null;
    const delta = current - previous;
    if (delta < 0)
        return null; // rollover / meter replacement - skip
    if (delta > maxDeltaKwh)
        return null; // implausible jump
    return delta;
}
/**
 * Integrate power over time using trapezoid rule.
 * Returns kWh or null if gap is too large.
 */
function integratePowerKwh(prevW, currW, prevTs, currTs) {
    if (prevW === null || currW === null)
        return null;
    const dtS = (currTs - prevTs) / 1000;
    if (dtS <= 0)
        return null;
    if ((currTs - prevTs) > MAX_INTEGRATION_GAP_MS)
        return null;
    const avgW = (prevW + currW) / 2;
    return (avgW * dtS) / 3_600_000; // W * s → kWh: divide by 3,600,000
}
function addDelta(acc, delta) {
    if (delta === null || delta < 0)
        return acc;
    return acc + delta;
}
/**
 * Update an accumulator with meter delta or power integration.
 * Meter takes priority; falls back to power integration.
 */
function updateAccumulatorField(current, meterCurrent, meterPrevious, powerCurrent, powerPrevious, prevTs, currTs) {
    const meterDelta_ = meterDelta(meterCurrent, meterPrevious);
    if (meterDelta_ !== null) {
        return { value: current + meterDelta_, lastMeter: meterCurrent };
    }
    const powerDelta = prevTs !== null
        ? integratePowerKwh(powerPrevious, powerCurrent, prevTs, currTs)
        : null;
    return { value: addDelta(current, powerDelta), lastMeter: meterPrevious };
}
function updateCounters(data, inputs, timezone) {
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
        const dailyRec = {
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
    function updateAcc(acc) {
        const solarR = updateAccumulatorField(acc.solar, inputs.solarMeterKwh, acc.lastSolarMeterKwh, inputs.solarW ? Math.max(0, inputs.solarW) : null, pi.lastSolarW, prevTs, nowMs);
        const gridImpR = updateAccumulatorField(acc.gridImport, inputs.gridImportMeterKwh, acc.lastGridImportMeterKwh, inputs.gridImportW ? Math.max(0, inputs.gridImportW) : null, pi.lastGridImportW, prevTs, nowMs);
        const gridExpR = updateAccumulatorField(acc.gridExport, inputs.gridExportMeterKwh, acc.lastGridExportMeterKwh, inputs.gridExportW ? Math.max(0, inputs.gridExportW) : null, pi.lastGridExportW, prevTs, nowMs);
        const houseR = updateAccumulatorField(acc.consumption, inputs.consumptionMeterKwh, acc.lastConsumptionMeterKwh, inputs.houseW ? Math.max(0, inputs.houseW) : null, pi.lastHouseW, prevTs, nowMs);
        const battChargeR = updateAccumulatorField(acc.batteryCharge, inputs.batteryChargeMeterKwh, null, inputs.batteryChargeW ? Math.max(0, inputs.batteryChargeW) : null, pi.lastBatteryChargeW, prevTs, nowMs);
        const battDischargeR = updateAccumulatorField(acc.batteryDischarge, inputs.batteryDischargeMeterKwh, null, inputs.batteryDischargeW ? Math.max(0, inputs.batteryDischargeW) : null, pi.lastBatteryDischargeW, prevTs, nowMs);
        const evR = updateAccumulatorField(acc.evCharging, inputs.evMeterKwh, acc.lastEvMeterKwh, inputs.evW ? Math.max(0, inputs.evW) : null, pi.lastEvW, prevTs, nowMs);
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
    const newPi = {
        lastTimestamp: nowMs,
        lastSolarW: inputs.solarW,
        lastGridImportW: inputs.gridImportW,
        lastGridExportW: inputs.gridExportW,
        lastHouseW: inputs.houseW,
        lastBatteryChargeW: inputs.batteryChargeW,
        lastBatteryDischargeW: inputs.batteryDischargeW,
        lastEvW: inputs.evW,
    };
    const newData = {
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
function accumulatorToEnergyPeriod(acc, ts) {
    const c = (v) => (0, normalizer_1.makeCalculated)(v, ts);
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
function getLocalDateString(date, timezone) {
    return date.toLocaleDateString("sv-SE", { timeZone: timezone });
}
function getLocalPeriodStart(date, period, timezone) {
    const local = date.toLocaleDateString("sv-SE", { timeZone: timezone });
    if (period === "day")
        return new Date(local + "T00:00:00").toISOString();
    if (period === "month")
        return new Date(local.substring(0, 7) + "-01T00:00:00").toISOString();
    return new Date(local.substring(0, 4) + "-01-01T00:00:00").toISOString();
}
function calculateSolarStatistics(dailyHistory, nowMs, excludeIncomplete = true) {
    const ts = nowMs;
    const eligible = excludeIncomplete
        ? dailyHistory.filter((d) => d.complete && d.solar !== null)
        : dailyHistory.filter((d) => d.solar !== null);
    if (eligible.length === 0) {
        return {
            highestDayKwh: (0, normalizer_1.makeEstimated)(null, ts, "no complete days"),
            highestDayDate: null,
            lowestDayKwh: (0, normalizer_1.makeEstimated)(null, ts, "no complete days"),
            lowestDayDate: null,
            averageDayKwh: (0, normalizer_1.makeEstimated)(null, ts, "no complete days"),
            peakPowerKw: (0, normalizer_1.makeEstimated)(null, ts, "no data"),
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
    let peakRec = null;
    for (const rec of eligible) {
        const kWh = rec.solar;
        totalKwh += kWh;
        if (kWh > highest.solar)
            highest = rec;
        if (kWh < lowest.solar)
            lowest = rec;
        if (rec.peakSolarW !== null && rec.peakSolarW > peakW) {
            peakW = rec.peakSolarW;
            peakRec = rec;
        }
    }
    return {
        highestDayKwh: (0, normalizer_1.makeCalculated)(highest.solar, ts),
        highestDayDate: highest.date,
        lowestDayKwh: (0, normalizer_1.makeCalculated)(lowest.solar, ts),
        lowestDayDate: lowest.date,
        averageDayKwh: (0, normalizer_1.makeCalculated)(totalKwh / eligible.length, ts),
        peakPowerKw: peakRec ? (0, normalizer_1.makeCalculated)(peakW / 1000, ts) : (0, normalizer_1.makeEstimated)(null, ts, "no peak data"),
        peakPowerDate: peakRec?.date ?? null,
        peakPowerTime: peakRec?.peakSolarTime ?? null,
        daysIncluded: eligible.length,
        daysExcluded: dailyHistory.length - eligible.length,
    };
}
function pruneHistory(data, retentionDays) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().substring(0, 10);
    const pruned = data.dailyHistory.filter((r) => r.date >= cutoffStr);
    return { ...data, dailyHistory: pruned };
}
//# sourceMappingURL=energyCounter.js.map