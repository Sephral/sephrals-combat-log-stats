import assert from "node:assert/strict";
import { test } from "node:test";
import { LOG_STATUS, SETTINGS } from "../scripts/constants.js";

let storedIndex = null;
let retentionDays = 0;

globalThis.game = {
  release: { generation: 14 },
  version: "14.361",
  world: { id: "test-world" },
  settings: {
    get: (_moduleId, key) => key === SETTINGS.RETENTION_DAYS ? retentionDays : storedIndex,
    set: async (_moduleId, key, value) => {
      if (key === SETTINGS.INDEX) storedIndex = value;
      return value;
    }
  }
};

globalThis.foundry = null;

const { CombatLogPersistenceService } = await import("../scripts/services/persistence-service.js");

test("retention pruning removes old non-active index entries only", async () => {
  retentionDays = 7;
  const oldDate = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
  const recentDate = new Date().toISOString();
  storedIndex = {
    schemaVersion: 1,
    logs: [
      { combatLogId: "old-ended", inlineLog: { id: "old-ended", status: LOG_STATUS.ENDED, title: "Old", endedAt: oldDate, startedAt: oldDate, events: [], participants: [], computed: { summary: { rounds: 1 } } } },
      { combatLogId: "old-active", inlineLog: { id: "old-active", status: LOG_STATUS.ACTIVE, title: "Active", lastSeenAt: oldDate, startedAt: oldDate, events: [], participants: [], computed: { summary: { rounds: 1 } } } },
      { combatLogId: "recent-ended", inlineLog: { id: "recent-ended", status: LOG_STATUS.ENDED, title: "Recent", endedAt: recentDate, startedAt: recentDate, events: [], participants: [], computed: { summary: { rounds: 1 } } } }
    ]
  };
  const service = new CombatLogPersistenceService();
  service.loadLog = async () => null;

  const history = await service.loadHistoryEntries();

  assert.deepEqual(storedIndex.logs.map((entry) => entry.combatLogId), ["old-active", "recent-ended"]);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.inlineLog?.title), ["Active", "Recent"]);
  assert.deepEqual(history.map((entry) => entry.combatLogId).sort(), ["old-active", "recent-ended"]);
});

test("missing log files are cached as absent to avoid repeated 404 fetches", async () => {
  const service = new CombatLogPersistenceService();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: false, status: 404 };
  };

  assert.equal(await service.tryLoadFromFile("worlds/test/data/missing.json"), null);
  assert.equal(await service.tryLoadFromFile("worlds/test/data/missing.json"), null);
  assert.equal(fetchCount, 1);
});

test("failed file persistence is disabled for the current session", async () => {
  const service = new CombatLogPersistenceService();
  let uploadCount = 0;
  globalThis.FilePicker = {
    upload: async () => {
      uploadCount += 1;
      throw new Error("No upload permission");
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    assert.equal(await service.tryPersistStoreToFile({ schemaVersion: 1, updatedAt: new Date().toISOString(), logs: [{ id: "log1", events: [] }] }), false);
    assert.equal(await service.tryPersistStoreToFile({ schemaVersion: 1, updatedAt: new Date().toISOString(), logs: [{ id: "log1", events: [] }] }), false);
    assert.equal(uploadCount, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("logs are stored inline when file persistence is unavailable", async () => {
  const service = new CombatLogPersistenceService();
  globalThis.FilePicker = null;
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  const log = { id: "inline-log", title: "Inline", status: LOG_STATUS.ACTIVE, events: [{ id: "event1", round: 1 }], participants: [], computed: { summary: { rounds: 1 } } };

  await service.saveLog(log);
  service.cache.clear();
  const loaded = await service.loadLog("inline-log");

  assert.equal(storedIndex.logs[0].combatLogId, "inline-log");
  assert.equal(storedIndex.logs[0].inlineLog.title, "Inline");
  assert.deepEqual(loaded.events.map((event) => event.id), ["event1"]);
});

test("concurrent saves fall back inline after one failed upload", async () => {
  const service = new CombatLogPersistenceService();
  let uploadCount = 0;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async () => {
      uploadCount += 1;
      throw new Error("No upload permission");
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await Promise.all([
      service.saveLog({ id: "inline-a", title: "A", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } }),
      service.saveLog({ id: "inline-b", title: "B", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } }),
      service.saveLog({ id: "inline-c", title: "C", status: LOG_STATUS.ENDED, events: [], participants: [], computed: { summary: { rounds: 1 } } })
    ]);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(uploadCount, 1);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.combatLogId), ["inline-c", "inline-b", "inline-a"]);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.inlineLog?.title), ["C", "B", "A"]);
});

test("hanging file uploads time out and fall back inline", async () => {
  const service = new CombatLogPersistenceService();
  service.fileUploadTimeoutMs = 5;
  let uploadCount = 0;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async () => {
      uploadCount += 1;
      return new Promise(() => {});
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await service.saveLog({ id: "timeout-inline", title: "Timeout", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(uploadCount, 1);
  assert.equal(service.filePersistenceDisabled, true);
  assert.equal(storedIndex.logs[0].combatLogId, "timeout-inline");
  assert.equal(storedIndex.logs[0].inlineLog.title, "Timeout");
});

test("v13 skips client file upload and stores inline", async () => {
  const service = new CombatLogPersistenceService();
  let uploadCount = 0;
  globalThis.game.release.generation = 13;
  globalThis.game.version = "13.351";
  globalThis.FilePicker = {
    upload: async () => {
      uploadCount += 1;
      return {};
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };

  try {
    await service.saveLog({ id: "v13-inline", title: "V13", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  } finally {
    globalThis.game.release.generation = 14;
    globalThis.game.version = "14.361";
  }

  assert.equal(uploadCount, 0);
  assert.equal(storedIndex.logs[0].combatLogId, "v13-inline");
  assert.equal(storedIndex.logs[0].inlineLog.title, "V13");
});

test("inline index fallback hydrates the current central store shape", async () => {
  const service = new CombatLogPersistenceService();
  globalThis.FilePicker = null;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "inline-log", inlineLog: { id: "inline-log", title: "Inline", status: LOG_STATUS.ACTIVE, events: [{ id: "event1" }], participants: [], computed: { summary: { rounds: 1 } } } }] };

  const loaded = await service.loadLog("inline-log");

  assert.equal(loaded.title, "Inline");
  assert.deepEqual((await service.loadIndex()).logs.map((entry) => entry.combatLogId), ["inline-log"]);
});

test("an inline or empty index does not request the store file", async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return storeResponse([{ id: "stale-log", title: "Stale", status: LOG_STATUS.ENDED, events: [] }]);
  };
  retentionDays = 0;

  storedIndex = { schemaVersion: 1, logs: [] };
  assert.deepEqual((await new CombatLogPersistenceService().loadIndex()).logs, []);

  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "inline-log", filePath: null, inlineLog: { id: "inline-log", title: "Inline", status: LOG_STATUS.ENDED, events: [] } }] };
  assert.equal((await new CombatLogPersistenceService().loadLog("inline-log")).title, "Inline");

  assert.equal(fetchCount, 0);
});

test("an index with file entries reads the world json store", async () => {
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return storeResponse([{ id: "file-log", title: "File", status: LOG_STATUS.ENDED, events: [] }]);
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "file-log", filePath: LEGACY_STORE_PATH }] };

  const loaded = await new CombatLogPersistenceService().loadLog("file-log");

  assert.equal(loaded.title, "File");
  assert.deepEqual(fetched, [`/${LEGACY_STORE_PATH}`]);
});

test("all logs are written to one world json store", async () => {
  const uploads = [];
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async (source, path, file) => {
      uploads.push({ source, path, fileName: file.name, data: JSON.parse(await file.text()) });
      return { status: "success", path: `${path}/${file.name}` };
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };

  await service.saveLog({ id: "log-a", title: "A", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  await service.saveLog({ id: "log-b", title: "B", status: LOG_STATUS.ENDED, events: [{ id: "event-b" }], participants: [], computed: { summary: { rounds: 2 } } });

  assert.equal(uploads.at(-1).source, "data");
  assert.equal(uploads.at(-1).path, "worlds/test-world/data/sephrals-combat-log-stats");
  assert.equal(uploads.at(-1).fileName, "combat-logs.json");
  assert.deepEqual(uploads.at(-1).data.logs.map((log) => log.id), ["log-b", "log-a"]);
  assert.equal(storedIndex.logs[0].filePath, "worlds/test-world/data/sephrals-combat-log-stats/combat-logs.json");
  assert.equal(storedIndex.logs[0].inlineLog, undefined);
  assert.equal("fileUrl" in storedIndex.logs[0], false);
});

test("deleting a log removes it from the central world json store", async () => {
  const uploads = [];
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async (_source, path, file) => {
      uploads.push(JSON.parse(await file.text()));
      return { status: "success", path: `${path}/${file.name}` };
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };

  await service.saveLog({ id: "keep", title: "Keep", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  await service.saveLog({ id: "delete", title: "Delete", status: LOG_STATUS.ENDED, events: [], participants: [], computed: { summary: { rounds: 1 } } });

  assert.equal(await service.deleteLog("delete"), true);
  assert.equal(await service.loadLog("delete"), null);
  assert.deepEqual(uploads.at(-1).logs.map((log) => log.id), ["keep"]);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.combatLogId), ["keep"]);
});

const FORGE_PREFIX = "https://assets.forge-vtt.com/";
const FORGE_STORE_URL = `${FORGE_PREFIX}user123/sephrals-combat-log-stats/test-world/combat-logs.json`;
const LEGACY_STORE_PATH = "worlds/test-world/data/sephrals-combat-log-stats/combat-logs.json";

function simulateForge(t) {
  globalThis.ForgeVTT = { usingTheForge: true, ASSETS_LIBRARY_URL_PREFIX: FORGE_PREFIX };
  globalThis.ForgeAPI = { getUserId: async () => "user123" };
  t.after(() => {
    delete globalThis.ForgeVTT;
    delete globalThis.ForgeAPI;
  });
}

function storeResponse(logs) {
  return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, updatedAt: new Date().toISOString(), logs }) };
}

function forgeFilePicker(calls, uploadResponse = (path, file) => ({ status: "success", path: `${FORGE_PREFIX}user123/${path}/${file.name}` })) {
  return {
    browse: async (...args) => {
      calls.push(["browse", ...args]);
      return {};
    },
    createDirectory: async (...args) => {
      calls.push(["createDirectory", ...args]);
      return {};
    },
    upload: async (source, path, file) => {
      calls.push(["upload", source, path, file.name]);
      return uploadResponse(path, file);
    }
  };
}

test("The Forge stores the log store in the Assets Library and keeps the returned URL in the index", async (t) => {
  simulateForge(t);
  const calls = [];
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = forgeFilePicker(calls);
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };

  await service.saveLog({ id: "forge-a", title: "A", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  await service.saveLog({ id: "forge-b", title: "B", status: LOG_STATUS.ENDED, events: [], participants: [], computed: { summary: { rounds: 1 } } });

  assert.deepEqual(calls.filter(([name]) => name === "createDirectory"), [["createDirectory", "forgevtt", "sephrals-combat-log-stats/test-world", { notify: false }]]);
  assert.equal(calls.some(([name]) => name === "browse"), false);
  assert.deepEqual(calls.filter(([name]) => name === "upload").at(-1), ["upload", "forgevtt", "sephrals-combat-log-stats/test-world", "combat-logs.json"]);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.fileUrl), [FORGE_STORE_URL, FORGE_STORE_URL]);
  assert.equal(storedIndex.logs[0].filePath, "sephrals-combat-log-stats/test-world/combat-logs.json");
  assert.equal(storedIndex.logs[0].inlineLog, undefined);
});

test("The Forge reads the store back from the stored URL", async (t) => {
  simulateForge(t);
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return url === FORGE_STORE_URL ? storeResponse([{ id: "forge-log", title: "Forge", status: LOG_STATUS.ENDED, events: [] }]) : { ok: false, status: 404 };
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "forge-log", filePath: "sephrals-combat-log-stats/test-world/combat-logs.json", fileUrl: FORGE_STORE_URL }] };
  const service = new CombatLogPersistenceService();

  const loaded = await service.loadLog("forge-log");

  assert.equal(loaded.title, "Forge");
  assert.deepEqual(fetched, [FORGE_STORE_URL]);
});

test("The Forge reads legacy entries without URL from the computed Assets Library URL", async (t) => {
  simulateForge(t);
  const fetched = [];
  const legacyUrl = `${FORGE_PREFIX}user123/${LEGACY_STORE_PATH}`;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return url === legacyUrl ? storeResponse([{ id: "legacy-log", title: "Legacy", status: LOG_STATUS.ENDED, events: [] }]) : { ok: false, status: 404 };
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "legacy-log", filePath: LEGACY_STORE_PATH }] };
  const service = new CombatLogPersistenceService();

  const loaded = await service.loadLog("legacy-log");

  assert.equal(loaded.title, "Legacy");
  assert.deepEqual(fetched, [legacyUrl]);
});

test("The Forge falls back to the relative legacy path when the computed URL is missing", async (t) => {
  simulateForge(t);
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return url === `/${LEGACY_STORE_PATH}` ? storeResponse([{ id: "legacy-log", title: "Relative", status: LOG_STATUS.ENDED, events: [] }]) : { ok: false, status: 404 };
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "legacy-log", filePath: LEGACY_STORE_PATH }] };
  const service = new CombatLogPersistenceService();

  const loaded = await service.loadLog("legacy-log");

  assert.equal(loaded.title, "Relative");
  assert.deepEqual(fetched, [`${FORGE_PREFIX}user123/${LEGACY_STORE_PATH}`, `/${LEGACY_STORE_PATH}`]);
});

test("The Forge migrates legacy data to the Assets Library on the next save", async (t) => {
  simulateForge(t);
  const calls = [];
  const legacyUrl = `${FORGE_PREFIX}user123/${LEGACY_STORE_PATH}`;
  globalThis.fetch = async (url) => url === legacyUrl ? storeResponse([{ id: "legacy-log", title: "Legacy", status: LOG_STATUS.ENDED, events: [] }]) : { ok: false, status: 404 };
  globalThis.FilePicker = forgeFilePicker(calls);
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [{ combatLogId: "legacy-log", filePath: LEGACY_STORE_PATH }] };
  const service = new CombatLogPersistenceService();

  await service.saveLog({ id: "new-log", title: "New", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });

  assert.deepEqual(storedIndex.logs.map((entry) => entry.combatLogId), ["new-log", "legacy-log"]);
  assert.deepEqual(storedIndex.logs.map((entry) => entry.fileUrl), [FORGE_STORE_URL, FORGE_STORE_URL]);
});

test("The Forge keeps the stored URL in the index after retention pruning", async (t) => {
  simulateForge(t);
  const calls = [];
  const oldDate = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
  globalThis.fetch = async (url) => url === FORGE_STORE_URL
    ? storeResponse([
      { id: "old-ended", title: "Old", status: LOG_STATUS.ENDED, endedAt: oldDate, startedAt: oldDate, events: [] },
      { id: "recent-ended", title: "Recent", status: LOG_STATUS.ENDED, endedAt: new Date().toISOString(), events: [] }
    ])
    : { ok: false, status: 404 };
  globalThis.FilePicker = forgeFilePicker(calls);
  retentionDays = 7;
  storedIndex = { schemaVersion: 1, logs: [
    { combatLogId: "old-ended", filePath: "sephrals-combat-log-stats/test-world/combat-logs.json", fileUrl: FORGE_STORE_URL },
    { combatLogId: "recent-ended", filePath: "sephrals-combat-log-stats/test-world/combat-logs.json", fileUrl: FORGE_STORE_URL }
  ] };
  const service = new CombatLogPersistenceService();

  try {
    await service.loadHistoryEntries();
  } finally {
    retentionDays = 0;
  }

  assert.deepEqual(storedIndex.logs.map((entry) => entry.combatLogId), ["recent-ended"]);
  assert.equal(storedIndex.logs[0].fileUrl, FORGE_STORE_URL);
});

test("The Forge falls back inline when the upload returns no URL", async (t) => {
  simulateForge(t);
  const calls = [];
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = forgeFilePicker(calls, () => false);
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  const service = new CombatLogPersistenceService();
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await service.saveLog({ id: "forge-inline", title: "Inline", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(service.filePersistenceDisabled, true);
  assert.equal(storedIndex.logs[0].filePath, null);
  assert.equal(storedIndex.logs[0].inlineLog.title, "Inline");
  assert.equal("fileUrl" in storedIndex.logs[0], false);
});

test("Forge detection is off once the simulated globals are removed", async () => {
  assert.equal(typeof globalThis.ForgeVTT, "undefined");
  const service = new CombatLogPersistenceService();
  assert.equal(service.storageSource(), "data");
  assert.equal(service.storeFilePath(), LEGACY_STORE_PATH);
});

test("a failed upload (FilePicker returns false) keeps the logs inline in the world setting", async () => {
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async () => false
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };
  try {
    await service.saveLog({ id: "log-x", title: "X", status: LOG_STATUS.ENDED, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(storedIndex.logs[0].filePath, null);
  assert.equal(storedIndex.logs[0].inlineLog.id, "log-x");
});
test("logs written by another GM are read again after invalidation", async () => {
  const entry = (id, status) => ({ combatLogId: id, inlineLog: { id, status, title: id, startedAt: new Date().toISOString(), events: [], participants: [], computed: { summary: { rounds: 1 } } } });
  storedIndex = { schemaVersion: 1, logs: [entry("first", LOG_STATUS.ENDED)] };
  const service = new CombatLogPersistenceService();
  assert.equal((await service.loadActiveLogs()).length, 0);

  // another GM starts a combat and saves the index
  storedIndex = { schemaVersion: 1, logs: [entry("running", LOG_STATUS.ACTIVE), entry("first", LOG_STATUS.ENDED)] };
  assert.equal((await service.loadActiveLogs()).length, 0, "the cached store is still used");

  service.invalidate();
  assert.deepEqual((await service.loadActiveLogs()).map((log) => log.id), ["running"]);
});
