import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, END_CARD_MODES, EVENT_TYPES, MODULE_ID, SETTINGS, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
const settings = new Map();
let lang = "en";
const posted = [];

globalThis.game = {
  user: { id: "gm", isGM: true },
  i18n: { lang: "en", localize: (key) => (lang === "de" ? german : english)[key] ?? key },
  modules: { get: () => ({ title: "Combat Log & Stats" }) },
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`), register: () => {} }
};
globalThis.Hooks = { on: () => {}, off: () => {} };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };
globalThis.ChatMessage = {
  getWhisperRecipients: () => [{ id: "gm" }, { id: "gm2" }],
  create: async (data) => {
    posted.push(data);
    return data;
  }
};

const { endCardData, endCardLines, postEndCard, renderEndCardHtml, worthACard } = await import("../scripts/services/end-card-service.js");
const { CombatStatsService } = await import("../scripts/services/stats-service.js");

const START = "2026-11-14T19:00:00.000Z";
const at = (ms) => new Date(new Date(START).getTime() + ms).toISOString();

// Aria and Bram against a goblin boss: Aria hits for 30, Bram for 9, a crit and a fumble, Bram goes down, one heal.
function fightLog({ hidden = false, share = {} } = {}) {
  const base = (id, type, ms, extra = {}) => ({ id, type, createdAt: at(ms), round: 1, confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id }, data: {}, ...extra });
  const log = {
    id: "fight-1",
    title: "Goblin ambush",
    status: "ended",
    systemId: "dnd5e",
    startedAt: START,
    endedAt: at(600000),
    participants: [
      { combatantId: "aria", actorUuid: "Actor.aria", name: "Aria", side: SIDES.FRIENDLY },
      { combatantId: "bram", actorUuid: "Actor.bram", name: "Bram", side: SIDES.FRIENDLY },
      { combatantId: "boss", actorUuid: "Actor.boss", name: "Goblin Boss", side: SIDES.HOSTILE, hidden }
    ],
    events: [
      base("e0", EVENT_TYPES.COMBAT_STARTED, 0),
      base("e1", EVENT_TYPES.ROUND_CHANGED, 1000),
      base("d1", EVENT_TYPES.DAMAGE_APPLIED, 60000, { combatantId: "aria", data: { amount: 30, targetCombatantId: "boss", targetDowned: true } }),
      base("d2", EVENT_TYPES.DAMAGE_APPLIED, 120000, { combatantId: "bram", data: { amount: 9, targetCombatantId: "boss" } }),
      base("d3", EVENT_TYPES.DAMAGE_APPLIED, 180000, { combatantId: "boss", data: { amount: 50, targetCombatantId: "bram", targetDowned: true } }),
      base("h1", EVENT_TYPES.HEALING_APPLIED, 240000, { combatantId: "aria", data: { amount: 7, targetCombatantId: "bram" } }),
      base("r1", EVENT_TYPES.ROLL_ATTACK, 61000, { combatantId: "aria", type: EVENT_TYPES.ROLL_ATTACK, data: { isCritical: true } }),
      base("r2", EVENT_TYPES.ROLL_ATTACK, 121000, { combatantId: "bram", type: EVENT_TYPES.ROLL_ATTACK, data: { isFumble: true } }),
      base("e9", EVENT_TYPES.ROUND_CHANGED, 300000, { round: 3 }),
      base("end", EVENT_TYPES.COMBAT_ENDED, 600000, { round: 3 })
    ],
    shareSettings: share
  };
  log.computed = CombatStatsService.compute(log);
  return log;
}

test("the card tells rounds, top damage, crits and fumbles, who went down and healing", () => {
  const data = endCardData(fightLog().computed, { durationMs: 600000 });
  assert.equal(data.rounds, 3);
  assert.deepEqual(data.top, { name: "Aria", amount: 30 });
  assert.equal(data.crits, 1);
  assert.equal(data.fumbles, 1);
  assert.deepEqual(data.downed, ["Bram"]);
  assert.equal(data.defeated, 1);
  assert.equal(data.healing, 7);
  assert.equal(data.quiet, false);

  const lines = endCardLines(data, "dnd5e");
  assert.equal(lines[0], "Lasted 3 rounds, 10m 0s.");
  assert.ok(lines.includes("Top damage: Aria with 30"));
  assert.ok(lines.includes("1 critical hit, 1 fumble"));
  assert.ok(lines.includes("Dropped to 0 HP: Bram"));
  assert.ok(lines.includes("1 enemy defeated"));
  assert.ok(lines.includes("Healing: 7 HP"));
});

test("a long list of names is cut, Crucible and German use their own words", () => {
  const data = { rounds: 2, durationMs: 0, top: null, crits: 0, fumbles: 0, downed: ["A", "B", "C", "D", "E", "F"], downedCount: 6, defeated: 0, healing: 12, quiet: false };
  const lines = endCardLines(data, "crucible");
  assert.ok(lines.includes("Went down: A, B, C, D and 2 more"));
  assert.ok(lines.includes("Health restored: 12"));
  lang = "de";
  try {
    assert.equal(endCardLines(data, "dnd5e")[0], "Dauer: 2 Runden.");
    assert.ok(endCardLines(data, "dnd5e").includes("Auf 0 TP gefallen: A, B, C, D und 2 weitere"));
  } finally {
    lang = "en";
  }
});

test("a fight nobody played gets no card, a quiet one longer than a round does", () => {
  const empty = endCardData({ summary: { rounds: 1 }, byCombatant: [] });
  assert.equal(empty.quiet, true);
  assert.equal(worthACard(empty), false);
  assert.equal(worthACard(endCardData({ summary: { rounds: 4 }, byCombatant: [] })), true);
  assert.equal(endCardLines(endCardData({ summary: { rounds: 4 }, byCombatant: [] }))[1], "Not much happened.");
});

test("the html escapes names and carries the button to the full report", () => {
  const html = renderEndCardHtml(endCardData({ summary: { rounds: 2 }, byCombatant: [{ name: "<b>Evil</b>", side: SIDES.FRIENDLY, damageAppliedNet: 5 }] }), { title: "A & B", logId: "log-7" });
  assert.ok(html.includes("Fight over: A &amp; B"));
  assert.ok(html.includes("&lt;b&gt;Evil&lt;/b&gt;"));
  assert.ok(!html.includes("<b>Evil"));
  assert.ok(html.includes('data-scls-log-id="log-7"'));
});

test("the GM card is a whisper to the GMs with the log in its flags", async () => {
  posted.length = 0;
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, true);
  const message = await postEndCard(fightLog(), { mode: END_CARD_MODES.GM });
  assert.ok(message);
  assert.deepEqual(posted[0].whisper, ["gm", "gm2"]);
  assert.equal(posted[0].flags[MODULE_ID].endCard.logId, "fight-1");
  assert.ok(posted[0].content.includes("Top damage: Aria with 30"));
  assert.ok(posted[0].content.includes("1 enemy defeated"));
});

test("the card for everyone is public and shows nothing hidden combatants did", async () => {
  posted.length = 0;
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, true);
  // The boss is hidden: its damage to Bram and the defeat leave the player view.
  const log = fightLog({ hidden: true });
  await postEndCard(log, { mode: END_CARD_MODES.EVERYONE });
  assert.deepEqual(posted[0].whisper, []);
  const text = posted[0].content;
  assert.ok(!text.includes("Top damage"), "hits on a hidden combatant are not part of the player view either");
  assert.ok(!text.includes("Goblin Boss"));
  assert.ok(!/Dropped to 0 HP: Bram/.test(text), "damage by a hidden combatant is not part of the player view");
});

test("everyone falls back to the GM whisper while player reports are off, off posts nothing", async () => {
  posted.length = 0;
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, false);
  await postEndCard(fightLog(), { mode: END_CARD_MODES.EVERYONE });
  assert.deepEqual(posted[0].whisper, ["gm", "gm2"]);
  assert.equal(await postEndCard(fightLog(), { mode: END_CARD_MODES.OFF }), null);
  assert.equal(posted.length, 1);
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, true);
});

test("the card counts the party only: enemy crits, damage and healing stay out", () => {
  const computed = {
    summary: { rounds: 2, enemiesDefeated: 0, netHealingApplied: 99 },
    bySide: [{ id: SIDES.FRIENDLY, healingNet: 4 }, { id: SIDES.HOSTILE, healingNet: 50 }],
    byCombatant: [
      { name: "Aria", side: SIDES.FRIENDLY, damageAppliedNet: 10, crits: 1, fumbles: 0, downed: 0, healingNet: 4 },
      { name: "Ogre", side: SIDES.HOSTILE, damageAppliedNet: 80, crits: 3, fumbles: 2, downed: 0, healingNet: 50 }
    ]
  };
  const players = endCardData(computed);
  assert.deepEqual(players.top, { name: "Aria", amount: 10 });
  assert.equal(players.crits, 1);
  assert.equal(players.fumbles, 0);
  assert.equal(players.healing, 4);
  assert.deepEqual(endCardData(computed, { durationMs: 5 }).durationMs, 5);
});
