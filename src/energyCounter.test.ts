import { expect } from "chai";
import {
    meterDelta,
    integratePowerKwh,
    updateCounters,
    createEmptyPersistence,
    calculateSolarStatistics,
    getLocalDateString,
} from "./lib/energyCounter";
import type { PersistenceData, DailyRecord } from "./lib/types";

const TZ = "Europe/Berlin";

// Controllable clock
function makeNow(isoString: string): number {
    return new Date(isoString).getTime();
}

describe("Energy counter", () => {
    describe("meterDelta", () => {
        it("returns positive delta", () => {
            expect(meterDelta(100, 80)).to.equal(20);
        });

        it("returns null for negative delta (rollover)", () => {
            expect(meterDelta(50, 100)).to.be.null;
        });

        it("returns null when either value is null", () => {
            expect(meterDelta(null, 100)).to.be.null;
            expect(meterDelta(100, null)).to.be.null;
        });

        it("returns null for implausible jump", () => {
            expect(meterDelta(2_000_000, 0)).to.be.null;
        });

        it("returns 0 for same value (unchanged meter)", () => {
            expect(meterDelta(100, 100)).to.equal(0);
        });
    });

    describe("integratePowerKwh", () => {
        it("integrates constant power over 30 seconds", () => {
            // 2000W for 30s: kWh = W * s / (1000 * 3600) = 2000 * 30 / 3_600_000
            const result = integratePowerKwh(2000, 2000, 0, 30_000);
            const expected = 2000 * 30 / 3_600_000; // ≈ 0.016667
            expect(result).to.be.closeTo(expected, 0.0000001);
        });

        it("integrates over 60 seconds (max boundary)", () => {
            // 3600W for 60s: kWh = 3600 * 60 / 3_600_000 = 0.06
            const result = integratePowerKwh(3600, 3600, 0, 60_000);
            expect(result).to.be.closeTo(0.06, 0.0001);
        });

        it("uses trapezoid rule for varying power over 30 seconds", () => {
            // avg = (0 + 2000)/2 = 1000W for 30s: kWh = 1000 * 30 / 3_600_000
            const result = integratePowerKwh(0, 2000, 0, 30_000);
            const expected = 1000 * 30 / 3_600_000;
            expect(result).to.be.closeTo(expected, 0.0000001);
        });

        it("returns null for gap > 60 seconds", () => {
            const result = integratePowerKwh(1000, 1000, 0, 70_000); // 70 seconds
            expect(result).to.be.null;
        });

        it("returns null when power values are null", () => {
            expect(integratePowerKwh(null, 1000, 0, 3600)).to.be.null;
            expect(integratePowerKwh(1000, null, 0, 3600)).to.be.null;
        });
    });

    describe("updateCounters", () => {
        const BASE_TIME = makeNow("2024-06-15T10:00:00Z"); // summer time Europe/Berlin (CEST = UTC+2)

        function makeData(): PersistenceData {
            return createEmptyPersistence(new Date(BASE_TIME - 60_000).toISOString());
        }

        it("accumulates solar from meter", () => {
            const data = makeData();
            data.today.lastSolarMeterKwh = 100;

            const result = updateCounters(data, {
                solarW: 3000, gridImportW: null, gridExportW: null,
                houseW: null, batteryChargeW: null, batteryDischargeW: null, evW: null,
                solarMeterKwh: 101, gridImportMeterKwh: null, gridExportMeterKwh: null,
                consumptionMeterKwh: null, batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null, evMeterKwh: null,
                nowMs: BASE_TIME,
            }, TZ);

            expect(result.todayEnergyPeriod.solar.value).to.be.closeTo(1, 0.01);
        });

        it("does not integrate across data gap > 60s", () => {
            const data = makeData();
            data.powerIntegration.lastTimestamp = BASE_TIME - 120_000; // 120s gap
            data.powerIntegration.lastSolarW = 3000;

            const result = updateCounters(data, {
                solarW: 3000, gridImportW: null, gridExportW: null,
                houseW: null, batteryChargeW: null, batteryDischargeW: null, evW: null,
                solarMeterKwh: null, gridImportMeterKwh: null, gridExportMeterKwh: null,
                consumptionMeterKwh: null, batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null, evMeterKwh: null,
                nowMs: BASE_TIME,
            }, TZ);

            // Gap > 60s: no integration
            expect(result.todayEnergyPeriod.solar.value).to.be.closeTo(0, 0.001);
        });

        it("resets daily accumulator on day boundary", () => {
            const data = makeData();
            data.today.solar = 15;
            data.today.periodStart = makeNow("2024-06-14T22:00:00Z").toString(); // yesterday in UTC = yesterday in CET

            const nextDay = makeNow("2024-06-15T22:10:00Z"); // June 16 in CEST (UTC+2)
            const result = updateCounters(data, {
                solarW: 0, gridImportW: null, gridExportW: null,
                houseW: null, batteryChargeW: null, batteryDischargeW: null, evW: null,
                solarMeterKwh: null, gridImportMeterKwh: null, gridExportMeterKwh: null,
                consumptionMeterKwh: null, batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null, evMeterKwh: null,
                nowMs: nextDay,
            }, TZ);

            // Daily accumulator should be reset
            expect(result.data.today.solar).to.be.closeTo(0, 0.001);
            // And archived record should exist
            expect(result.data.dailyHistory.length).to.be.gte(1);
        });

        it("prevents duplicate accounting via meter delta", () => {
            const data = makeData();
            data.today.lastGridImportMeterKwh = 500;
            data.today.gridImport = 5;

            const result1 = updateCounters(data, {
                solarW: null, gridImportW: null, gridExportW: null,
                houseW: null, batteryChargeW: null, batteryDischargeW: null, evW: null,
                solarMeterKwh: null, gridImportMeterKwh: 502, gridExportMeterKwh: null,
                consumptionMeterKwh: null, batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null, evMeterKwh: null,
                nowMs: BASE_TIME,
            }, TZ);

            expect(result1.todayEnergyPeriod.gridImport.value).to.be.closeTo(7, 0.01); // 5 + 2

            // Call again with same meter reading → delta = 0
            const result2 = updateCounters(result1.data, {
                solarW: null, gridImportW: null, gridExportW: null,
                houseW: null, batteryChargeW: null, batteryDischargeW: null, evW: null,
                solarMeterKwh: null, gridImportMeterKwh: 502, gridExportMeterKwh: null,
                consumptionMeterKwh: null, batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null, evMeterKwh: null,
                nowMs: BASE_TIME + 5000,
            }, TZ);

            expect(result2.todayEnergyPeriod.gridImport.value).to.be.closeTo(7, 0.01); // no double count
        });
    });

    describe("DST transitions – Europe/Berlin", () => {
        it("handles spring forward (23:59 → 03:00)", () => {
            // Spring forward: 2024-03-31 02:00 → 03:00, day has 23 hours
            const beforeDst = makeNow("2024-03-31T00:59:00Z"); // 01:59 CET
            const afterDst = makeNow("2024-03-31T01:01:00Z");  // 03:01 CEST (after spring forward)
            const d1 = getLocalDateString(new Date(beforeDst), TZ);
            const d2 = getLocalDateString(new Date(afterDst), TZ);
            expect(d1).to.equal("2024-03-31");
            expect(d2).to.equal("2024-03-31");
        });

        it("handles fall back (02:59 → 02:00)", () => {
            // Fall back: 2024-10-27 03:00 → 02:00, day has 25 hours
            const beforeFall = makeNow("2024-10-27T00:59:00Z"); // 02:59 CEST
            const afterFall = makeNow("2024-10-27T01:01:00Z");  // 02:01 CET
            const d1 = getLocalDateString(new Date(beforeFall), TZ);
            const d2 = getLocalDateString(new Date(afterFall), TZ);
            // Both should be same day
            expect(d1).to.equal("2024-10-27");
            expect(d2).to.equal("2024-10-27");
        });
    });

    describe("Solar statistics", () => {
        function makeRecord(date: string, solar: number | null, complete = true): DailyRecord {
            return {
                date, solar, consumption: 10, gridImport: 2, gridExport: 5,
                batteryCharge: 1, batteryDischarge: 1, evCharging: 0,
                peakSolarW: solar !== null ? solar * 250 : null,
                peakSolarTime: "13:00", complete, estimatedAllocation: false,
            };
        }

        it("calculates highest, lowest, average from complete days", () => {
            const history: DailyRecord[] = [
                makeRecord("2024-06-01", 20),
                makeRecord("2024-06-02", 5),
                makeRecord("2024-06-03", 30),
            ];
            const stats = calculateSolarStatistics(history, Date.now());
            expect(stats.highestDayKwh.value).to.equal(30);
            expect(stats.highestDayDate).to.equal("2024-06-03");
            expect(stats.lowestDayKwh.value).to.equal(5);
            expect(stats.lowestDayDate).to.equal("2024-06-02");
            expect(stats.averageDayKwh.value).to.be.closeTo((20 + 5 + 30) / 3, 0.001);
        });

        it("excludes incomplete days by default", () => {
            const history: DailyRecord[] = [
                makeRecord("2024-06-01", 20, true),
                makeRecord("2024-06-02", 50, false), // incomplete - today
            ];
            const stats = calculateSolarStatistics(history, Date.now());
            expect(stats.highestDayKwh.value).to.equal(20);
            expect(stats.daysIncluded).to.equal(1);
            expect(stats.daysExcluded).to.equal(1);
        });

        it("returns null for empty history", () => {
            const stats = calculateSolarStatistics([], Date.now());
            expect(stats.highestDayKwh.value).to.be.null;
            expect(stats.averageDayKwh.value).to.be.null;
        });

        it("does not count days with null solar (missing data)", () => {
            const history: DailyRecord[] = [
                makeRecord("2024-06-01", 20, true),
                makeRecord("2024-06-02", null, true), // missing data
            ];
            const stats = calculateSolarStatistics(history, Date.now());
            // Only day with valid data
            expect(stats.daysIncluded).to.equal(1);
        });
    });
});
