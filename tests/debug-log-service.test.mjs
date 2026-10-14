import assert from "node:assert/strict";
import { test } from "node:test";
import { __test__ } from "../scripts/services/debug-log-service.js";

const { buildDebugLog, DebugTrace } = __test__;

test("the debug log holds the raw chat messages of the fight with a minute of margin", () => {
  const start = Date.parse("2026-10-14T19:00:00Z");
  const message = (id, offsetMs) => ({ id, timestamp: start + offsetMs, toObject() { return { _id: id, timestamp: this.timestamp, flags: { "midi-qol": {} } }; } });
  const log = { id: "log", startedAt: new Date(start).toISOString(), endedAt: new Date(start + 600000).toISOString() };
  const data = buildDebugLog({ log, messages: [message("early", -120000), message("before", -30000), message("during", 1000), message("after", 650000), message("late", 700000)], now: start + 900000 });
  assert.deepEqual(data.messages.map((entry) => entry._id), ["before", "during", "after"]);
  assert.equal(data.log, log);
});

test("the trace keeps the newest entries only", () => {
  const trace = new DebugTrace(3);
  for (let index = 0; index < 5; index += 1) trace.add("updateActor", { index });
  assert.deepEqual(trace.entries.map((entry) => entry.index), [2, 3, 4]);
});
