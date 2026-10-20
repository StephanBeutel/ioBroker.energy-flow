import { expect } from "chai";
import { estimateFlows } from "./lib/energyFlows";

const now = 1700000000000;

const battCfg = { enabled: true, gridChargingEnabled: true, gridExportEnabled: true };
const evCfg = { enabled: false, includedInHousehold: true };

describe("Energy flows estimation", () => {
    it("solar → house when solar covers demand", () => {
        const flows = estimateFlows({
            solarW: 3000, batteryW: 0, gridW: 0, houseW: 2500, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.solarToHouse.value).to.be.closeTo(2500, 1);
        expect(flows.batteryToHouse.value).to.be.closeTo(0, 1);
        expect(flows.gridToHouse.value).to.be.closeTo(0, 1);
    });

    it("solar excess → grid export", () => {
        const flows = estimateFlows({
            solarW: 5000, batteryW: 0, gridW: -1500, houseW: 3500, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.solarToHouse.value).to.be.closeTo(3500, 1);
        expect(flows.solarToGrid.value).to.be.closeTo(1500, 1);
    });

    it("solar + battery → house when solar insufficient", () => {
        const flows = estimateFlows({
            solarW: 1000, batteryW: 1500, gridW: 0, houseW: 2500, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.solarToHouse.value).to.be.closeTo(1000, 5);
        expect(flows.batteryToHouse.value).to.be.closeTo(1500, 5);
        expect(flows.gridToHouse.value).to.be.closeTo(0, 5);
    });

    it("grid → house when no solar or battery", () => {
        const flows = estimateFlows({
            solarW: 0, batteryW: 0, gridW: 2000, houseW: 2000, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.gridToHouse.value).to.be.closeTo(2000, 1);
        expect(flows.solarToHouse.value).to.be.closeTo(0, 1);
    });

    it("solar → battery charging", () => {
        const flows = estimateFlows({
            solarW: 3000, batteryW: -800, gridW: -200, houseW: 2000, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.solarToBattery.value).to.be.closeTo(800, 100);
    });

    it("flows are non-negative", () => {
        const flows = estimateFlows({
            solarW: 500, batteryW: -200, gridW: -300, houseW: 0, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        for (const key of ["solarToHouse", "solarToBattery", "solarToGrid", "batteryToHouse", "batteryToGrid", "gridToHouse", "gridToBattery"] as const) {
            const v = flows[key]?.value;
            if (v !== null && v !== undefined) {
                expect(v).to.be.gte(-0.01, `${key} should be non-negative, got ${v}`);
            }
        }
    });

    it("grid charging disabled: no grid → battery flow", () => {
        const flows = estimateFlows({
            solarW: 0, batteryW: -1000, gridW: 2000, houseW: 1000, evW: null,
            batteryConfig: { ...battCfg, gridChargingEnabled: false },
            evConfig: evCfg, nowMs: now,
        });
        expect(flows.gridToBattery.value).to.be.closeTo(0, 1);
    });

    it("battery grid export disabled: no battery → grid flow", () => {
        const flows = estimateFlows({
            solarW: 0, batteryW: 2000, gridW: -500, houseW: 1000, evW: null,
            batteryConfig: { ...battCfg, gridExportEnabled: false },
            evConfig: evCfg, nowMs: now,
        });
        expect(flows.batteryToGrid.value).to.be.closeTo(0, 1);
    });

    it("all unavailable inputs → unavailable flows", () => {
        const flows = estimateFlows({
            solarW: null, batteryW: null, gridW: null, houseW: null, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.solarToHouse.value).to.be.null;
    });

    it("flows are marked estimated", () => {
        const flows = estimateFlows({
            solarW: 3000, batteryW: 0, gridW: 0, houseW: 2500, evW: null,
            batteryConfig: battCfg, evConfig: evCfg, nowMs: now,
        });
        expect(flows.flowsEstimated).to.be.true;
        expect(flows.solarToHouse.quality?.provenance).to.equal("estimated");
    });

    describe("EV charging flows", () => {
        it("solar → EV when solar covers both house and EV", () => {
            const flows = estimateFlows({
                solarW: 7000, batteryW: 0, gridW: -1000, houseW: 2500, evW: 3500,
                batteryConfig: battCfg,
                evConfig: { enabled: true, includedInHousehold: false },
                nowMs: now,
            });
            expect(flows.solarToEv.value).to.be.closeTo(3500, 200);
        });

        it("proportional allocation between house and EV", () => {
            const flows = estimateFlows({
                solarW: 2000, batteryW: 0, gridW: 2000, houseW: 2000, evW: 2000,
                batteryConfig: battCfg,
                evConfig: { enabled: true, includedInHousehold: false },
                nowMs: now,
            });
            // Total demand = 4000, solar = 2000, grid = 2000
            // Half to house, half to ev from each source
            expect(flows.solarToHouse.value).to.be.closeTo(1000, 100);
            expect(flows.solarToEv.value).to.be.closeTo(1000, 100);
        });

        it("EV disabled → no EV flows", () => {
            const flows = estimateFlows({
                solarW: 5000, batteryW: 0, gridW: 0, houseW: 2000, evW: 3000,
                batteryConfig: battCfg,
                evConfig: { enabled: false, includedInHousehold: true },
                nowMs: now,
            });
            expect(flows.solarToEv.value).to.be.closeTo(0, 1);
            expect(flows.gridToEv.value).to.be.closeTo(0, 1);
        });
    });
});
