import { LOG_STATUS, MODULE_ID, SCHEMA_VERSION, SETTINGS } from "../constants.js";
import { getSetting, setSetting } from "../settings.js";
import { cloneData, debugLog, isoNow } from "../utils.js";

const FILE_UPLOAD_TIMEOUT_MS = 10000;
const STORE_FILE_NAME = "combat-logs.json";

export class CombatLogPersistenceService {
  constructor() {
    this.cache = new Map();
    this.missingFilePaths = new Set();
    this.filePersistenceDisabled = false;
    this.storeCache = null;
    this.writeQueue = Promise.resolve();
    this.fileUploadTimeoutMs = FILE_UPLOAD_TIMEOUT_MS;
    this.storeFileUrl = null;
    this.forgeDirectoryEnsured = false;
  }

  storageBasePath() {
    const worldId = game?.world?.id ?? "world";
    // The Forge has no writable world folder; the store lives in the user's Assets Library there.
    if (isTheForge()) return `${MODULE_ID}/${worldId}`;
    return `worlds/${worldId}/data/${MODULE_ID}`;
  }

  storageSource() {
    return isTheForge() ? "forgevtt" : "data";
  }

  storeFilePath() {
    return `${this.storageBasePath()}/${STORE_FILE_NAME}`;
  }

  // Another GM wrote the logs. Read them again instead of trusting this client's copy.
  invalidate() {
    this.storeCache = null;
    this.cache.clear();
    this.missingFilePaths.clear();
  }

  async loadStoredIndex() {
    const index = getSetting(SETTINGS.INDEX, { schemaVersion: SCHEMA_VERSION, logs: [] });
    return { schemaVersion: SCHEMA_VERSION, logs: Array.isArray(index?.logs) ? index.logs : [] };
  }

  async loadIndex() {
    const store = await this.loadStore();
    const storeEntries = store.logs.map((log) => indexEntryForLog(log, this.storeFilePath(), null, this.storeFileUrl));
    return { schemaVersion: SCHEMA_VERSION, logs: storeEntries };
  }

  async saveIndex(index) {
    return setSetting(SETTINGS.INDEX, { schemaVersion: SCHEMA_VERSION, logs: (index.logs ?? []).map(stripLogPayloadFromIndexEntry) });
  }

  async loadStore() {
    if (this.storeCache) return cloneData(this.storeCache);
    const index = await this.loadStoredIndex();
    const fileStore = await this.tryLoadStoreFromFile(index);
    const inlineStore = { schemaVersion: SCHEMA_VERSION, updatedAt: isoNow(), logs: (index.logs ?? []).map((entry) => entry.inlineLog).filter((log) => log?.id) };
    this.storeCache = normalizeStore(fileStore ?? inlineStore);
    return cloneData(this.storeCache);
  }

  async saveStore(store) {
    const normalized = normalizeStore({ ...store, updatedAt: isoNow() });
    this.storeCache = cloneData(normalized);
    const persistedToFile = await this.tryPersistStoreToFile(normalized);
    const index = { schemaVersion: SCHEMA_VERSION, logs: normalized.logs.map((log) => indexEntryForLog(log, persistedToFile ? this.storeFilePath() : null, persistedToFile ? null : log, persistedToFile ? this.storeFileUrl : null)) };
    await this.saveIndex(index);
    return persistedToFile;
  }

  async saveLog(log) {
    return this.enqueueWrite(async () => {
      const savedLog = cloneData(log);
      this.cache.set(savedLog.id, savedLog);
      const store = await this.loadStore();
      const existing = store.logs.findIndex((candidate) => candidate.id === savedLog.id);
      if (existing >= 0) store.logs.splice(existing, 1, savedLog);
      else store.logs.unshift(savedLog);
      await this.saveStore(store);
      return log;
    });
  }

  async deleteLog(logId) {
    return this.enqueueWrite(async () => {
      if (!logId) return false;
      const store = await this.loadStore();
      const nextLogs = store.logs.filter((candidate) => candidate.id !== logId);
      const removedFromStore = nextLogs.length !== store.logs.length;
      this.cache.delete(logId);

      if (removedFromStore) {
        await this.saveStore({ ...store, logs: nextLogs });
        return true;
      }

      return false;
    });
  }

  enqueueWrite(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  async loadLog(logId) {
    if (this.cache.has(logId)) return cloneData(this.cache.get(logId));
    const store = await this.loadStore();
    const storedLog = store.logs.find((candidate) => candidate.id === logId);
    if (storedLog) {
      this.cache.set(logId, storedLog);
      return cloneData(storedLog);
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
    const index = await this.pruneIndexByRetention(await this.loadIndex());
    const entries = [];
    for (const entry of index.logs ?? []) {
      if (entry.status === LOG_STATUS.DELETED) continue;
      const log = await this.loadLog(entry.combatLogId);
      entries.push(historyEntry(entry, log));
    }
    return entries.sort((left, right) => new Date(right.startedAt ?? right.lastSeenAt ?? 0).getTime() - new Date(left.startedAt ?? left.lastSeenAt ?? 0).getTime());
  }

  async tryPersistStoreToFile(store) {
    if (this.filePersistenceDisabled) return false;
    if (!supportsClientFileUpload()) {
      this.filePersistenceDisabled = true;
      debugLog("File persistence skipped for this Foundry generation; combat log store remains in world setting fallback");
      return false;
    }
    const FilePicker = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const data = JSON.stringify(store, null, 2);
    if (!FilePicker?.upload) {
      this.filePersistenceDisabled = true;
      debugLog("File persistence unavailable; combat log store remains in world setting fallback");
      return false;
    }
    try {
      await this.ensureDirectories();
      const file = new File([data], STORE_FILE_NAME, { type: "application/json" });
      const response = await withTimeout(FilePicker.upload(this.storageSource(), this.storageBasePath(), file, {}, { notify: false }), this.fileUploadTimeoutMs, "Timed out while uploading combat log store");
      // FilePicker.upload reports server errors by returning false instead of throwing.
      if (!response?.path) throw new Error("The upload returned no file path");
      // The Forge returns the absolute Assets Library URL; the index keeps it to read the store back.
      if (isTheForge()) this.storeFileUrl = response.path;
      return true;
    } catch (error) {
      this.filePersistenceDisabled = true;
      console.warn(`${MODULE_ID} | Failed to persist combat log store`, error);
      return false;
    }
  }

  async tryLoadStoreFromFile(index = null) {
    for (const candidate of await this.storeFileCandidates(index)) {
      const loaded = await this.tryLoadFromFile(candidate);
      if (loaded) return normalizeStore(loaded);
    }
    return null;
  }

  async storeFileCandidates(index = null) {
    const entries = Array.isArray(index?.logs) ? index.logs : [];
    // The index records where the last save went. Without file entries the logs are inline (always on v13),
    // and a store file left from an earlier save would be stale, so it is not requested at all.
    if (!entries.some((entry) => entry?.filePath || entry?.fileUrl)) return [];
    if (!isTheForge()) return [this.storeFilePath()];
    // On The Forge, prefer the URLs returned by earlier uploads. Older entries only know a relative path
    // (written with source "data", which The Forge also keeps in the Assets Library): try its Assets Library URL, then the path.
    const candidates = entries.map((entry) => entry?.fileUrl).filter(Boolean);
    const relativePaths = new Set(entries.map((entry) => entry?.filePath).filter((filePath) => filePath && !isAbsoluteUrl(filePath)));
    for (const filePath of relativePaths) {
      const url = await forgeAssetUrl(filePath);
      if (url) candidates.push(url);
      candidates.push(filePath);
    }
    return [...new Set(candidates)];
  }

  async tryLoadFromFile(filePath) {
    if (!filePath) return null;
    if (this.missingFilePaths.has(filePath)) return null;
    try {
      const response = isAbsoluteUrl(filePath)
        ? await fetch(filePath, { cache: "no-store" })
        : await fetch(filePath.startsWith("/") ? filePath : `/${filePath}`, { cache: "no-store" });
      if (!response.ok) {
        if ([403, 404].includes(response.status)) this.missingFilePaths.add(filePath);
        return null;
      }
      return await response.json();
    } catch (error) {
      debugLog("Failed to load combat log file", filePath, error);
      return null;
    }
  }

  async ensureDirectories() {
    const FilePicker = foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FilePicker?.createDirectory) return;
    if (isTheForge()) {
      // The Forge creates all nested folders in one call, and its upload creates a missing target folder too.
      if (this.forgeDirectoryEnsured) return;
      this.forgeDirectoryEnsured = true;
      try {
        await FilePicker.createDirectory("forgevtt", this.storageBasePath(), { notify: false });
      } catch {
        // Existing folders or a failed call are fine; the upload result decides.
      }
      return;
    }
    let current = `worlds/${game?.world?.id ?? "world"}/data`;
    for (const part of [MODULE_ID]) {
      const next = `${current}/${part}`;
      if (typeof FilePicker.browse === "function") {
        try {
          await FilePicker.browse("data", next, { notify: false });
          current = next;
          continue;
        } catch {
          // Missing directories are created below when the backend permits it.
        }
      }
      try {
        await FilePicker.createDirectory("data", next, { notify: false });
      } catch {
        // Existing directories and storage backends without creation support are fine.
      }
      current = next;
    }
  }

  async pruneIndexByRetention(index) {
    const retentionDays = Number(getSetting(SETTINGS.RETENTION_DAYS, 0)) || 0;
    if (retentionDays <= 0) return index;
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const retained = [];
    const removedIds = new Set();
    for (const entry of index.logs ?? []) {
      if (entry.status === LOG_STATUS.ACTIVE) {
        retained.push(entry);
        continue;
      }
      const reference = new Date(entry.endedAt ?? entry.lastSeenAt ?? entry.startedAt ?? 0).getTime();
      if (!Number.isFinite(reference) || reference >= cutoff) retained.push(entry);
      else {
        this.cache.delete(entry.combatLogId);
        removedIds.add(entry.combatLogId);
      }
    }
    if (retained.length !== (index.logs ?? []).length) {
      const pruned = { ...index, logs: retained };
      // saveStore rewrites the index setting itself (file path and URL, or inline payloads). Writing the
      // display entries afterwards would drop the stored Forge URL and the inline payloads.
      if (removedIds.size && this.storeCache) {
        const store = normalizeStore({ ...this.storeCache, logs: this.storeCache.logs.filter((log) => !removedIds.has(log.id)) });
        await this.saveStore(store);
      } else {
        await this.saveIndex(pruned);
      }
      return pruned;
    }
    return index;
  }

}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// The Forge may declare ForgeVTT/ForgeAPI as top-level classes of a classic script: global bindings that are
// not globalThis properties, so they are read by name behind typeof guards.
function isTheForge() {
  return typeof ForgeVTT !== "undefined" && ForgeVTT?.usingTheForge === true;
}

// Absolute Assets Library URL of a relative path on The Forge, or null when it cannot be determined.
async function forgeAssetUrl(relativePath) {
  const prefix = typeof ForgeVTT !== "undefined" ? ForgeVTT?.ASSETS_LIBRARY_URL_PREFIX : null;
  if (!prefix || typeof ForgeAPI === "undefined" || typeof ForgeAPI?.getUserId !== "function") return null;
  try {
    const userId = await ForgeAPI.getUserId();
    if (!userId) return null;
    return `${prefix}${userId}/${String(relativePath).replace(/^\/+/, "")}`;
  } catch (error) {
    debugLog("Failed to resolve The Forge asset URL", relativePath, error);
    return null;
  }
}

function isAbsoluteUrl(path) {
  return /^https?:\/\//i.test(String(path ?? ""));
}

function supportsClientFileUpload() {
  const generation = Number(game?.release?.generation ?? String(game?.version ?? "").split(".")[0]);
  return !Number.isFinite(generation) || generation >= 14;
}

function normalizeStore(store) {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: store?.updatedAt ?? isoNow(),
    logs: Array.isArray(store?.logs) ? store.logs.filter((log) => log?.id).map(cloneData) : []
  };
}

function indexEntryForLog(log, filePath = null, inlineLog = null, fileUrl = null) {
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
  if (fileUrl) entry.fileUrl = fileUrl;
  if (inlineLog) entry.inlineLog = cloneData(inlineLog);
  return entry;
}

function stripLogPayloadFromIndexEntry(entry) {
  return entry.inlineLog ? entry : { ...entry, inlineLog: undefined };
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
