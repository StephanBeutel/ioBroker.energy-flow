import { expect } from "chai";
import { generateDemoSnapshot } from "./lib/demoMode";

describe("Demo mode", () => {
    const now = Date.now();

    it("produces non-null snapshot", () => {
        const snap = generateDemoSnapshot("solar-house-battery", now);
        expect(snap).to.exist;
        expect(snap.demo).to.be.true;
    });

    it("solar-house-battery: solar positive, battery charging (negative)", () => {
        const snap = generateDemoSnapshot("solar-house-battery", now);
        expect(snap.power.solar.value).to.be.gt(0);
        expect(snap.power.battery.value).to.be.lt(0); // charging = negative
        expect(snap.power.batteryStatus).to.equal("charging");
    });

    it("battery-house: battery discharging (positive)", () => {
        const snap = generateDemoSnapshot("battery-house", now);
        expect(snap.power.battery.value).to.be.gt(0);
        expect(snap.power.batteryStatus).to.equal("discharging");
    });

    it("grid-house-battery-charge: grid importing", () => {
        const snap = generateDemoSnapshot("grid-house-battery-charge", now);
        expect(snap.power.grid.value).to.be.gt(0); // positive = import
    });

    it("solar-house-grid-export: grid exporting (negative)", () => {
        const snap = generateDemoSnapshot("solar-house-grid-export", now);
        expect(snap.power.grid.value).to.be.lt(0); // negative = export
    });

    it("empty-battery: SOC is 0", () => {
        const snap = generateDemoSnapshot("empty-battery", now);
        expect(snap.power.batterySoc.value).to.equal(0);
    });

    it("solar-house-ev: EV charging active", () => {
        const snap = generateDemoSnapshot("solar-house-ev", now);
        expect(snap.power.evCharging.value).to.be.gt(0);
        expect(snap.power.evStatus).to.equal("charging");
    });

    it("grid-ev: grid charging EV", () => {
        const snap = generateDemoSnapshot("grid-ev", now);
        expect(snap.power.grid.value).to.be.gt(0); // importing
        expect(snap.power.evCharging.value).to.be.gt(0);
    });

    it("has energy data for today, month, year", () => {
        const snap = generateDemoSnapshot("solar-house-battery", now);
        expect(snap.energy.today.solar.value).to.be.gt(0);
        expect(snap.energy.month.solar.value).to.be.gt(0);
        expect(snap.energy.year.solar.value).to.be.gt(0);
    });

    it("has statistics data", () => {
        const snap = generateDemoSnapshot("solar-house-battery", now);
        expect(snap.stats.highestDayKwh.value).to.be.gt(0);
        expect(snap.stats.averageDayKwh.value).to.be.gt(0);
    });

    it("flows are marked estimated", () => {
        const snap = generateDemoSnapshot("solar-house-battery", now);
        expect(snap.flows.flowsEstimated).to.be.true;
    });

    it("stale-data scenario: solar is unavailable", () => {
        const snap = generateDemoSnapshot("stale-data", now);
        expect(snap.power.solar.value).to.be.null;
        expect(snap.power.solar.quality.freshness).to.equal("stale");
    });
});
