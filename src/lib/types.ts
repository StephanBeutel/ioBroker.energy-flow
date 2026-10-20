// ========== Input Configuration Types ==========

export type PowerUnit = "W" | "kW";
export type EnergyUnit = "Wh" | "kWh";
export type PercentUnit = "%";
export type MeasurementUnit = PowerUnit | EnergyUnit | PercentUnit;

export interface InputConfig {
    objectId: string;
    unit: MeasurementUnit;
    factor: number;
    invert: boolean;
    maxAgeSeconds: number;
    minValue?: number;
    maxValue?: number;
}

export interface SolarSourceConfig extends InputConfig {
    id: string;
    name: string;
    energyObjectId?: string;
    energyUnit?: EnergyUnit;
    energyFactor?: number;
    energyMaxAgeSeconds?: number;
}

export interface BatteryConfig {
    enabled: boolean;
    powerObjectId: string;
    powerUnit: PowerUnit;
    powerFactor: number;
    powerInvert: boolean;
    powerMinValue?: number;
    powerMaxValue?: number;
    socObjectId: string;
    socUnit: PercentUnit;
    maxAgeSeconds: number;
    gridChargingEnabled: boolean;
    gridExportEnabled: boolean;
    chargingObjectId?: string;
    dischargingObjectId?: string;
    energyChargingObjectId?: string;
    energyDischargingObjectId?: string;
    energyChargingUnit?: EnergyUnit;
    energyDischargingUnit?: EnergyUnit;
}

export interface GridConfig {
    powerObjectId: string;
    powerUnit: PowerUnit;
    powerFactor: number;
    powerInvert: boolean;
    powerMinValue?: number;
    powerMaxValue?: number;
    importObjectId?: string;
    exportObjectId?: string;
    maxAgeSeconds: number;
    importMeterObjectId?: string;
    exportMeterObjectId?: string;
    importMeterUnit: EnergyUnit;
    exportMeterUnit: EnergyUnit;
    importMeterFactor?: number;
    exportMeterFactor?: number;
}

export interface HouseConfig {
    powerObjectId?: string;
    powerUnit: PowerUnit;
    powerFactor: number;
    maxAgeSeconds: number;
    consumptionMeterObjectId?: string;
    consumptionMeterUnit: EnergyUnit;
    consumptionMeterFactor?: number;
    balanceToleranceW: number;
}

export interface EvConfig {
    enabled: boolean;
    powerObjectId?: string;
    powerUnit: PowerUnit;
    powerFactor: number;
    maxAgeSeconds: number;
    chargingMeterObjectId?: string;
    chargingMeterUnit: EnergyUnit;
    chargingMeterFactor?: number;
    chargingThresholdW: number;
    chargingHysteresisW: number;
    includedInHousehold: boolean;
    powerMinValue?: number;
    powerMaxValue?: number;
}

export interface HistoryConfig {
    detailRetentionDays: number;
    dailyRetentionYears: number;
}

export interface DashboardConfig {
    updateIntervalSeconds: number;
    chartHistoryHours: number;
}

export interface AdapterConfig {
    timezone: string;
    solar: { sources: SolarSourceConfig[] };
    battery: BatteryConfig;
    grid: GridConfig;
    house: HouseConfig;
    ev: EvConfig;
    history: HistoryConfig;
    dashboard: DashboardConfig;
}

// ========== Measurement Quality Types ==========

export type MeasurementProvenance = "measured" | "calculated" | "estimated";
export type MeasurementAvailability = "available" | "unavailable";
export type MeasurementFreshness = "current" | "stale";

export interface MeasurementQuality {
    provenance: MeasurementProvenance;
    availability: MeasurementAvailability;
    freshness: MeasurementFreshness;
    timestamp: number;
    sourceId?: string;
    note?: string;
}

export interface NormalizedValue {
    value: number | null;
    quality: MeasurementQuality;
}

// ========== Power / Energy State Types ==========

export interface PowerState {
    solar: NormalizedValue;
    battery: NormalizedValue;   // positive=discharging, negative=charging
    grid: NormalizedValue;      // positive=import, negative=export
    house: NormalizedValue;
    houseCalculated: NormalizedValue;
    balanceDiscrepancyW: NormalizedValue;
    evCharging: NormalizedValue;
    siteConsumption: NormalizedValue;
    houseExcludingEv: NormalizedValue;
    batterySoc: NormalizedValue;
    batteryStatus: "charging" | "discharging" | "idle" | "unavailable";
    evStatus: "charging" | "idle" | "unavailable";
}

export interface EnergyFlows {
    solarToHouse: NormalizedValue;
    solarToBattery: NormalizedValue;
    solarToGrid: NormalizedValue;
    batteryToHouse: NormalizedValue;
    batteryToGrid: NormalizedValue;
    gridToHouse: NormalizedValue;
    gridToBattery: NormalizedValue;
    solarToEv: NormalizedValue;
    gridToEv: NormalizedValue;
    batteryToEv: NormalizedValue;
    flowsEstimated: boolean;
}

export interface EnergyPeriod {
    solar: NormalizedValue;
    consumption: NormalizedValue;
    gridImport: NormalizedValue;
    gridExport: NormalizedValue;
    batteryCharge: NormalizedValue;
    batteryDischarge: NormalizedValue;
    evCharging: NormalizedValue;
}

export interface MeterReadings {
    gridImport: NormalizedValue;
    gridExport: NormalizedValue;
    solar: NormalizedValue;
    consumption: NormalizedValue;
    evCharging: NormalizedValue;
}

export interface SolarStatistics {
    highestDayKwh: NormalizedValue;
    highestDayDate: string | null;
    lowestDayKwh: NormalizedValue;
    lowestDayDate: string | null;
    averageDayKwh: NormalizedValue;
    peakPowerKw: NormalizedValue;
    peakPowerDate: string | null;
    peakPowerTime: string | null;
    daysIncluded: number;
    daysExcluded: number;
}

// ========== Persistence Types ==========

export interface DailyRecord {
    date: string;            // YYYY-MM-DD in local timezone
    solar: number | null;
    consumption: number | null;
    gridImport: number | null;
    gridExport: number | null;
    batteryCharge: number | null;
    batteryDischarge: number | null;
    evCharging: number | null;
    peakSolarW: number | null;
    peakSolarTime: string | null;
    complete: boolean;
    estimatedAllocation: boolean;
}

export interface EnergyAccumulator {
    periodStart: string;     // ISO timestamp UTC
    solar: number;
    consumption: number;
    gridImport: number;
    gridExport: number;
    batteryCharge: number;
    batteryDischarge: number;
    evCharging: number;
    lastSolarMeterKwh: number | null;
    lastConsumptionMeterKwh: number | null;
    lastGridImportMeterKwh: number | null;
    lastGridExportMeterKwh: number | null;
    lastEvMeterKwh: number | null;
    lastUpdate: string;
}

export interface PowerIntegrationState {
    lastTimestamp: number | null;
    lastSolarW: number | null;
    lastGridImportW: number | null;
    lastGridExportW: number | null;
    lastHouseW: number | null;
    lastBatteryChargeW: number | null;
    lastBatteryDischargeW: number | null;
    lastEvW: number | null;
}

export interface MeterSnapshot {
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    solarKwh: number | null;
    consumptionKwh: number | null;
    batteryChargeKwh: number | null;
    batteryDischargeKwh: number | null;
    evChargingKwh: number | null;
    timestamp: string;
}

export interface PersistenceData {
    version: number;
    today: EnergyAccumulator;
    month: EnergyAccumulator;
    year: EnergyAccumulator;
    total: EnergyAccumulator;
    dailyHistory: DailyRecord[];
    lastMeterSnapshot: MeterSnapshot;
    powerIntegration: PowerIntegrationState;
    evTotalRecorded: number;
    lastPeriodBoundary: string;
}

// ========== Chart / History Types ==========

export interface PowerHistoryPoint {
    ts: number;
    solar: number | null;
    house: number | null;
    battery: number | null;
    grid: number | null;
    ev: number | null;
}

export interface DailySolarBar {
    date: string;
    kWh: number | null;
    complete: boolean;
}

// ========== Web Message Types ==========

export type WebMessageType =
    | "power"
    | "energy"
    | "flows"
    | "stats"
    | "meters"
    | "history"
    | "daily-bars"
    | "config"
    | "demo";

export interface WebMessage {
    type: WebMessageType;
    ts: number;
    data: unknown;
}

export interface DashboardSnapshot {
    power: PowerState;
    flows: EnergyFlows;
    energy: {
        today: EnergyPeriod;
        month: EnergyPeriod;
        year: EnergyPeriod;
        total: EnergyAccumulator;
    };
    meters: MeterReadings;
    stats: SolarStatistics;
    ts: number;
    demo: boolean;
}
