"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistenceManager = void 0;
const energyCounter_js_1 = require("./energyCounter.js");
const PERSISTENCE_KEY = "energy-flow.persistence";
const POWER_HISTORY_KEY = "energy-flow.powerHistory";
const MAX_POWER_HISTORY_POINTS = 1440; // ~24h at 1-minute resolution
class PersistenceManager {
    adapter;
    data;
    powerHistory;
    dirty = false;
    saveTimer = null;
    SAVE_DEBOUNCE_MS = 5000;
    constructor(adapter) {
        this.adapter = adapter;
        this.data = (0, energyCounter_js_1.createEmptyPersistence)(new Date().toISOString());
        this.powerHistory = [];
    }
    async load() {
        try {
            const raw = await this.adapter.getStateAsync(PERSISTENCE_KEY);
            if (raw?.val && typeof raw.val === "string") {
                const parsed = JSON.parse(raw.val);
                this.data = (0, energyCounter_js_1.migratePersistence)(parsed);
            }
            else {
                this.data = (0, energyCounter_js_1.createEmptyPersistence)(new Date().toISOString());
            }
        }
        catch (err) {
            this.adapter.log.error(`Failed to load persistence: ${String(err)}`);
            this.data = (0, energyCounter_js_1.createEmptyPersistence)(new Date().toISOString());
        }
        try {
            const raw = await this.adapter.getStateAsync(POWER_HISTORY_KEY);
            if (raw?.val && typeof raw.val === "string") {
                this.powerHistory = JSON.parse(raw.val);
            }
        }
        catch {
            this.powerHistory = [];
        }
        // Ensure objects exist
        await this.ensureObjects();
    }
    async ensureObjects() {
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
    get() {
        return this.data;
    }
    set(data) {
        this.data = data;
        this.scheduleSave();
    }
    addPowerHistoryPoint(point) {
        this.powerHistory.push(point);
        if (this.powerHistory.length > MAX_POWER_HISTORY_POINTS) {
            this.powerHistory = this.powerHistory.slice(-MAX_POWER_HISTORY_POINTS);
        }
        this.scheduleSave();
    }
    getPowerHistory(limitHours = 24) {
        const since = Date.now() - limitHours * 3600_000;
        return this.powerHistory.filter((p) => p.ts >= since);
    }
    scheduleSave() {
        this.dirty = true;
        if (this.saveTimer)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush().catch((err) => {
                this.adapter.log.error(`Persistence save failed: ${String(err)}`);
            });
        }, this.SAVE_DEBOUNCE_MS);
    }
    async flush() {
        if (!this.dirty)
            return;
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
        }
        catch (err) {
            this.adapter.log.error(`Failed to save persistence: ${String(err)}`);
            this.dirty = true;
        }
    }
    async shutdown() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.flush();
    }
}
exports.PersistenceManager = PersistenceManager;
//# sourceMappingURL=persistence.js.map