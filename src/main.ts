import * as utils from "@iobroker/adapter-core";
import type {
    AdapterConfig,
    NormalizedValue,
    PowerState,
    EnergyFlows,
    MeterReadings,
    DashboardSnapshot,
    PowerHistoryPoint,
} from "./lib/types";
import { normalizeRawState, makeEstimated, makeMeasured, clampNonNegative, sumAvailable } from "./lib/normalizer";
import { calculatePowerBalance } from "./lib/powerBalance";
import { estimateFlows } from "./lib/energyFlows";
import { updateCounters, calculateSolarStatistics, pruneHistory, getLocalDateString } from "./lib/energyCounter";
import { PersistenceManager } from "./lib/persistence";
import { StateManager } from "./lib/stateManager";
import { generateDemoSnapshot } from "./lib/demoMode";

const ADAPTER_NAME = "energy-flow";
const UPDATE_MIN_INTERVAL_MS = 1000;

function unavailable(ts: number): NormalizedValue {
    return {
        value: null,
        quality: { provenance: "measured", availability: "unavailable", freshness: "current", timestamp: ts },
    };
}

class EnergyFlowAdapter extends utils.Adapter {
    private persistence!: PersistenceManager;
    private stateManager!: StateManager;
    private updateTimer: ReturnType<typeof setTimeout> | null = null;
    private subscribedIds = new Set<string>();
    private demoMode = false;
    private demoScenarioIndex = 0;
    private readonly demoScenarios = [
        "solar-house-battery",
        "solar-house-grid-export",
        "battery-house",
        "grid-house-battery-charge",
        "empty-battery",
        "solar-house-ev",
        "grid-ev",
    ] as const;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: ADAPTER_NAME });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.persistence = new PersistenceManager(this as unknown as utils.AdapterInstance);
        this.stateManager = new StateManager(this as unknown as utils.AdapterInstance);

        await this.stateManager.createObjects();
        await this.persistence.load();

        const cfg = this.config as unknown as AdapterConfig;
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
        const intervalMs = Math.max(
            UPDATE_MIN_INTERVAL_MS,
            ((cfg?.dashboard?.updateIntervalSeconds ?? 10) * 1000),
        );
        this.scheduleUpdate(intervalMs);

        this.log.info("Energy Flow adapter started");
    }

    private async subscribeConfiguredSources(): Promise<void> {
        const cfg = this.config as unknown as AdapterConfig;
        const ids = new Set<string>();

        for (const src of cfg?.solar?.sources ?? []) {
            if (src.objectId) ids.add(src.objectId);
            if (src.energyObjectId) ids.add(src.energyObjectId);
        }

        const bat = cfg?.battery;
        if (bat?.powerObjectId) ids.add(bat.powerObjectId);
        if (bat?.socObjectId) ids.add(bat.socObjectId);
        if (bat?.chargingObjectId) ids.add(bat.chargingObjectId);
        if (bat?.dischargingObjectId) ids.add(bat.dischargingObjectId);
        if (bat?.energyChargingObjectId) ids.add(bat.energyChargingObjectId);
        if (bat?.energyDischargingObjectId) ids.add(bat.energyDischargingObjectId);

        const grid = cfg?.grid;
        if (grid?.powerObjectId) ids.add(grid.powerObjectId);
        if (grid?.importObjectId) ids.add(grid.importObjectId);
        if (grid?.exportObjectId) ids.add(grid.exportObjectId);
        if (grid?.importMeterObjectId) ids.add(grid.importMeterObjectId);
        if (grid?.exportMeterObjectId) ids.add(grid.exportMeterObjectId);

        const house = cfg?.house;
        if (house?.powerObjectId) ids.add(house.powerObjectId);
        if (house?.consumptionMeterObjectId) ids.add(house.consumptionMeterObjectId);

        const ev = cfg?.ev;
        if (ev?.enabled) {
            if (ev?.powerObjectId) ids.add(ev.powerObjectId);
            if (ev?.chargingMeterObjectId) ids.add(ev.chargingMeterObjectId);
        }

        // Filter out own adapter states and empty strings
        const myNamespace = this.namespace + ".";
        const filtered = [...ids].filter(
            (id) => id && !id.startsWith(myNamespace)
        );

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

    private onStateChange(_id: string, state: ioBroker.State | null | undefined): void {
        if (!state || !state.ack) return;
        this.scheduleUpdate(100);
    }

    private scheduleUpdate(delayMs: number): void {
        if (this.updateTimer) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.runUpdate().catch((err) => {
                this.log.error(`Update failed: ${String(err)}`);
            });
        }, delayMs);
    }

    private async runUpdate(): Promise<void> {
        const cfg = this.config as unknown as AdapterConfig;
        const nowMs = Date.now();

        if (this.demoMode) {
            const scenario = this.demoScenarios[this.demoScenarioIndex % this.demoScenarios.length];
            const snap = generateDemoSnapshot(scenario, nowMs);
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
            const { power: powerRaw } = calculatePowerBalance({
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

            const power: PowerState = { ...powerRaw, batterySoc };

            // Energy flows
            const battW = battery.value;
            const flows: EnergyFlows = estimateFlows({
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
            const { data: newData, todayEnergyPeriod, monthEnergyPeriod, yearEnergyPeriod } = updateCounters(
                persData,
                {
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
                    batteryChargeMeterKwh: meters.batteryCharge.value,
                    batteryDischargeMeterKwh: meters.batteryDischarge.value,
                    evMeterKwh: meters.evCharging.value,
                    nowMs,
                },
                cfg?.timezone ?? "Europe/Berlin",
            );

            // Track peak solar power in today record
            const solar_kw = solar.value !== null ? solar.value / 1000 : null;
            if (solar_kw !== null && newData.today.solar !== undefined) {
                const localDate = getLocalDateString(new Date(nowMs), cfg?.timezone ?? "Europe/Berlin");
                const todayRec = newData.dailyHistory.find((r) => r.date === localDate);
                if (todayRec && (todayRec.peakSolarW === null || solar.value! > todayRec.peakSolarW)) {
                    todayRec.peakSolarW = solar.value!;
                    todayRec.peakSolarTime = new Date(nowMs).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: cfg?.timezone ?? "Europe/Berlin" });
                }
            }

            // Prune and save
            const prunedData = pruneHistory(newData, cfg?.history?.detailRetentionDays ?? 30);
            this.persistence.set(prunedData);

            // Calculate statistics
            const stats = calculateSolarStatistics(prunedData.dailyHistory, nowMs);

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
            const histPoint: PowerHistoryPoint = {
                ts: nowMs,
                solar: solar.value,
                house: power.house.value,
                battery: battW,
                grid: grid.value,
                ev: ev.value,
            };
            this.persistence.addPowerHistoryPoint(histPoint);

            // Build and broadcast snapshot for web dashboard
            const snap: DashboardSnapshot = {
                power,
                flows,
                energy: { today: todayEnergyPeriod, month: monthEnergyPeriod, year: yearEnergyPeriod, total: prunedData.total },
                meters,
                stats,
                ts: nowMs,
                demo: false,
            };
            await this.publishDashboardSnapshot(snap);

        } catch (err) {
            this.log.error(`Error during update: ${String(err)}`);
            await this.stateManager.setDiagnostics(false, String(err));
        }
    }

    private async readSolarPower(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const sources = cfg?.solar?.sources ?? [];
        if (sources.length === 0) return unavailable(nowMs);

        const values: NormalizedValue[] = [];
        for (const src of sources) {
            if (!src.objectId) continue;
            const state = await this.getForeignStateAsync(src.objectId).catch(() => null);
            const normalized = normalizeRawState(state as ioBroker.State | null, {
                unit: src.unit as "W" | "kW",
                factor: src.factor ?? 1,
                invert: src.invert ?? false,
                maxAgeSeconds: src.maxAgeSeconds ?? 300,
                minValue: src.minValue,
                maxValue: src.maxValue,
            }, nowMs);
            if (normalized.value !== null) values.push(clampNonNegative(normalized));
        }

        return values.length > 0 ? sumAvailable(values, nowMs) : unavailable(nowMs);
    }

    private async readBatteryPower(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const bat = cfg?.battery;
        if (!bat?.enabled || !bat.powerObjectId) return unavailable(nowMs);

        const state = await this.getForeignStateAsync(bat.powerObjectId).catch(() => null);
        return normalizeRawState(state as ioBroker.State | null, {
            unit: bat.powerUnit ?? "W",
            factor: bat.powerFactor ?? 1,
            invert: bat.powerInvert ?? false,
            maxAgeSeconds: bat.maxAgeSeconds ?? 300,
            minValue: bat.powerMinValue,
            maxValue: bat.powerMaxValue,
        }, nowMs);
    }

    private async readBatterySoc(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const bat = cfg?.battery;
        if (!bat?.enabled || !bat.socObjectId) return unavailable(nowMs);

        const state = await this.getForeignStateAsync(bat.socObjectId).catch(() => null);
        if (!state) return unavailable(nowMs);
        const raw = typeof state.val === "number" ? state.val : null;
        if (raw === null) return unavailable(nowMs);
        const value = Math.max(0, Math.min(100, raw));
        return makeMeasured(value, state.ts ?? nowMs, bat.socObjectId);
    }

    private async readGridPower(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const grid = cfg?.grid;
        if (!grid?.powerObjectId) {
            // Try separate import/export
            if (grid?.importObjectId || grid?.exportObjectId) {
                return await this.readGridFromSeparate(cfg, nowMs);
            }
            return unavailable(nowMs);
        }

        const state = await this.getForeignStateAsync(grid.powerObjectId).catch(() => null);
        return normalizeRawState(state as ioBroker.State | null, {
            unit: grid.powerUnit ?? "W",
            factor: grid.powerFactor ?? 1,
            invert: grid.powerInvert ?? false,
            maxAgeSeconds: grid.maxAgeSeconds ?? 300,
            minValue: grid.powerMinValue,
            maxValue: grid.powerMaxValue,
        }, nowMs);
    }

    private async readGridFromSeparate(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const grid = cfg?.grid;
        let importW = 0, exportW = 0;

        if (grid?.importObjectId) {
            const s = await this.getForeignStateAsync(grid.importObjectId).catch(() => null);
            const n = normalizeRawState(s as ioBroker.State | null, { unit: grid.powerUnit ?? "W", factor: grid.powerFactor ?? 1, invert: false, maxAgeSeconds: grid.maxAgeSeconds ?? 300 }, nowMs);
            if (n.value !== null) importW = Math.max(0, n.value);
        }
        if (grid?.exportObjectId) {
            const s = await this.getForeignStateAsync(grid.exportObjectId).catch(() => null);
            const n = normalizeRawState(s as ioBroker.State | null, { unit: grid.powerUnit ?? "W", factor: grid.powerFactor ?? 1, invert: false, maxAgeSeconds: grid.maxAgeSeconds ?? 300 }, nowMs);
            if (n.value !== null) exportW = Math.max(0, n.value);
        }

        return makeEstimated(importW - exportW, nowMs, "derived from separate import/export");
    }

    private async readHousePower(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const house = cfg?.house;
        if (!house?.powerObjectId) return unavailable(nowMs);

        const state = await this.getForeignStateAsync(house.powerObjectId).catch(() => null);
        return normalizeRawState(state as ioBroker.State | null, {
            unit: house.powerUnit ?? "W",
            factor: house.powerFactor ?? 1,
            invert: false,
            maxAgeSeconds: house.maxAgeSeconds ?? 300,
        }, nowMs);
    }

    private async readEvPower(cfg: AdapterConfig, nowMs: number): Promise<NormalizedValue> {
        const ev = cfg?.ev;
        if (!ev?.enabled || !ev.powerObjectId) return unavailable(nowMs);

        const state = await this.getForeignStateAsync(ev.powerObjectId).catch(() => null);
        const n = normalizeRawState(state as ioBroker.State | null, {
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

    private async readMeters(cfg: AdapterConfig, nowMs: number): Promise<MeterReadings> {
        const readMeter = async (objectId?: string, unit: "Wh" | "kWh" = "kWh", factor = 1): Promise<NormalizedValue> => {
            if (!objectId) return unavailable(nowMs);
            const state = await this.getForeignStateAsync(objectId).catch(() => null);
            return normalizeRawState(state as ioBroker.State | null, {
                unit,
                factor,
                invert: false,
                maxAgeSeconds: 86400,  // meters can be stale for up to 1 day
            }, nowMs);
        };

        return {
            gridImport: await readMeter(cfg?.grid?.importMeterObjectId, cfg?.grid?.importMeterUnit ?? "kWh", cfg?.grid?.importMeterFactor ?? 1),
            gridExport: await readMeter(cfg?.grid?.exportMeterObjectId, cfg?.grid?.exportMeterUnit ?? "kWh", cfg?.grid?.exportMeterFactor ?? 1),
            solar: unavailable(nowMs), // Solar meter handled per-source
            consumption: await readMeter(cfg?.house?.consumptionMeterObjectId, cfg?.house?.consumptionMeterUnit ?? "kWh", cfg?.house?.consumptionMeterFactor ?? 1),
            evCharging: await readMeter(cfg?.ev?.chargingMeterObjectId, cfg?.ev?.chargingMeterUnit ?? "kWh", cfg?.ev?.chargingMeterFactor ?? 1),
            batteryCharge: await readMeter(cfg?.battery?.energyChargingObjectId, cfg?.battery?.energyChargingUnit ?? "kWh"),
            batteryDischarge: await readMeter(cfg?.battery?.energyDischargingObjectId, cfg?.battery?.energyDischargingUnit ?? "kWh"),
        };
    }

    private async publishDashboardSnapshot(snap: DashboardSnapshot): Promise<void> {
        // Store latest snapshot for web requests via sendTo
        this._lastSnapshot = snap;
    }

    private _lastSnapshot: DashboardSnapshot | null = null;

    private onMessage(obj: ioBroker.Message): void {
        if (typeof obj !== "object" || !obj.message) return;

        switch (obj.command) {
            case "getSnapshot":
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, this._lastSnapshot, obj.callback);
                }
                break;

            case "getPowerHistory": {
                const limitHours = typeof obj.message === "object" && (obj.message as { hours?: number }).hours
                    ? (obj.message as { hours: number }).hours
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
                if (obj.callback) this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                break;

            case "disableDemo":
                this.demoMode = false;
                this.log.info("Demo mode disabled");
                if (obj.callback) this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                break;

            case "nextDemoScenario":
                this.demoScenarioIndex++;
                if (obj.callback) this.sendTo(obj.from, obj.command, { scenario: this.demoScenarios[this.demoScenarioIndex % this.demoScenarios.length] }, obj.callback);
                break;

            default:
                if (obj.callback) this.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.updateTimer) {
                clearTimeout(this.updateTimer);
                this.updateTimer = null;
            }
            await this.setState("info.connection", { val: false, ack: true });
            await this.setState("info.status", { val: "stopped", ack: true });
            await this.persistence.shutdown();
            callback();
        } catch (error) {
            this.log.error(`Error during unload: ${String(error)}`);
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EnergyFlowAdapter(options);
} else {
    (() => new EnergyFlowAdapter())();
}
