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

test("all logs are written to one world json store", async () => {
  const uploads = [];
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async (_source, path, file) => {
      uploads.push({ path, fileName: file.name, data: JSON.parse(await file.text()) });
      return {};
    }
  };
  retentionDays = 0;
  storedIndex = { schemaVersion: 1, logs: [] };

  await service.saveLog({ id: "log-a", title: "A", status: LOG_STATUS.ACTIVE, events: [], participants: [], computed: { summary: { rounds: 1 } } });
  await service.saveLog({ id: "log-b", title: "B", status: LOG_STATUS.ENDED, events: [{ id: "event-b" }], participants: [], computed: { summary: { rounds: 2 } } });

  assert.equal(uploads.at(-1).path, "worlds/test-world/data/sephrals-combat-log-stats");
  assert.equal(uploads.at(-1).fileName, "combat-logs.json");
  assert.deepEqual(uploads.at(-1).data.logs.map((log) => log.id), ["log-b", "log-a"]);
  assert.equal(storedIndex.logs[0].filePath, "worlds/test-world/data/sephrals-combat-log-stats/combat-logs.json");
  assert.equal(storedIndex.logs[0].inlineLog, undefined);
});

test("deleting a log removes it from the central world json store", async () => {
  const uploads = [];
  const service = new CombatLogPersistenceService();
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  globalThis.FilePicker = {
    browse: async () => ({}),
    createDirectory: async () => ({}),
    upload: async (_source, _path, file) => {
      uploads.push(JSON.parse(await file.text()));
      return {};
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