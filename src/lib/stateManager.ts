import * as utils from "@iobroker/adapter-core";
import type { PowerState, EnergyFlows, EnergyPeriod, MeterReadings, SolarStatistics, NormalizedValue } from "./types";

type StateRole = string;

interface StateDefinition {
    id: string;
    name: string;
    type: ioBroker.CommonType;
    role: StateRole;
    unit?: string;
    write?: boolean;
}

function val(nv: NormalizedValue): number | null {
    return nv.value;
}

function qstr(nv: NormalizedValue): string {
    return JSON.stringify({
        v: nv.value,
        p: nv.quality?.provenance,
        a: nv.quality?.availability,
        f: nv.quality?.freshness,
        ts: nv.quality?.timestamp,
    });
}

export class StateManager {
    private adapter: utils.AdapterInstance;

    constructor(adapter: utils.AdapterInstance) {
        this.adapter = adapter;
    }

    async createObjects(): Promise<void> {
        const objects: StateDefinition[] = [
            // Info
            { id: "info.status", name: "Adapter status", type: "string", role: "text" },
            { id: "info.lastUpdate", name: "Last update", type: "number", role: "date" },
            { id: "info.lastUpdateStr", name: "Last update (string)", type: "string", role: "text" },
            // Power
            { id: "power.solar", name: "Solar power", type: "number", role: "value.power", unit: "W" },
            { id: "power.solarQuality", name: "Solar power quality", type: "string", role: "json" },
            { id: "power.house", name: "Household power", type: "number", role: "value.power", unit: "W" },
            { id: "power.houseQuality", name: "Household power quality", type: "string", role: "json" },
            { id: "power.houseCalculated", name: "Household power (calculated)", type: "number", role: "value.power", unit: "W" },
            { id: "power.gridImport", name: "Grid import power", type: "number", role: "value.power", unit: "W" },
            { id: "power.gridImportQuality", name: "Grid import quality", type: "string", role: "json" },
            { id: "power.gridExport", name: "Grid export power", type: "number", role: "value.power", unit: "W" },
            { id: "power.batteryCharge", name: "Battery charge power", type: "number", role: "value.power", unit: "W" },
            { id: "power.batteryDischarge", name: "Battery discharge power", type: "number", role: "value.power", unit: "W" },
            { id: "power.balanceDiscrepancy", name: "Power balance discrepancy", type: "number", role: "value.power", unit: "W" },
            { id: "power.evCharging", name: "EV charging power", type: "number", role: "value.power", unit: "W" },
            { id: "power.siteConsumption", name: "Site consumption power", type: "number", role: "value.power", unit: "W" },
            { id: "power.houseExcludingEv", name: "House power excl. EV", type: "number", role: "value.power", unit: "W" },
            // Battery
            { id: "battery.soc", name: "Battery state of charge", type: "number", role: "value.battery", unit: "%" },
            { id: "battery.status", name: "Battery status", type: "string", role: "text" },
            // EV
            { id: "ev.status", name: "EV charging status", type: "string", role: "text" },
            { id: "ev.lastUpdate", name: "EV last update", type: "number", role: "date" },
            { id: "ev.energySource", name: "EV energy source", type: "string", role: "text" },
            // Flows
            { id: "flows.solarToHouse", name: "Solar → House", type: "number", role: "value.power", unit: "W" },
            { id: "flows.solarToBattery", name: "Solar → Battery", type: "number", role: "value.power", unit: "W" },
            { id: "flows.solarToGrid", name: "Solar → Grid", type: "number", role: "value.power", unit: "W" },
            { id: "flows.batteryToHouse", name: "Battery → House", type: "number", role: "value.power", unit: "W" },
            { id: "flows.batteryToGrid", name: "Battery → Grid", type: "number", role: "value.power", unit: "W" },
            { id: "flows.gridToHouse", name: "Grid → House", type: "number", role: "value.power", unit: "W" },
            { id: "flows.gridToBattery", name: "Grid → Battery", type: "number", role: "value.power", unit: "W" },
            { id: "flows.estimated", name: "Flows estimated", type: "boolean", role: "indicator" },
            // Energy today
            { id: "energy.today.solar", name: "Solar today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.consumption", name: "Consumption today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.gridImport", name: "Grid import today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.gridExport", name: "Grid export today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.batteryCharge", name: "Battery charge today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.batteryDischarge", name: "Battery discharge today", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.today.evCharging", name: "EV charging today", type: "number", role: "value.energy", unit: "kWh" },
            // Energy month
            { id: "energy.month.solar", name: "Solar this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.consumption", name: "Consumption this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.gridImport", name: "Grid import this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.gridExport", name: "Grid export this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.batteryCharge", name: "Battery charge this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.batteryDischarge", name: "Battery discharge this month", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.month.evCharging", name: "EV charging this month", type: "number", role: "value.energy", unit: "kWh" },
            // Energy year
            { id: "energy.year.solar", name: "Solar this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.consumption", name: "Consumption this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.gridImport", name: "Grid import this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.gridExport", name: "Grid export this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.batteryCharge", name: "Battery charge this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.batteryDischarge", name: "Battery discharge this year", type: "number", role: "value.energy", unit: "kWh" },
            { id: "energy.year.evCharging", name: "EV charging this year", type: "number", role: "value.energy", unit: "kWh" },
            // Meters
            { id: "meters.gridImport", name: "Grid import meter", type: "number", role: "value.energy", unit: "kWh" },
            { id: "meters.gridExport", name: "Grid export meter", type: "number", role: "value.energy", unit: "kWh" },
            { id: "meters.solar", name: "Solar meter", type: "number", role: "value.energy", unit: "kWh" },
            { id: "meters.consumption", name: "Consumption meter", type: "number", role: "value.energy", unit: "kWh" },
            { id: "meters.evCharging", name: "EV charging meter", type: "number", role: "value.energy", unit: "kWh" },
            // Statistics
            { id: "statistics.solar.highestDayKwh", name: "Highest daily solar", type: "number", role: "value.energy", unit: "kWh" },
            { id: "statistics.solar.highestDayDate", name: "Highest daily solar date", type: "string", role: "text" },
            { id: "statistics.solar.lowestDayKwh", name: "Lowest daily solar", type: "number", role: "value.energy", unit: "kWh" },
            { id: "statistics.solar.lowestDayDate", name: "Lowest daily solar date", type: "string", role: "text" },
            { id: "statistics.solar.averageDayKwh", name: "Average daily solar", type: "number", role: "value.energy", unit: "kWh" },
            { id: "statistics.solar.peakPowerKw", name: "Peak solar power", type: "number", role: "value.power", unit: "kW" },
            { id: "statistics.solar.peakPowerDate", name: "Peak solar power date", type: "string", role: "text" },
            // Diagnostics
            { id: "diagnostics.lastError", name: "Last error", type: "string", role: "text" },
            { id: "diagnostics.configValid", name: "Configuration valid", type: "boolean", role: "indicator" },
            { id: "diagnostics.balanceConflict", name: "Balance conflict", type: "boolean", role: "indicator.alarm" },
            { id: "diagnostics.evConflict", name: "EV measurement conflict", type: "boolean", role: "indicator.alarm" },
        ];

        const channels = new Set<string>();
        for (const obj of objects) {
            const parts = obj.id.split(".");
            if (parts.length > 1) channels.add(parts.slice(0, -1).join("."));
        }

        for (const ch of channels) {
            await this.adapter.setObjectNotExistsAsync(ch, {
                type: "channel",
                common: { name: ch },
                native: {},
            });
        }

        for (const obj of objects) {
            const common: ioBroker.StateCommon = {
                name: obj.name,
                type: obj.type,
                role: obj.role,
                read: true,
                write: obj.write ?? false,
            };
            if (obj.unit) common.unit = obj.unit;
            await this.adapter.setObjectNotExistsAsync(obj.id, {
                type: "state",
                common,
                native: {},
            });
        }
    }

    async updatePower(power: PowerState, ts: number): Promise<void> {
        const updates: Array<[string, number | string | boolean | null]> = [
            ["power.solar", val(power.solar)],
            ["power.solarQuality", qstr(power.solar)],
            ["power.house", val(power.house)],
            ["power.houseQuality", qstr(power.house)],
            ["power.houseCalculated", val(power.houseCalculated)],
            ["power.gridImport", power.grid.value !== null ? Math.max(0, power.grid.value) : null],
            ["power.gridExport", power.grid.value !== null ? Math.max(0, -(power.grid.value)) : null],
            ["power.batteryCharge", power.battery.value !== null ? Math.max(0, -(power.battery.value)) : null],
            ["power.batteryDischarge", power.battery.value !== null ? Math.max(0, power.battery.value) : null],
            ["power.balanceDiscrepancy", val(power.balanceDiscrepancyW)],
            ["power.evCharging", val(power.evCharging)],
            ["power.siteConsumption", val(power.siteConsumption)],
            ["power.houseExcludingEv", val(power.houseExcludingEv)],
            ["battery.soc", val(power.batterySoc)],
            ["battery.status", power.batteryStatus],
            ["ev.status", power.evStatus],
            ["info.lastUpdate", ts],
            ["info.lastUpdateStr", new Date(ts).toISOString()],
        ];

        await Promise.all(updates.map(([id, v]) =>
            this.adapter.setStateAsync(id, { val: v, ack: true }).catch(() => null)
        ));
    }

    async updateFlows(flows: EnergyFlows): Promise<void> {
        const updates: Array<[string, number | boolean | null]> = [
            ["flows.solarToHouse", val(flows.solarToHouse)],
            ["flows.solarToBattery", val(flows.solarToBattery)],
            ["flows.solarToGrid", val(flows.solarToGrid)],
            ["flows.batteryToHouse", val(flows.batteryToHouse)],
            ["flows.batteryToGrid", val(flows.batteryToGrid)],
            ["flows.gridToHouse", val(flows.gridToHouse)],
            ["flows.gridToBattery", val(flows.gridToBattery)],
            ["flows.estimated", flows.flowsEstimated],
        ];

        await Promise.all(updates.map(([id, v]) =>
            this.adapter.setStateAsync(id, { val: v, ack: true }).catch(() => null)
        ));
    }

    async updateEnergy(today: EnergyPeriod, month: EnergyPeriod, year: EnergyPeriod): Promise<void> {
        const periods: Array<["today" | "month" | "year", EnergyPeriod]> = [
            ["today", today], ["month", month], ["year", year],
        ];
        const updates: Array<[string, number | null]> = [];
        for (const [prefix, period] of periods) {
            updates.push(
                [`energy.${prefix}.solar`, val(period.solar)],
                [`energy.${prefix}.consumption`, val(period.consumption)],
                [`energy.${prefix}.gridImport`, val(period.gridImport)],
                [`energy.${prefix}.gridExport`, val(period.gridExport)],
                [`energy.${prefix}.batteryCharge`, val(period.batteryCharge)],
                [`energy.${prefix}.batteryDischarge`, val(period.batteryDischarge)],
                [`energy.${prefix}.evCharging`, val(period.evCharging)],
            );
        }
        await Promise.all(updates.map(([id, v]) =>
            this.adapter.setStateAsync(id, { val: v, ack: true }).catch(() => null)
        ));
    }

    async updateMeters(meters: MeterReadings): Promise<void> {
        const updates: Array<[string, number | null]> = [
            ["meters.gridImport", val(meters.gridImport)],
            ["meters.gridExport", val(meters.gridExport)],
            ["meters.solar", val(meters.solar)],
            ["meters.consumption", val(meters.consumption)],
            ["meters.evCharging", val(meters.evCharging)],
        ];
        await Promise.all(updates.map(([id, v]) =>
            this.adapter.setStateAsync(id, { val: v, ack: true }).catch(() => null)
        ));
    }

    async updateStatistics(stats: SolarStatistics): Promise<void> {
        const updates: Array<[string, number | string | null]> = [
            ["statistics.solar.highestDayKwh", val(stats.highestDayKwh)],
            ["statistics.solar.highestDayDate", stats.highestDayDate],
            ["statistics.solar.lowestDayKwh", val(stats.lowestDayKwh)],
            ["statistics.solar.lowestDayDate", stats.lowestDayDate],
            ["statistics.solar.averageDayKwh", val(stats.averageDayKwh)],
            ["statistics.solar.peakPowerKw", val(stats.peakPowerKw)],
            ["statistics.solar.peakPowerDate", stats.peakPowerDate],
        ];
        await Promise.all(updates.map(([id, v]) =>
            this.adapter.setStateAsync(id, { val: v, ack: true }).catch(() => null)
        ));
    }

    async setDiagnostics(valid: boolean, error?: string, balanceConflict?: boolean, evConflict?: boolean): Promise<void> {
        await Promise.all([
            this.adapter.setStateAsync("diagnostics.configValid", { val: valid, ack: true }),
            this.adapter.setStateAsync("diagnostics.lastError", { val: error ?? "", ack: true }),
            this.adapter.setStateAsync("diagnostics.balanceConflict", { val: balanceConflict ?? false, ack: true }),
            this.adapter.setStateAsync("diagnostics.evConflict", { val: evConflict ?? false, ack: true }),
        ].map((p) => p.catch(() => null)));
    }
}
