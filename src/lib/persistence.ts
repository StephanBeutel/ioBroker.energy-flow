import * as utils from "@iobroker/adapter-core";
import type { PersistenceData, PowerHistoryPoint } from "./types.js";
import { migratePersistence, createEmptyPersistence } from "./energyCounter.js";

const PERSISTENCE_KEY = "energy-flow.persistence";
const POWER_HISTORY_KEY = "energy-flow.powerHistory";
const MAX_POWER_HISTORY_POINTS = 1440;  // ~24h at 1-minute resolution

export class PersistenceManager {
    private adapter: utils.AdapterInstance;
    private data: PersistenceData;
    private powerHistory: PowerHistoryPoint[];
    private dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly SAVE_DEBOUNCE_MS = 5000;

    constructor(adapter: utils.AdapterInstance) {
        this.adapter = adapter;
        this.data = createEmptyPersistence(new Date().toISOString());
        this.powerHistory = [];
    }

    async load(): Promise<void> {
        try {
            const raw = await this.adapter.getStateAsync(PERSISTENCE_KEY);
            if (raw?.val && typeof raw.val === "string") {
                const parsed = JSON.parse(raw.val);
                this.data = migratePersistence(parsed);
            } else {
                this.data = createEmptyPersistence(new Date().toISOString());
            }
        } catch (err) {
            this.adapter.log.error(`Failed to load persistence: ${String(err)}`);
            this.data = createEmptyPersistence(new Date().toISOString());
        }

        try {
            const raw = await this.adapter.getStateAsync(POWER_HISTORY_KEY);
            if (raw?.val && typeof raw.val === "string") {
                this.powerHistory = JSON.parse(raw.val);
            }
        } catch {
            this.powerHistory = [];
        }

        // Ensure objects exist
        await this.ensureObjects();
    }

    private async ensureObjects(): Promise<void> {
        await this.adapter.setObjectNotExistsAsync(PERSISTENCE_KEY, {
            type: "state",
            common: {
                name: "Persistence data",
                type: "string",
                role: "json",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.adapter.setObjectNotExistsAsync(POWER_HISTORY_KEY, {
            type: "state",
            common: {
                name: "Power history",
                type: "string",
                role: "json",
                read: true,
                write: false,
            },
            native: {},
        });
    }

    get(): PersistenceData {
        return this.data;
    }

    set(data: PersistenceData): void {
        this.data = data;
        this.scheduleSave();
    }

    addPowerHistoryPoint(point: PowerHistoryPoint): void {
        this.powerHistory.push(point);
        if (this.powerHistory.length > MAX_POWER_HISTORY_POINTS) {
            this.powerHistory = this.powerHistory.slice(-MAX_POWER_HISTORY_POINTS);
        }
        this.scheduleSave();
    }

    getPowerHistory(limitHours = 24): PowerHistoryPoint[] {
        const since = Date.now() - limitHours * 3600_000;
        return this.powerHistory.filter((p) => p.ts >= since);
    }

    private scheduleSave(): void {
        this.dirty = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush().catch((err) => {
                this.adapter.log.error(`Persistence save failed: ${String(err)}`);
            });
        }, this.SAVE_DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            await this.adapter.setStateAsync(PERSISTENCE_KEY, {
                val: JSON.stringify(this.data),
                ack: true,
            });
            await this.adapter.setStateAsync(POWER_HISTORY_KEY, {
                val: JSON.stringify(this.powerHistory),
                ack: true,
            });
        } catch (err) {
            this.adapter.log.error(`Failed to save persistence: ${String(err)}`);
            this.dirty = true;
        }
    }

    async shutdown(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.flush();
    }
}
