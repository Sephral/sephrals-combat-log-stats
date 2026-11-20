import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, MODULE_ID, SETTINGS, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
const settings = new Map();
let lang = "en";

globalThis.game = {
  user: { id: "gm", isGM: true },
  i18n: { lang: "en", localize: (key) => (lang === "de" ? german : english)[key] ?? key },
  modules: { get: () => ({ title: "Combat Log & Stats" }) },
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`), register: () => {} }
};
globalThis.Hooks = { on: () => {}, off: () => {} };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };
globalThis.ChatMessage = { getWhisperRecipients: () => [{ id: "gm" }], create: async (data) => data };

const { roundStories, storyHighlights, storyKeys, STORY_VARIANTS } = await import("../scripts/services/round-story.js");
const { buildEndCard, endCardData, renderEndCardHtml } = await import("../scripts/services/end-card-service.js");
const { CombatStatsService } = await import("../scripts/services/stats-service.js");

const START = "2026-11-20T19:00:00.000Z";
const at = (ms) => new Date(new Date(START).getTime() + ms).toISOString();
const base = (id, type, ms, round, extra = {}) => ({ id, type, createdAt: at(ms), round, confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id }, data: {}, ...extra });
const people = [
  { combatantId: "alda", name: "Alda", side: SIDES.FRIENDLY },
  { combatantId: "brom", name: "Brom", side: SIDES.FRIENDLY },
  { combatantId: "boss", name: "Goblin Boss", side: SIDES.HOSTILE },
  { combatantId: "gob", name: "Goblin", side: SIDES.HOSTILE }
];
const dmg = (id, ms, round, from, to, amount, extra = {}) => base(id, EVENT_TYPES.DAMAGE_APPLIED, ms, round, { combatantId: from, data: { amount, targetCombatantId: to, ...extra } });
const crit = (id, ms, round, who) => base(id, EVENT_TYPES.ROLL_ATTACK, ms, round, { combatantId: who, data: { isCritical: true } });

function fight() {
  return [
    base("s", EVENT_TYPES.COMBAT_STARTED, 0, 1),
    // Round 1: the boss hits twice, nobody falls
    dmg("a1", 1000, 1, "boss", "alda", 6),
    dmg("a2", 2000, 1, "boss", "brom", 4),
    // Round 2: Alda falls, Brom answers with a critical hit
    dmg("b1", 3000, 2, "boss", "alda", 12, { targetDowned: true }),
    crit("b2", 4000, 2, "brom"),
    dmg("b3", 4100, 2, "brom", "boss", 18),
    // Round 3: Brom fells the goblin
    dmg("c1", 5000, 3, "brom", "gob", 9, { targetDowned: true })
  ];
}

test("rounds get a sentence from their most notable events", () => {
  const stories = roundStories(fight(), people, { seed: "x" });
  const byRound = new Map(stories.map((entry) => [entry.round, entry.text]));
  assert.match(byRound.get(1), /^Round 1: Goblin Boss (hits|strikes) twice, nobody (falls|goes down)$/);
  assert.match(byRound.get(2), /^Round 2: .*Alda.*, but Brom .*critical hit.* 18/);
  assert.match(byRound.get(3), /^Round 3: .*Goblin/);
  assert.ok(byRound.get(3).includes("Brom"));
});

test("German sentences read like a German speaker says them", () => {
  lang = "de";
  try {
    const stories = roundStories(fight(), people, { seed: "x" });
    const round1 = stories.find((entry) => entry.round === 1).text;
    assert.match(round1, /^Runde 1: Goblin Boss (trifft zweimal|schlägt zweimal zu), niemand (fällt|geht zu Boden)$/);
    assert.match(stories.find((entry) => entry.round === 2).text, /^Runde 2: .*, doch Brom .*kritischen Treffer.*18/);
  } finally {
    lang = "en";
  }
});

test("the same seed always gives the same words, other seeds vary", () => {
  const first = roundStories(fight(), people, { seed: "same" }).map((entry) => entry.text);
  assert.deepEqual(roundStories(fight(), people, { seed: "same" }).map((entry) => entry.text), first);
  const texts = new Set(["a", "b", "c", "d", "e", "f"].map((seed) => roundStories(fight(), people, { seed }).map((entry) => entry.text).join("|")));
  assert.ok(texts.size > 1);
});

test("without single actions only downs and takedowns are told, nobody is named as the one who did it", () => {
  const stories = roundStories(fight(), people, { detail: false, seed: "x" });
  const text = stories.map((entry) => entry.text).join(" ");
  assert.ok(!/critical|damage|18|Brom/.test(text), text);
  assert.ok(stories.some((entry) => entry.round === 2 && entry.text.includes("Alda")));
  assert.ok(!stories.some((entry) => entry.round === 1), "a round with hits only has nothing to say");
});

test("enemy damage numbers stay out when enemy numbers are not shared", () => {
  const events = [base("s", EVENT_TYPES.COMBAT_STARTED, 0, 1), dmg("a1", 1000, 1, "boss", "alda", 31), crit("a2", 1100, 1, "boss")];
  const shown = roundStories(events, people, { seed: "x", enemyAmounts: false })[0].text;
  assert.ok(!shown.includes("31"), shown);
  assert.match(shown, /critical/);
  assert.ok(roundStories(events, people, { seed: "x" })[0].text.includes("31"));
});

test("undone and ignored events tell nothing", () => {
  const events = [base("s", EVENT_TYPES.COMBAT_STARTED, 0, 1), { ...dmg("a1", 1000, 1, "boss", "alda", 12, { targetDowned: true }), ignored: true }, dmg("a2", 1100, 1, "boss", "alda", 5, { reversed: true })];
  assert.deepEqual(roundStories(events, people), []);
});

test("unknown combatants are not named", () => {
  const events = [base("s", EVENT_TYPES.COMBAT_STARTED, 0, 1), dmg("a1", 1000, 1, "ghost", "alda", 12, { targetDowned: true })];
  const text = roundStories(events, people, { seed: "x" })[0].text;
  assert.ok(text.includes("Alda") && !text.includes("ghost"));
});

test("the card keeps the most notable rounds in round order", () => {
  const stories = [{ round: 1, text: "a", score: 20 }, { round: 2, text: "b", score: 150 }, { round: 3, text: "c", score: 90 }, { round: 4, text: "d", score: 30 }, { round: 5, text: "e", score: 100 }];
  assert.deepEqual(storyHighlights(stories, 3).map((entry) => entry.round), [2, 3, 5]);
});

test("every story text exists in English and German without semicolons or dashes", () => {
  const keys = storyKeys();
  assert.ok(keys.length > Object.keys(STORY_VARIANTS).length);
  for (const key of keys) {
    assert.ok(english[key], `en ${key}`);
    assert.ok(german[key], `de ${key}`);
    assert.ok(!/[;–—]| - /.test(english[key] + german[key]), key);
  }
  for (const key of ["SCLS.EndCard.Story", "SCLS.Setting.roundStory.Name", "SCLS.Setting.roundStoryCard.Name", "SCLS.Setting.dangerBar.Name"]) assert.ok(english[key] && german[key], key);
});

function log({ share = {}, hidden = false } = {}) {
  const participants = people.map((entry) => (entry.combatantId === "boss" ? { ...entry, hidden } : entry));
  const value = { id: "fight-s", title: "Story", status: "ended", systemId: "dnd5e", startedAt: START, endedAt: at(60000), participants, events: fight(), shareSettings: share };
  value.computed = CombatStatsService.compute(value);
  return value;
}

test("the end card gets a section that follows the switches", () => {
  settings.clear();
  const data = buildEndCard(log());
  assert.ok(data.story.length >= 1 && data.story.length <= 4);
  const html = renderEndCardHtml(data, { title: "Story", logId: "fight-s" });
  assert.ok(html.includes("scls-endcard__story") && html.includes("Course of the fight"));
  settings.set(`${MODULE_ID}.${SETTINGS.ROUND_STORY_CARD}`, false);
  assert.equal(buildEndCard(log()).story.length, 0);
  settings.set(`${MODULE_ID}.${SETTINGS.ROUND_STORY_CARD}`, true);
  settings.set(`${MODULE_ID}.${SETTINGS.ROUND_STORY}`, false);
  assert.equal(buildEndCard(log()).story.length, 0);
  settings.clear();
});

test("the card for everyone follows the share rules of the fight", () => {
  settings.clear();
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, true);
  // A summary names no single actions: no amounts, no critical hits.
  const summary = buildEndCard(log({ share: { shareMode: SHARE_MODES.SUMMARY_ONLY } }), { everyone: true });
  const text = summary.story.map((entry) => entry.text).join(" ");
  assert.ok(!/critical|damage|\b18\b/.test(text), text);
  // The full recap tells them, but a hidden boss stays hidden: nothing it did is told.
  const hiddenBoss = buildEndCard(log({ share: { shareMode: SHARE_MODES.FULL_VISIBLE_RECAP }, hidden: true }), { everyone: true });
  assert.ok(!hiddenBoss.story.map((entry) => entry.text).join(" ").includes("Goblin Boss"));
  // The GM card has everything.
  assert.ok(buildEndCard(log()).story.map((entry) => entry.text).join(" ").includes("critical"));
  settings.clear();
});

test("a card with no story section renders as before", () => {
  const html = renderEndCardHtml(endCardData({ summary: { rounds: 2 }, byCombatant: [{ name: "A", side: SIDES.FRIENDLY, damageAppliedNet: 5 }] }), { logId: "x" });
  assert.ok(!html.includes("scls-endcard__story"));
});

test("anonymized enemies stay anonymous in the sentences", () => {
  settings.clear();
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, true);
  const data = buildEndCard(log({ share: { shareMode: SHARE_MODES.FULL_VISIBLE_RECAP, anonymizeEnemies: true, includeNpcNames: false } }), { everyone: true });
  const text = data.story.map((entry) => entry.text).join(" ");
  assert.ok(text.length > 0 && !/Goblin/.test(text), text);
  assert.ok(/Enemy \d/.test(text), text);
  settings.clear();
});
