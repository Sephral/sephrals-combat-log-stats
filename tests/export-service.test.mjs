import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const translations = {
  en: JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")),
  de: JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"))
};
let language = "en";
const downloads = [];

globalThis.game = {
  user: { id: "gm-user", isGM: true },
  i18n: {
    get lang() {
      return language;
    },
    localize: (key) => translations[language]?.[key] ?? key
  },
  settings: { get: () => undefined }
};
globalThis.foundry = { utils: { saveDataToFile: (data, type, filename) => downloads.push({ data, type, filename }) } };

const { CombatLogExportService, __test__ } = await import("../scripts/services/export-service.js");

const actorUpdate = { visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.ACTOR_UPDATE, id: "actor" } };

function exportLog() {
  return {
    id: "combat-log-1",
    title: "Goblin Ambush",
    status: "ended",
    startedAt: "2026-05-17T10:00:00.000Z",
    endedAt: "2026-05-17T10:10:00.000Z",
    sceneUuid: "Scene.1",
    participants: [
      { combatantId: "aria", name: "Aria", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "gob2", name: "Goblin 2", side: SIDES.HOSTILE },
      { combatantId: "gob3", name: "Goblin 3", side: SIDES.HOSTILE, hidden: true }
    ],
    computed: {
      summary: { rounds: 2, netDamageApplied: 21, netHealingApplied: 4, unclassifiedDeltas: 1 },
      dpr: { partyDPR: 7.5, enemyDPR: 3 }
    },
    events: [
      { id: "start", type: EVENT_TYPES.COMBAT_STARTED, round: 1, confidence: CONFIDENCE.SAFE, source: { kind: SOURCE_KINDS.COMBAT_UPDATE }, data: { title: "Goblin Ambush" } },
      { id: "chat", type: EVENT_TYPES.CHAT_MESSAGE_CREATED, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.CHAT_MESSAGE }, data: { content: "Secret whisper", speakerAlias: "" } },
      { id: "attack", type: EVENT_TYPES.ROLL_ATTACK, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { total: 18, actionName: "Longsword" } },
      { id: "trap", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "gob2", confidence: CONFIDENCE.PROBABLE, ...actorUpdate, data: { resourcePath: "system.attributes.hp.value", interpretedAs: "damage", delta: -7, oldValue: 16, newValue: 9, targetCombatantId: "gob2", targetDowned: false } },
      { id: "potion", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, ...actorUpdate, data: { resourcePath: "system.attributes.hp.value", interpretedAs: "healing", delta: 4, oldValue: 10, newValue: 14, targetCombatantId: "aria", actionName: "Potion of Healing" } },
      { id: "prone", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, round: 1, combatantId: "aria", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.ACTIVE_EFFECT_UPDATE }, data: { name: "Prone", statuses: ["prone"], control: true, sourceCombatantId: "aria", targetCombatantId: "gob2" } },
      { id: "hit", type: EVENT_TYPES.DAMAGE_APPLIED, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, tags: ["chat-applied"], data: { amount: 9, actionName: "Longsword", actionKind: "melee", targetCombatantId: "gob2", targetName: "Goblin 2" } },
      { id: "hit-confirm", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, ...actorUpdate, data: { resourcePath: "system.attributes.hp.value", interpretedAs: "ignored", duplicateOfEventId: "hit", delta: -9, oldValue: 9, newValue: 0, targetCombatantId: "gob2", sourceCombatantId: "aria", attribution: "correlatedChatRoll", targetDowned: true } },
      { id: "ignored", type: EVENT_TYPES.DAMAGE_APPLIED, round: 2, combatantId: "aria", ignored: true, confidence: CONFIDENCE.SAFE, data: { amount: 99, targetCombatantId: "gob2" } },
      { id: "round", type: EVENT_TYPES.ROUND_CHANGED, round: 2, confidence: CONFIDENCE.SAFE, data: {} }
    ],
    shareSettings: {}
  };
}

function withLanguage(next, callback) {
  const previous = language;
  language = next;
  try {
    return callback();
  } finally {
    language = previous;
  }
}

test("markdown export is a readable document with summary and actions by round", () => {
  const markdown = new CombatLogExportService().exportMarkdown(exportLog());

  assert.match(markdown, /^# Goblin Ambush$/m);
  assert.match(markdown, /^- Status: Ended$/m);
  assert.match(markdown, /^- Started: .+2026/m);
  assert.match(markdown, /^- Rounds: 2$/m);
  assert.match(markdown, /^- Aria \(Friendly\)$/m);
  assert.match(markdown, /^- Goblin 3 \(Hostile, hidden from players\)$/m);
  assert.match(markdown, /^- Net damage: 21$/m);
  assert.match(markdown, /^- Net healing: 4$/m);
  assert.match(markdown, /^- Party damage per round: 7\.5$/m);
  assert.match(markdown, /^- Enemy damage per round: 3$/m);
  assert.match(markdown, /^- Enemies defeated: 1$/m);
  assert.match(markdown, /^- Party members dropped to 0 HP: 0$/m);
  assert.match(markdown, /^- Unclear HP changes, not counted: 1$/m);

  const actions = markdown.slice(markdown.indexOf("## Actions by Round"));
  assert.deepEqual(actions.split("\n").filter((line) => line.startsWith("- ")), [
    "- Round 1: Goblin 2 took 7 damage.",
    "- Round 1: Aria regained 4 HP with Potion of Healing.",
    "- Round 1: Aria afflicted Goblin 2 with Prone.",
    "- Round 2: Aria hit Goblin 2 with Longsword for 9 damage.",
    "- Round 2: Goblin 2 dropped to 0 HP."
  ]);
});

test("markdown export contains no raw event types or chat content", () => {
  const markdown = new CombatLogExportService().exportMarkdown(exportLog());
  assert.doesNotMatch(markdown, /resource\.delta|combat\.started|chat\.messageCreated|roll\.attack|activeEffect|damage\.applied|combat\.roundChanged/);
  assert.doesNotMatch(markdown, /Secret whisper|for 99 damage|\(safe\)|\(probable\)/);
});

test("markdown export is localized", () => {
  const markdown = withLanguage("de", () => new CombatLogExportService().exportMarkdown(exportLog()));
  assert.match(markdown, /^- Status: Beendet$/m);
  assert.match(markdown, /^- Aria \(Freundlich\)$/m);
  assert.match(markdown, /^## Aktionen nach Runden$/m);
  assert.match(markdown, /^- Schaden der Gruppe pro Runde: 7,5$/m);
  assert.match(markdown, /^- Runde 2: Aria traf Goblin 2 mit Longsword für 9 Schaden\.$/m);
  assert.match(markdown, /^- Runde 2: Goblin 2 fiel auf 0 TP\.$/m);
});

test("markdown export marks running combats and empty logs", () => {
  const log = { ...exportLog(), status: "active", endedAt: null, events: [] };
  const markdown = __test__.renderMarkdownExport(log);
  assert.match(markdown, /^- Status: Active$/m);
  assert.match(markdown, /^- Ended: still running$/m);
  assert.match(markdown, /^No damage, healing or effects were recorded\.$/m);
});

test("markdown export downloads a .md file", () => {
  downloads.length = 0;
  const markdown = new CombatLogExportService().exportMarkdown(exportLog());
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "combat-log-1.md");
  assert.equal(downloads[0].type, "text/markdown");
  assert.equal(downloads[0].data, markdown);
});

test("JSON export keeps the raw log", () => {
  downloads.length = 0;
  const log = exportLog();
  const json = new CombatLogExportService().exportJson(log);
  assert.deepEqual(JSON.parse(json), log);
  assert.equal(downloads[0].filename, "combat-log-1.json");
  assert.equal(downloads[0].type, "application/json");
});

function csvLog() {
  const log = exportLog();
  log.computed.byCombatant = [
    { id: "aria", name: "Aria", side: SIDES.FRIENDLY, damageAppliedNet: 9, damageRolled: 11, damageTakenNet: 0, healingNet: 4, healingReceived: 4, martial: 1, ranged: 0, magic: 0, control: 1, crits: 1, fumbles: 0, downed: 0, takedowns: 1, netDPR: 4.5 },
    { id: "gob2", name: "Goblin 2", side: SIDES.HOSTILE, damageAppliedNet: 0, damageTakenNet: 16, downed: 1, netDPR: 0 },
    { id: "gob3", name: "", side: SIDES.HOSTILE }
  ];
  return log;
}

test("CSV export has one row per combatant with the main numbers", () => {
  const csv = __test__.renderCsvExport(csvLog());
  assert.ok(csv.startsWith("\uFEFF"), "byte order mark for Excel");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines[0], "Name,Side,Damage dealt (applied),Damage rolled,Damage taken,Healing done,Healing received,Melee hits,Ranged hits,Spell hits,Control effects,Critical hits,Fumbles,Times downed,Takedowns,Damage per round");
  assert.equal(lines[1], "Aria,Friendly,9,11,0,4,4,1,0,0,1,1,0,0,1,4.5");
  assert.equal(lines[2], "Goblin 2,Hostile,0,0,16,0,0,0,0,0,0,0,0,1,0,0");
  // A row without a name falls back to the participant name.
  assert.equal(lines[3], "Goblin 3,Hostile,0,0,0,0,0,0,0,0,0,0,0,0,0,0");
  assert.equal(lines.length, 5);
});

test("CSV export quotes text cells and defuses spreadsheet formulas", () => {
  const log = csvLog();
  log.computed.byCombatant[0].name = "Aria, the \"Brave\"";
  log.computed.byCombatant[1].name = "=HYPERLINK(\"http://x\")";
  const lines = __test__.renderCsvExport(log).slice(1).split("\r\n");
  assert.ok(lines[1].startsWith("\"Aria, the \"\"Brave\"\"\",Friendly,9,"));
  assert.ok(lines[2].startsWith("\"'=HYPERLINK(\"\"http://x\"\")\",Hostile,"));
  assert.equal(__test__.csvCell("-Spike"), "'-Spike");
  assert.equal(__test__.csvCell(" padded "), "\" padded \"");
  assert.equal(__test__.csvCell("Zoë"), "Zoë");
});

test("CSV export is localized and downloads a .csv file", () => {
  const csv = withLanguage("de", () => __test__.renderCsvExport(csvLog()));
  assert.match(csv, /^\uFEFFName,Seite,Ausgeteilter Schaden \(angewendet\),Gewürfelter Schaden,/);
  assert.match(csv, /\r\nAria,Freundlich,9,/);

  downloads.length = 0;
  const log = csvLog();
  const data = new CombatLogExportService().exportCsv(log);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "combat-log-1.csv");
  assert.equal(downloads[0].type, "text/csv");
  assert.equal(downloads[0].data, data);
  assert.equal(new TextEncoder().encode(data).slice(0, 3).join(","), "239,187,191");
});

test("exports are recorded as GM events", () => {
  const log = exportLog();
  new CombatLogExportService().appendExportEvent(log, "markdown");
  const event = log.events.at(-1);
  assert.equal(event.type, EVENT_TYPES.EXPORT_CREATED);
  assert.equal(event.visibility, "gm");
  assert.equal(event.userId, "gm-user");
  assert.deepEqual(event.data, { format: "markdown" });
});

test("markdown export has a damage per round table", () => {
  const log = exportLog();
  log.computed.byRound = [{ round: 1, partyDamage: 0, enemyDamage: 4 }, { round: 2, partyDamage: 9, enemyDamage: 0 }];
  const markdown = __test__.renderMarkdownExport(log);
  const table = markdown.slice(markdown.indexOf("## Damage per Round"), markdown.indexOf("## Actions by Round"));
  assert.deepEqual(table.trim().split("\n").slice(2), ["| Round | Party | Enemies |", "| ---: | ---: | ---: |", "| 1 | 0 | 4 |", "| 2 | 9 | 0 |"]);
  // Logs saved before the table existed compute it from their events.
  const old = __test__.renderMarkdownExport(exportLog());
  assert.match(old, /^\| 2 \| 9 \| 0 \|$/m);
  const quiet = { ...exportLog(), events: [] };
  assert.doesNotMatch(__test__.renderMarkdownExport(quiet), /Damage per Round/);
});

test("Crucible exports speak of health and morale and name the state reached", () => {
  const log = exportLog();
  log.systemId = "crucible";
  log.computed.summary.moraleDamageApplied = 6;
  log.events.find((event) => event.id === "hit-confirm").data.downState = "dead";
  log.events.push(
    { id: "rally", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, ...actorUpdate, data: { resourcePath: "system.resources.morale.value", pool: "morale", interpretedAs: "healing", delta: 3, oldValue: 2, newValue: 5, targetCombatantId: "aria", actionName: "Rally" } },
    { id: "fear", type: EVENT_TYPES.RESOURCE_DELTA, round: 2, combatantId: "aria", confidence: CONFIDENCE.SAFE, ...actorUpdate, data: { resourcePath: "system.resources.morale.value", pool: "morale", interpretedAs: "damage", delta: -6, oldValue: 6, newValue: 0, sourceCombatantId: "aria", attribution: "systemApplied", targetCombatantId: "gob2", actionName: "Taunt", downState: "broken", targetDowned: true }
    }
  );
  const markdown = __test__.renderMarkdownExport(log);
  assert.match(markdown, /^- Party members down: 0$/m);
  assert.match(markdown, /^- Morale damage: 6$/m);
  assert.match(markdown, /^- Unclear changes to health or morale, not counted: 1$/m);
  assert.match(markdown, /^- Round 1: Aria regained 4 health with Potion of Healing\.$/m);
  assert.match(markdown, /^- Round 2: Aria regained 3 morale with Rally\.$/m);
  assert.match(markdown, /^- Round 2: Aria hit Goblin 2 with Taunt for 6 morale damage\.$/m);
  assert.match(markdown, /^- Round 2: Goblin 2 fell\.$/m);
  assert.match(markdown, /^- Round 2: Goblin 2 broke\.$/m);
  assert.doesNotMatch(markdown, /HP/);

  const german = withLanguage("de", () => __test__.renderMarkdownExport(log));
  assert.match(german, /^- Runde 2: Goblin 2 verlor die Moral\.$/m);
  assert.match(german, /^- Runde 1: Aria erhielt mit Potion of Healing 4 Gesundheit zurück\.$/m);
});

test("Crucible CSV adds morale columns, other systems keep their columns", () => {
  const log = csvLog();
  log.systemId = "crucible";
  log.computed.byCombatant[0].moraleDamageDealt = 6;
  log.computed.byCombatant[1].moraleDamageTaken = 6;
  const lines = __test__.renderCsvExport(log).slice(1).split("\r\n");
  assert.equal(lines[0], "Name,Side,Damage dealt (applied),Damage rolled,Damage taken,Morale damage dealt,Morale damage taken,Healing done,Healing received,Melee hits,Ranged hits,Spell hits,Control effects,Critical hits,Fumbles,Times downed,Takedowns,Damage per round");
  assert.equal(lines[1], "Aria,Friendly,9,11,0,6,0,4,4,1,0,0,1,1,0,0,1,4.5");
  assert.equal(lines[2], "Goblin 2,Hostile,0,0,16,0,6,0,0,0,0,0,0,0,0,1,0,0");
  log.systemId = "dnd5e";
  assert.equal(__test__.renderCsvExport(log).slice(1).split("\r\n")[0].split(",").length, 16);
});
