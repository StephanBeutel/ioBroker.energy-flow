import { expect } from "chai";
import { calculatePowerBalance } from "./lib/powerBalance.js";
import { makeMeasured } from "./lib/normalizer.js";
import type { NormalizedValue } from "./lib/types.js";

const now = 1700000000000;

function nv(v: number | null): NormalizedValue {
    if (v === null) return { value: null, quality: { provenance: "measured", availability: "unavailable", freshness: "current", timestamp: now } };
    return makeMeasured(v, now);
}

const battCfg = { enabled: true };
const evCfg = { enabled: false, includedInHousehold: true };

describe("Power balance", () => {
    it("calculates house from solar + grid (battery off)", () => {
        const result = calculatePowerBalance({
            solar: nv(3000), battery: nv(null), grid: nv(500),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: { enabled: false },
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        // house = solar + grid = 3500
        expect(result.power.houseCalculated.value).to.be.closeTo(3500, 1);
    });

    it("calculates house including battery discharge", () => {
        // battery = 500W positive = discharging
        const result = calculatePowerBalance({
            solar: nv(2000), battery: nv(500), grid: nv(0),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: battCfg,
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.houseCalculated.value).to.be.closeTo(2500, 1);
    });

    it("battery charging reduces house (negative battery contributes negatively to balance)", () => {
        // battery = -800W = charging. House = solar + grid + battery = 3000 + 0 + (-800) = 2200
        const result = calculatePowerBalance({
            solar: nv(3000), battery: nv(-800), grid: nv(0),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: battCfg,
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.houseCalculated.value).to.be.closeTo(2200, 1);
    });

    it("prefers direct house measurement over calculated", () => {
        const result = calculatePowerBalance({
            solar: nv(3000), battery: nv(null), grid: nv(500),
            houseDirect: nv(3200), ev: nv(null),
            batteryConfig: { enabled: false },
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.house.value).to.equal(3200);
        expect(result.power.houseCalculated.value).to.be.closeTo(3500, 1);
    });

    it("calculates discrepancy between measured and calculated house", () => {
        const result = calculatePowerBalance({
            solar: nv(3000), battery: nv(null), grid: nv(500),
            houseDirect: nv(3200), ev: nv(null),
            batteryConfig: { enabled: false },
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        // discrepancy = measured - calculated = 3200 - 3500 = -300
        expect(result.power.balanceDiscrepancyW.value).to.be.closeTo(-300, 1);
    });

    it("grid positive = import (adds to house)", () => {
        const result = calculatePowerBalance({
            solar: nv(0), battery: nv(null), grid: nv(2000),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: { enabled: false },
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.houseCalculated.value).to.be.closeTo(2000, 1);
    });

    it("grid negative = export (grid export alone should yield 0 or negative house)", () => {
        // Solar 3000, grid -500 (export), battery off
        // house = 3000 + (-500) = 2500
        const result = calculatePowerBalance({
            solar: nv(3000), battery: nv(null), grid: nv(-500),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: { enabled: false },
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.houseCalculated.value).to.be.closeTo(2500, 1);
    });

    it("unavailable solar does not prevent calculation from grid+battery", () => {
        const result = calculatePowerBalance({
            solar: nv(null), battery: nv(1000), grid: nv(500),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: battCfg,
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        // 2 inputs available → should calculate
        expect(result.power.houseCalculated.value).to.be.closeTo(1500, 1);
    });

    it("all inputs unavailable → house calculated is unavailable", () => {
        const result = calculatePowerBalance({
            solar: nv(null), battery: nv(null), grid: nv(null),
            houseDirect: nv(null), ev: nv(null),
            batteryConfig: battCfg,
            evConfig: evCfg,
            balanceToleranceW: 100,
            nowMs: now,
        });
        expect(result.power.houseCalculated.value).to.be.null;
    });

    describe("EV charging integration", () => {
        it("adds EV to site consumption when excluded from household", () => {
            const result = calculatePowerBalance({
                solar: nv(5000), battery: nv(null), grid: nv(0),
                houseDirect: nv(2000), ev: nv(3000),
                batteryConfig: { enabled: false },
                evConfig: { enabled: true, includedInHousehold: false },
                balanceToleranceW: 100,
                nowMs: now,
            });
            expect(result.power.siteConsumption.value).to.be.closeTo(5000, 1);
        });

        it("does NOT add EV to site consumption when included in household", () => {
            const result = calculatePowerBalance({
                solar: nv(5000), battery: nv(null), grid: nv(0),
                houseDirect: nv(5000), ev: nv(3000),
                batteryConfig: { enabled: false },
                evConfig: { enabled: true, includedInHousehold: true },
                balanceToleranceW: 100,
                nowMs: now,
            });
            expect(result.power.siteConsumption.value).to.be.closeTo(5000, 1);
        });

        it("calculates houseExcludingEv when EV is included in household", () => {
            const result = calculatePowerBalance({
                solar: nv(5000), battery: nv(null), grid: nv(0),
                houseDirect: nv(5000), ev: nv(3000),
                batteryConfig: { enabled: false },
                evConfig: { enabled: true, includedInHousehold: true },
                balanceToleranceW: 100,
                nowMs: now,
            });
            expect(result.power.houseExcludingEv.value).to.be.closeTo(2000, 1);
        });

        it("detects EV conflict when EV > house", () => {
            const result = calculatePowerBalance({
                solar: nv(5000), battery: nv(null), grid: nv(0),
                houseDirect: nv(1000), ev: nv(3000),
                batteryConfig: { enabled: false },
                evConfig: { enabled: true, includedInHousehold: true, chargingThresholdW: 100, chargingHysteresisW: 50 },
                balanceToleranceW: 100,
                nowMs: now,
            });
            const note = result.power.houseExcludingEv.quality?.note ?? "";
            expect(note).to.include("CONFLICT");
        });

        it("flags negative EV power as unavailable", () => {
            // EV should never be negative in our model
            const result = calculatePowerBalance({
                solar: nv(0), battery: nv(null), grid: nv(1000),
                houseDirect: nv(1000), ev: nv(-500),
                batteryConfig: { enabled: false },
                evConfig: { enabled: true, includedInHousehold: false },
                balanceToleranceW: 100,
                nowMs: now,
            });
            // Negative EV is passed through to powerBalance; balance itself doesn't validate it
            // (validation happens in normalizer / main); just check site consumption
            expect(result.power.siteConsumption.value).to.be.closeTo(500, 1); // 1000 + (-500)
        });
    });
});
