import { LOG_STATUS, MODULE_ID, SCHEMA_VERSION, SETTINGS } from "../constants.js";
import { getSetting, setSetting } from "../settings.js";
import { cloneData, debugLog, isoNow } from "../utils.js";

export class CombatLogPersistenceService {
  constructor() {
    this.cache = new Map();
  }

  storageBasePath() {
    return `worlds/${game?.world?.id ?? "world"}/data/${MODULE_ID}/combat-logs`;
  }

  filePathFor(logId) {
    return `${this.storageBasePath()}/${logId}.json`;
  }

  async loadIndex() {
    const index = getSetting(SETTINGS.INDEX, { schemaVersion: SCHEMA_VERSION, logs: [] });
    return { schemaVersion: SCHEMA_VERSION, logs: Array.isArray(index?.logs) ? index.logs : [] };
  }

  async saveIndex(index) {
    return setSetting(SETTINGS.INDEX, { schemaVersion: SCHEMA_VERSION, logs: index.logs ?? [] });
  }

  async upsertIndexEntry(log) {
    const index = await this.loadIndex();
    const filePath = this.filePathFor(log.id);
    const entry = {
      schemaVersion: SCHEMA_VERSION,
      moduleVersion: log.moduleVersion,
      combatLogId: log.id,
      combatId: log.combatId,
      combatUuid: log.combatUuid,
      sceneUuid: log.sceneUuid,
      title: log.title,
      status: log.status,
      startedAt: log.startedAt,
      endedAt: log.endedAt,
      lastSeenAt: log.lastSeenAt ?? isoNow(),
      rounds: log.computed?.summary?.rounds ?? maxRound(log),
      participantCount: log.participants?.length ?? 0,
      filePath,
      isShared: Boolean(log.shareSettings?.isShared),
      shareMode: log.shareSettings?.shareMode ?? "gmOnly",
      hasPlayerSummary: Boolean(log.shareSettings?.allowPlayersToOpenReport)
    };
    const existing = index.logs.findIndex((candidate) => candidate.combatLogId === log.id);
    if (existing >= 0) index.logs.splice(existing, 1, entry);
    else index.logs.unshift(entry);
    await this.saveIndex(index);
    return entry;
  }

  async saveLog(log) {
    this.cache.set(log.id, cloneData(log));
    await this.upsertIndexEntry(log);
    await this.tryPersistToFile(log);
    return log;
  }

  async loadLog(logId) {
    if (this.cache.has(logId)) return cloneData(this.cache.get(logId));
    const index = await this.loadIndex();
    const entry = index.logs.find((candidate) => candidate.combatLogId === logId);
    if (!entry) return null;
    const loaded = await this.tryLoadFromFile(entry.filePath);
    if (loaded) {
      this.cache.set(logId, loaded);
      return cloneData(loaded);
    }
    return null;
  }

  async loadActiveLogs() {
    const index = await this.loadIndex();
    const activeEntries = index.logs.filter((entry) => entry.status === LOG_STATUS.ACTIVE);
    const logs = [];
    for (const entry of activeEntries) {
      const log = await this.loadLog(entry.combatLogId);
      if (log) logs.push(log);
    }
    return logs;
  }

  async loadHistoryEntries() {
    const index = await this.loadIndex();
    const entries = [];
    for (const entry of index.logs ?? []) {
      if (entry.status === LOG_STATUS.DELETED) continue;
      const log = await this.loadLog(entry.combatLogId);
      entries.push(historyEntry(entry, log));
    }
    return entries.sort((left, right) => new Date(right.startedAt ?? right.lastSeenAt ?? 0).getTime() - new Date(left.startedAt ?? left.lastSeenAt ?? 0).getTime());
  }

  async tryPersistToFile(log) {
    if (!getSetting(SETTINGS.PERSIST_LOGS_TO_FILES, true)) return false;
    const FilePicker = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const data = JSON.stringify(log, null, 2);
    if (!FilePicker?.upload) {
      debugLog("File persistence unavailable; log remains indexed and cached", log.id);
      return false;
    }
    try {
      await this.ensureDirectories();
      const file = new File([data], `${log.id}.json`, { type: "application/json" });
      await FilePicker.upload("data", this.storageBasePath(), file, {}, { notify: false });
      return true;
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to persist combat log file`, error);
      return false;
    }
  }

  async tryLoadFromFile(filePath) {
    if (!filePath) return null;
    try {
      const response = await fetch(filePath.startsWith("/") ? filePath : `/${filePath}`);
      if (!response.ok) return null;
      return response.json();
    } catch (error) {
      debugLog("Failed to load combat log file", filePath, error);
      return null;
    }
  }

  async ensureDirectories() {
    const FilePicker = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FilePicker?.createDirectory) return;
    const parts = this.storageBasePath().split("/");
    let current = parts.shift();
    for (const part of parts) {
      const next = `${current}/${part}`;
      try {
        await FilePicker.createDirectory("data", next, { notify: false });
      } catch {
        // Existing directories and storage backends without creation support are fine.
      }
      current = next;
    }
  }
}

function maxRound(log) {
  return Math.max(0, ...((log.events ?? []).map((event) => Number(event.round) || 0)));
}

function historyEntry(entry, log) {
  const summary = log?.computed?.summary ?? {};
  const dpr = log?.computed?.dpr ?? {};
  return {
    ...entry,
    title: log?.title ?? entry.title ?? entry.combatLogId,
    status: log?.status ?? entry.status,
    startedAt: log?.startedAt ?? entry.startedAt,
    endedAt: log?.endedAt ?? entry.endedAt,
    lastSeenAt: log?.lastSeenAt ?? entry.lastSeenAt,
    rounds: summary.rounds ?? entry.rounds ?? maxRound(log ?? {}),
    participantCount: log?.participants?.length ?? entry.participantCount ?? 0,
    netDamageApplied: summary.netDamageApplied ?? entry.netDamageApplied ?? 0,
    netHealingApplied: summary.netHealingApplied ?? entry.netHealingApplied ?? 0,
    partyDPR: dpr.partyDPR ?? entry.partyDPR ?? 0,
    enemyDPR: dpr.enemyDPR ?? entry.enemyDPR ?? 0,
    loaded: Boolean(log)
  };
}
