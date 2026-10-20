import { expect } from "chai";
import {
    normalizeToW,
    normalizeToKwh,
    normalizeRawState,
    sumAvailable,
    clampNonNegative,
    makeMeasured,
} from "./lib/normalizer";

describe("Normalizer – units and sign conventions", () => {
    describe("normalizeToW", () => {
        it("converts kW to W", () => {
            expect(normalizeToW(5, "kW", 1, false)).to.equal(5000);
        });

        it("applies factor before kW conversion", () => {
            expect(normalizeToW(2, "kW", 0.5, false)).to.equal(1000);
        });

        it("inverts sign when requested", () => {
            expect(normalizeToW(100, "W", 1, true)).to.equal(-100);
        });

        it("W passes through unchanged", () => {
            expect(normalizeToW(500, "W", 1, false)).to.equal(500);
        });
    });

    describe("normalizeToKwh", () => {
        it("converts Wh to kWh", () => {
            expect(normalizeToKwh(1000, "Wh", 1)).to.equal(1);
        });

        it("kWh passes through", () => {
            expect(normalizeToKwh(5.5, "kWh", 1)).to.equal(5.5);
        });

        it("applies factor", () => {
            expect(normalizeToKwh(2000, "Wh", 0.5)).to.equal(1);
        });
    });

    describe("normalizeRawState", () => {
        const now = 1700000000000;

        it("returns unavailable for null state", () => {
            const result = normalizeRawState(null, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.value).to.be.null;
            expect(result.quality.availability).to.equal("unavailable");
        });

        it("returns unavailable for NaN value", () => {
            const state = { val: NaN, ts: now, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.value).to.be.null;
        });

        it("returns unavailable for Infinity value", () => {
            const state = { val: Infinity, ts: now, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.value).to.be.null;
        });

        it("marks stale when age exceeds maxAgeSeconds", () => {
            const staleTs = now - 400_000; // 400 seconds old
            const state = { val: 100, ts: staleTs, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.value).to.equal(100);
            expect(result.quality.freshness).to.equal("stale");
        });

        it("marks current when within maxAgeSeconds", () => {
            const state = { val: 100, ts: now - 100_000, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.quality.freshness).to.equal("current");
        });

        it("rejects values below minValue", () => {
            const state = { val: -10, ts: now, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300, minValue: 0 }, now);
            expect(result.value).to.be.null;
        });

        it("rejects values above maxValue", () => {
            const state = { val: 50000, ts: now, ack: true } as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300, maxValue: 20000 }, now);
            expect(result.value).to.be.null;
        });

        it("parses string numbers", () => {
            const state = { val: "1234.5", ts: now, ack: true } as unknown as ioBroker.State;
            const result = normalizeRawState(state, { unit: "W", factor: 1, invert: false, maxAgeSeconds: 300 }, now);
            expect(result.value).to.equal(1234.5);
        });
    });

    describe("sumAvailable", () => {
        const now = 1700000000000;

        it("sums available values", () => {
            const a = makeMeasured(100, now);
            const b = makeMeasured(200, now);
            const result = sumAvailable([a, b], now);
            expect(result.value).to.equal(300);
        });

        it("ignores null values", () => {
            const a = makeMeasured(100, now);
            const b = { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "current" as const, timestamp: now } };
            const result = sumAvailable([a, b], now);
            expect(result.value).to.equal(100);
        });

        it("returns unavailable when all null", () => {
            const a = { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "current" as const, timestamp: now } };
            const result = sumAvailable([a], now);
            expect(result.value).to.be.null;
            expect(result.quality.availability).to.equal("unavailable");
        });
    });

    describe("clampNonNegative", () => {
        const now = 1700000000000;

        it("clamps negative to 0", () => {
            const v = makeMeasured(-100, now);
            const result = clampNonNegative(v);
            expect(result.value).to.equal(0);
        });

        it("passes through positive", () => {
            const v = makeMeasured(500, now);
            expect(clampNonNegative(v).value).to.equal(500);
        });

        it("passes through null", () => {
            const v = { value: null as null, quality: { provenance: "measured" as const, availability: "unavailable" as const, freshness: "current" as const, timestamp: now } };
            expect(clampNonNegative(v).value).to.be.null;
        });
    });
});
