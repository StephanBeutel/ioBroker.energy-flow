"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const normalizer_1 = require("./lib/normalizer");
const powerBalance_1 = require("./lib/powerBalance");
const energyFlows_1 = require("./lib/energyFlows");
const energyCounter_1 = require("./lib/energyCounter");
const persistence_1 = require("./lib/persistence");
const stateManager_1 = require("./lib/stateManager");
const demoMode_1 = require("./lib/demoMode");
const ADAPTER_NAME = "energy-flow";
const UPDATE_MIN_INTERVAL_MS = 1000;
function unavailable(ts) {
    return {
        value: null,
        quality: { provenance: "measured", availability: "unavailable", freshness: "current", timestamp: ts },
    };
}
class EnergyFlowAdapter extends utils.Adapter {
    persistence;
    stateManager;
    updateTimer = null;
    subscribedIds = new Set();
    demoMode = false;
    demoScenarioIndex = 0;
    demoScenarios = [
        "solar-house-battery",
        "solar-house-grid-export",
        "battery-house",
        "grid-house-battery-charge",
        "empty-battery",
        "solar-house-ev",
        "grid-ev",
    ];
    constructor(options = {}) {
        super({ ...options, name: ADAPTER_NAME });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        this.persistence = new persistence_1.PersistenceManager(this);
        this.stateManager = new stateManager_1.StateManager(this);
        await this.stateManager.createObjects();
        await this.persistence.load();
        const cfg = this.config;
        if (!cfg || !cfg.timezone) {
            this.log.warn("No configuration found - using defaults");
        }
        await this.setState("info.connection", { val: true, ack: true });
        await this.setState("info.status", { val: "running", ack: true });
        await this.stateManager.setDiagnostics(true);
        // Subscribe to configured source objects
        await this.subscribeConfiguredSources();
        // Initial update
        await this.runUpdate();
        // Start periodic updates
        const intervalMs = Math.max(UPDATE_MIN_INTERVAL_MS, ((cfg?.dashboard?.updateIntervalSeconds ?? 10) * 1000));
        this.scheduleUpdate(intervalMs);
        this.log.info("Energy Flow adapter started");
    }
    async subscribeConfiguredSources() {
        const cfg = this.config;
        const ids = new Set();
        for (const src of cfg?.solar?.sources ?? []) {
            if (src.objectId)
                ids.add(src.objectId);
            if (src.energyObjectId)
                ids.add(src.energyObjectId);
        }
        const bat = cfg?.battery;
        if (bat?.powerObjectId)
            ids.add(bat.powerObjectId);
        if (bat?.socObjectId)
            ids.add(bat.socObjectId);
        if (bat?.chargingObjectId)
            ids.add(bat.chargingObjectId);
        if (bat?.dischargingObjectId)
            ids.add(bat.dischargingObjectId);
        if (bat?.energyChargingObjectId)
            ids.add(bat.energyChargingObjectId);
        if (bat?.energyDischargingObjectId)
            ids.add(bat.energyDischargingObjectId);
        const grid = cfg?.grid;
        if (grid?.powerObjectId)
            ids.add(grid.powerObjectId);
        if (grid?.importObjectId)
            ids.add(grid.importObjectId);
        if (grid?.exportObjectId)
            ids.add(grid.exportObjectId);
        if (grid?.importMeterObjectId)
            ids.add(grid.importMeterObjectId);
        if (grid?.exportMeterObjectId)
            ids.add(grid.exportMeterObjectId);
        const house = cfg?.house;
        if (house?.powerObjectId)
            ids.add(house.powerObjectId);
        if (house?.consumptionMeterObjectId)
            ids.add(house.consumptionMeterObjectId);
        const ev = cfg?.ev;
        if (ev?.enabled) {
            if (ev?.powerObjectId)
                ids.add(ev.powerObjectId);
            if (ev?.chargingMeterObjectId)
                ids.add(ev.chargingMeterObjectId);
        }
        // Filter out own adapter states and empty strings
        const myNamespace = this.namespace + ".";
        const filtered = [...ids].filter((id) => id && !id.startsWith(myNamespace));
        // Unsubscribe removed IDs
        for (const id of this.subscribedIds) {
            if (!filtered.includes(id)) {
                await this.unsubscribeForeignStatesAsync(id).catch(() => null);
                this.subscribedIds.delete(id);
            }
        }
        // Subscribe new IDs
        for (const id of filtered) {
            if (!this.subscribedIds.has(id)) {
                await this.subscribeForeignStatesAsync(id).catch(() => null);
                this.subscribedIds.add(id);
            }
        }
        this.log.debug(`Subscribed to ${this.subscribedIds.size} source states`);
    }
    onStateChange(_id, state) {
        if (!state || !state.ack)
            return;
        this.scheduleUpdate(100);
    }
    scheduleUpdate(delayMs) {
        if (this.updateTimer)
            return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.runUpdate().catch((err) => {
                this.log.error(`Update failed: ${String(err)}`);
            });
        }, delayMs);
    }
    async runUpdate() {
        const cfg = this.config;
        const nowMs = Date.now();
        if (this.demoMode) {
            const scenario = this.demoScenarios[this.demoScenarioIndex % this.demoScenarios.length];
            const snap = (0, demoMode_1.generateDemoSnapshot)(scenario, nowMs);
            await this.publishDashboardSnapshot(snap);
            return;
        }
        try {
            // Gather raw states
            const solar = await this.readSolarPower(cfg, nowMs);
            const battery = await this.readBatteryPower(cfg, nowMs);
            const grid = await this.readGridPower(cfg, nowMs);
            const houseDirect = await this.readHousePower(cfg, nowMs);
            const ev = cfg?.ev?.enabled ? await this.readEvPower(cfg, nowMs) : unavailable(nowMs);
            const batterySoc = await this.readBatterySoc(cfg, nowMs);
            // Power balance
            const { power: powerRaw } = (0, powerBalance_1.calculatePowerBalance)({
                solar, battery, grid, houseDirect, ev,
                batteryConfig: { enabled: cfg?.battery?.enabled ?? false },
                evConfig: {
                    enabled: cfg?.ev?.enabled ?? false,
                    includedInHousehold: cfg?.ev?.includedInHousehold ?? true,
                    chargingThresholdW: cfg?.ev?.chargingThresholdW ?? 100,
                    chargingHysteresisW: cfg?.ev?.chargingHysteresisW ?? 50,
                },
                balanceToleranceW: cfg?.house?.balanceToleranceW ?? 100,
                nowMs,
            });
            const power = { ...powerRaw, batterySoc };
            // Energy flows
            const battW = battery.value;
            const flows = (0, energyFlows_1.estimateFlows)({
                solarW: solar.value,
                batteryW: battW,
                gridW: grid.value,
                houseW: power.house.value,
                evW: ev.value,
                batteryConfig: {
                    enabled: cfg?.battery?.enabled ?? false,
                    gridChargingEnabled: cfg?.battery?.gridChargingEnabled ?? true,
                    gridExportEnabled: cfg?.battery?.gridExportEnabled ?? true,
                },
                evConfig: {
                    enabled: cfg?.ev?.enabled ?? false,
                    includedInHousehold: cfg?.ev?.includedInHousehold ?? true,
                },
                nowMs,
            });
            // Read meter values
            const meters = await this.readMeters(cfg, nowMs);
            // Decompose battery power
            const batteryChargeW = battW !== null && battW < 0 ? -battW : null;
            const batteryDischargeW = battW !== null && battW > 0 ? battW : null;
            const gridImportW = grid.value !== null && grid.value > 0 ? grid.value : null;
            const gridExportW = grid.value !== null && grid.value < 0 ? -grid.value : null;
            // Update energy counters
            const persData = this.persistence.get();
            const { data: newData, todayEnergyPeriod, monthEnergyPeriod, yearEnergyPeriod } = (0, energyCounter_1.updateCounters)(persData, {
                solarW: solar.value,
                gridImportW,
                gridExportW,
                houseW: power.house.value,
                batteryChargeW,
                batteryDischargeW,
                evW: ev.value,
                solarMeterKwh: meters.solar.value,
                gridImportMeterKwh: meters.gridImport.value,
                gridExportMeterKwh: meters.gridExport.value,
                consumptionMeterKwh: meters.consumption.value,
                batteryChargeMeterKwh: null,
                batteryDischargeMeterKwh: null,
                evMeterKwh: meters.evCharging.value,
                nowMs,
            }, cfg?.timezone ?? "Europe/Berlin");
            // Track peak solar power in today record
            const solar_kw = solar.value !== null ? solar.value / 1000 : null;
            if (solar_kw !== null && newData.today.solar !== undefined) {
                const localDate = (0, energyCounter_1.getLocalDateString)(new Date(nowMs), cfg?.timezone ?? "Europe/Berlin");
                const todayRec = newData.dailyHistory.find((r) => r.date === localDate);
                if (todayRec && (todayRec.peakSolarW === null || solar.value > todayRec.peakSolarW)) {
                    todayRec.peakSolarW = solar.value;
                    todayRec.peakSolarTime = new Date(nowMs).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: cfg?.timezone ?? "Europe/Berlin" });
                }
            }
            // Prune and save
            const prunedData = (0, energyCounter_1.pruneHistory)(newData, cfg?.history?.detailRetentionDays ?? 30);
            this.persistence.set(prunedData);
            // Calculate statistics
            const stats = (0, energyCounter_1.calculateSolarStatistics)(prunedData.dailyHistory, nowMs);
            // Detect conflicts
            const discrepancy = power.balanceDiscrepancyW.value ?? 0;
            const tolerance = cfg?.house?.balanceToleranceW ?? 100;
            const balanceConflict = Math.abs(discrepancy) > tolerance * 2;
            const evConflict = power.houseExcludingEv.quality?.note?.includes("CONFLICT") ?? false;
            // Write states
            await this.stateManager.updatePower(power, nowMs);
            await this.stateManager.updateFlows(flows);
            await this.stateManager.updateEnergy(todayEnergyPeriod, monthEnergyPeriod, yearEnergyPeriod);
            await this.stateManager.updateMeters(meters);
            await this.stateManager.updateStatistics(stats);
            await this.stateManager.setDiagnostics(true, "", balanceConflict, evConflict);
            // Store power history point
            const histPoint = {
                ts: nowMs,
                solar: solar.value,
                house: power.house.value,
                battery: battW,
                grid: grid.value,
                ev: ev.value,
            };
            this.persistence.addPowerHistoryPoint(histPoint);
            // Build and broadcast snapshot for web dashboard
            const snap = {
                power,
                flows,
                energy: { today: todayEnergyPeriod, month: monthEnergyPeriod, year: yearEnergyPeriod, total: prunedData.total },
                meters,
                stats,
                ts: nowMs,
                demo: false,
            };
            await this.publishDashboardSnapshot(snap);
        }
        catch (err) {
            this.log.error(`Error during update: ${String(err)}`);
            await this.stateManager.setDiagnostics(false, String(err));
        }
    }
    async readSolarPower(cfg, nowMs) {
        const sources = cfg?.solar?.sources ?? [];
        if (sources.length === 0)
            return unavailable(nowMs);
        const values = [];
        for (const src of sources) {
            if (!src.objectId)
                continue;
            const state = await this.getForeignStateAsync(src.objectId).catch(() => null);
            const normalized = (0, normalizer_1.normalizeRawState)(state, {
                unit: src.unit,
                factor: src.factor ?? 1,
                invert: src.invert ?? false,
                maxAgeSeconds: src.maxAgeSeconds ?? 300,
                minValue: src.minValue,
                maxValue: src.maxValue,
            }, nowMs);
            if (normalized.value !== null)
                values.push((0, normalizer_1.clampNonNegative)(normalized));
        }
        return values.length > 0 ? (0, normalizer_1.sumAvailable)(values, nowMs) : unavailable(nowMs);
    }
    async readBatteryPower(cfg, nowMs) {
        const bat = cfg?.battery;
        if (!bat?.enabled || !bat.powerObjectId)
            return unavailable(nowMs);
        const state = await this.getForeignStateAsync(bat.powerObjectId).catch(() => null);
        return (0, normalizer_1.normalizeRawState)(state, {
            unit: bat.powerUnit ?? "W",
            factor: bat.powerFactor ?? 1,
            invert: bat.powerInvert ?? false,
            maxAgeSeconds: bat.maxAgeSeconds ?? 300,
            minValue: bat.powerMinValue,
            maxValue: bat.powerMaxValue,
        }, nowMs);
    }
    async readBatterySoc(cfg, nowMs) {
        const bat = cfg?.battery;
        if (!bat?.enabled || !bat.socObjectId)
            return unavailable(nowMs);
        const state = await this.getForeignStateAsync(bat.socObjectId).catch(() => null);
        if (!state)
            return unavailable(nowMs);
        const raw = typeof state.val === "number" ? state.val : null;
        if (raw === null)
            return unavailable(nowMs);
        const value = Math.max(0, Math.min(100, raw));
        return (0, normalizer_1.makeMeasured)(value, state.ts ?? nowMs, bat.socObjectId);
    }
    async readGridPower(cfg, nowMs) {
        const grid = cfg?.grid;
        if (!grid?.powerObjectId) {
            // Try separate import/export
            if (grid?.importObjectId || grid?.exportObjectId) {
                return await this.readGridFromSeparate(cfg, nowMs);
            }
            return unavailable(nowMs);
        }
        const state = await this.getForeignStateAsync(grid.powerObjectId).catch(() => null);
        return (0, normalizer_1.normalizeRawState)(state, {
            unit: grid.powerUnit ?? "W",
            factor: grid.powerFactor ?? 1,
            invert: grid.powerInvert ?? false,
            maxAgeSeconds: grid.maxAgeSeconds ?? 300,
            minValue: grid.powerMinValue,
            maxValue: grid.powerMaxValue,
        }, nowMs);
    }
    async readGridFromSeparate(cfg, nowMs) {
        const grid = cfg?.grid;
        let importW = 0, exportW = 0;
        if (grid?.importObjectId) {
            const s = await this.getForeignStateAsync(grid.importObjectId).catch(() => null);
            const n = (0, normalizer_1.normalizeRawState)(s, { unit: grid.powerUnit ?? "W", factor: grid.powerFactor ?? 1, invert: false, maxAgeSeconds: grid.maxAgeSeconds ?? 300 }, nowMs);
            if (n.value !== null)
                importW = Math.max(0, n.value);
        }
        if (grid?.exportObjectId) {
            const s = await this.getForeignStateAsync(grid.exportObjectId).catch(() => null);
            const n = (0, normalizer_1.normalizeRawState)(s, { unit: grid.powerUnit ?? "W", factor: grid.powerFactor ?? 1, invert: false, maxAgeSeconds: grid.maxAgeSeconds ?? 300 }, nowMs);
            if (n.value !== null)
                exportW = Math.max(0, n.value);
        }
        return (0, normalizer_1.makeEstimated)(importW - exportW, nowMs, "derived from separate import/export");
    }
    async readHousePower(cfg, nowMs) {
        const house = cfg?.house;
        if (!house?.powerObjectId)
            return unavailable(nowMs);
        const state = await this.getForeignStateAsync(house.powerObjectId).catch(() => null);
        return (0, normalizer_1.normalizeRawState)(state, {
            unit: house.powerUnit ?? "W",
            factor: house.powerFactor ?? 1,
            invert: false,
            maxAgeSeconds: house.maxAgeSeconds ?? 300,
        }, nowMs);
    }
    async readEvPower(cfg, nowMs) {
        const ev = cfg?.ev;
        if (!ev?.enabled || !ev.powerObjectId)
            return unavailable(nowMs);
        const state = await this.getForeignStateAsync(ev.powerObjectId).catch(() => null);
        const n = (0, normalizer_1.normalizeRawState)(state, {
            unit: ev.powerUnit ?? "W",
            factor: ev.powerFactor ?? 1,
            invert: false,
            maxAgeSeconds: ev.maxAgeSeconds ?? 300,
            minValue: ev.powerMinValue,
            maxValue: ev.powerMaxValue,
        }, nowMs);
        // Flag negative EV power (bidirectional not supported)
        if (n.value !== null && n.value < 0) {
            return {
                value: null,
                quality: {
                    provenance: "measured",
                    availability: "unavailable",
                    freshness: "current",
                    timestamp: nowMs,
                    note: `Negative EV power not supported: ${n.value}W`,
                },
            };
        }
        return n;
    }
    async readMeters(cfg, nowMs) {
        const readMeter = async (objectId, unit = "kWh", factor = 1) => {
            if (!objectId)
                return unavailable(nowMs);
            const state = await this.getForeignStateAsync(objectId).catch(() => null);
            return (0, normalizer_1.normalizeRawState)(state, {
                unit,
                factor,
                invert: false,
                maxAgeSeconds: 86400, // meters can be stale for up to 1 day
            }, nowMs);
        };
        return {
            gridImport: await readMeter(cfg?.grid?.importMeterObjectId, cfg?.grid?.importMeterUnit ?? "kWh", cfg?.grid?.importMeterFactor ?? 1),
            gridExport: await readMeter(cfg?.grid?.exportMeterObjectId, cfg?.grid?.exportMeterUnit ?? "kWh", cfg?.grid?.exportMeterFactor ?? 1),
            solar: unavailable(nowMs), // Solar meter handled per-source
            consumption: await readMeter(cfg?.house?.consumptionMeterObjectId, cfg?.house?.consumptionMeterUnit ?? "kWh", cfg?.house?.consumptionMeterFactor ?? 1),
            evCharging: await readMeter(cfg?.ev?.chargingMeterObjectId, cfg?.ev?.chargingMeterUnit ?? "kWh", cfg?.ev?.chargingMeterFactor ?? 1),
        };
    }
    async publishDashboardSnapshot(snap) {
        // Store latest snapshot for web requests via sendTo
        this._lastSnapshot = snap;
    }
    _lastSnapshot = null;
    onMessage(obj) {
        if (typeof obj !== "object" || !obj.message)
            return;
        switch (obj.command) {
            case "getSnapshot":
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, this._lastSnapshot, obj.callback);
                }
                break;
            case "getPowerHistory": {
                const limitHours = typeof obj.message === "object" && obj.message.hours
                    ? obj.message.hours
                    : 24;
                const history = this.persistence.getPowerHistory(limitHours);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, history, obj.callback);
                }
                break;
            }
            case "getDailyBars": {
                const data = this.persistence.get();
                const bars = data.dailyHistory.map((r) => ({
                    date: r.date,
                    kWh: r.solar,
                    complete: r.complete,
                }));
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, bars, obj.callback);
                }
                break;
            }
            case "enableDemo":
                this.demoMode = true;
                this.demoScenarioIndex = 0;
                this.log.info("Demo mode enabled");
                if (obj.callback)
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                break;
            case "disableDemo":
                this.demoMode = false;
                this.log.info("Demo mode disabled");
                if (obj.callback)
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                break;
            case "nextDemoScenario":
                this.demoScenarioIndex++;
                if (obj.callback)
                    this.sendTo(obj.from, obj.command, { scenario: this.demoScenarios[this.demoScenarioIndex % this.demoScenarios.length] }, obj.callback);
                break;
            default:
                if (obj.callback)
                    this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
        }
    }
    async onUnload(callback) {
        try {
            if (this.updateTimer) {
                clearTimeout(this.updateTimer);
                this.updateTimer = null;
            }
            await this.setState("info.connection", { val: false, ack: true });
            await this.setState("info.status", { val: "stopped", ack: true });
            await this.persistence.shutdown();
            callback();
        }
        catch (error) {
            this.log.error(`Error during unload: ${String(error)}`);
            callback();
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new EnergyFlowAdapter(options);
}
else {
    (() => new EnergyFlowAdapter())();
}
//# sourceMappingURL=main.js.map