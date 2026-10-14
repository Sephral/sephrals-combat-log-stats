import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const translations = {
  en: JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")),
  de: JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"))
};

// "en" and "de" read the bundled files, "keys" returns every key unchanged.
let translationMode = "en";

globalThis.game = {
  user: { id: "gm-user", isGM: true },
  i18n: {
    get lang() {
      return translationMode === "de" ? "de" : "en";
    },
    localize: (key) => (translationMode === "keys" ? key : translations[translationMode]?.[key] ?? key)
  },
  settings: { get: () => undefined }
};

const { PlayerReportService, __test__ } = await import("../scripts/services/player-report-service.js");

const ALL_SECTIONS = Object.freeze({
  combatRecap: true,
  partyContributions: true,
  martialHighlights: true,
  spellwork: true,
  healingSupport: true,
  controlPlays: true,
  closeCalls: true,
  damageSpotlight: true,
  awards: true,
  heroMoments: true,
  enemyPressure: true,
  tacticalTurningPoints: true,
  supportSaves: true,
  aftermath: true
});

const observed = (kind = SOURCE_KINDS.ACTOR_UPDATE) => ({ visibility: VISIBILITY.GM, source: { kind, id: "x" } });

function hpDelta(id, round, sourceId, targetId, delta, oldValue, extra = {}) {
  return {
    id,
    type: EVENT_TYPES.RESOURCE_DELTA,
    round,
    combatantId: sourceId || targetId,
    confidence: CONFIDENCE.SAFE,
    ...observed(),
    data: {
      resourcePath: "system.attributes.hp.value",
      interpretedAs: delta < 0 ? "damage" : "healing",
      delta,
      oldValue,
      newValue: oldValue + delta,
      targetCombatantId: targetId,
      ...(sourceId ? { sourceCombatantId: sourceId, attribution: "correlatedChatRoll" } : {}),
      targetDowned: oldValue > 0 && oldValue + delta <= 0,
      ...extra
    }
  };
}

function reportLog(overrides = {}) {
  return {
    id: "log-1",
    title: "Smoke Combat",
    status: "ended",
    startedAt: "2026-05-17T10:00:00.000Z",
    endedAt: "2026-05-17T10:10:00.000Z",
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "healer", name: "Healer", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "controller", name: "Controller", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "foe", name: "Secret Foe", side: SIDES.HOSTILE, isPlayerOwned: false },
      { combatantId: "traitor", name: "Charmed Paladin", side: SIDES.HOSTILE, isPlayerOwned: true },
      { combatantId: "lurker", name: "Hidden Lurker", side: SIDES.HOSTILE, isPlayerOwned: false, hidden: true }
    ],
    computed: {
      summary: { rounds: 2, netDamageApplied: 46, grossDamageApplied: 46, netHealingApplied: 11, unclassifiedDeltas: 1 },
      dpr: {
        partyDPR: 13,
        enemyDPR: 10,
        bySide: [
          { id: SIDES.FRIENDLY, side: SIDES.FRIENDLY, damageAppliedNet: 26, healingNet: 11 },
          { id: SIDES.HOSTILE, side: SIDES.HOSTILE, damageAppliedNet: 20, healingNet: 0 }
        ],
        byCombatant: [
          { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 26, healingNet: 0, netDPR: 13 },
          { id: "healer", name: "Healer", side: SIDES.FRIENDLY, damageAppliedNet: 0, healingNet: 11, netDPR: 0 },
          { id: "controller", name: "Controller", side: SIDES.FRIENDLY, damageAppliedNet: 0, healingNet: 0, netDPR: 0 },
          { id: "foe", name: "Secret Foe", side: SIDES.HOSTILE, damageAppliedNet: 9, netDPR: 4.5 },
          { id: "traitor", name: "Charmed Paladin", side: SIDES.HOSTILE, damageAppliedNet: 4, netDPR: 2 },
          { id: "lurker", name: "Hidden Lurker", side: SIDES.HOSTILE, damageAppliedNet: 7, netDPR: 3.5 }
        ]
      }
    },
    events: [
      { id: "started", type: EVENT_TYPES.COMBAT_STARTED, round: 1, confidence: CONFIDENCE.SAFE, ...observed(SOURCE_KINDS.COMBAT_UPDATE), data: {} },
      { id: "fireball", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 12, actionName: "Fireball", actionKind: "spell", targetCombatantId: "foe", targetName: "Secret Foe" } },
      { id: "slash", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 8, actionName: "Longsword Slash", actionKind: "melee", targetCombatantId: "foe", targetName: "Secret Foe" } },
      { id: "smite", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "traitor", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 4, actionName: "Divine Smite", actionKind: "melee", targetCombatantId: "hero", targetName: "Hero" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, round: 1, combatantId: "healer", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 5, actionName: "Healing Word", targetCombatantId: "hero", targetName: "Hero" } },
      { id: "slow", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, round: 1, combatantId: "controller", confidence: CONFIDENCE.SAFE, ...observed(SOURCE_KINDS.ACTIVE_EFFECT_UPDATE), data: { name: "Slowed", statuses: ["slowed"], control: true, sourceCombatantId: "controller", targetCombatantId: "foe" } },
      { id: "bless", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, round: 1, combatantId: "healer", confidence: CONFIDENCE.SAFE, ...observed(SOURCE_KINDS.ACTIVE_EFFECT_UPDATE), data: { name: "Bless", statuses: [], control: false, sourceCombatantId: "healer", targetCombatantId: "hero" } },
      hpDelta("downed", 2, "foe", "hero", -9, 9, { actionName: "Heavy Crossbow", actionKind: "ranged" }),
      hpDelta("lurker-stab", 2, "lurker", "healer", -7, 20, { actionName: "Shadow Dagger", actionKind: "melee" }),
      hpDelta("revive", 2, "healer", "hero", 6, 0, { actionName: "Cure Wounds", actionKind: "spell" }),
      hpDelta("finisher", 2, "hero", "foe", -6, 6, { actionName: "Longsword", actionKind: "melee" }),
      { id: "unclear", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "hero", confidence: CONFIDENCE.UNCLEAR, ...observed(), data: { interpretedAs: "unknown", delta: -3, targetCombatantId: "hero" } },
      { id: "gm", type: EVENT_TYPES.GM_NOTE, round: 1, confidence: CONFIDENCE.MANUAL, visibility: VISIBILITY.GM, data: { note: "Secret plan" } },
      { id: "manual", type: EVENT_TYPES.DAMAGE_MANUAL_ADDED, round: 1, combatantId: "hero", confidence: CONFIDENCE.MANUAL, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.MANUAL, id: "manualAdjustment" }, data: { amount: 3, targetCombatantId: "foe" } }
    ],
    shareSettings: {
      isShared: true,
      shareMode: SHARE_MODES.FULL_VISIBLE_RECAP,
      includePartyStats: true,
      includeEnemyStats: true,
      includeNpcNames: false,
      includeHiddenCombatants: false,
      includePrivateRolls: false,
      includeGMNotes: false,
      includeUnclearEvents: false,
      includeCorrections: false,
      anonymizeEnemies: true,
      allowPlayersToOpenReport: true,
      reportSections: { ...ALL_SECTIONS },
      ...overrides
    }
  };
}

function markdownFor(log, mode = "en") {
  const previous = translationMode;
  translationMode = mode;
  try {
    const service = new PlayerReportService();
    return service.renderMarkdown(service.buildReport(log));
  } finally {
    translationMode = previous;
  }
}

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return null;
  const rest = markdown.slice(start + heading.length + 4);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

test("party contributions and damage spotlight list friendly participants only", () => {
  const markdown = markdownFor(reportLog());
  const contributions = section(markdown, "Party Contributions");
  const spotlight = section(markdown, "Damage Spotlight");

  assert.match(contributions, /^- Hero: 26 damage, 2 melee hits, 1 spell hit and 1 enemy defeated\.$/m);
  assert.match(contributions, /^- Healer: 11 healing\.$/m);
  assert.match(contributions, /^- Controller: 1 control effect\.$/m);
  assert.match(spotlight, /^- Hero: 26 damage, 13 per round\.$/m);
  for (const text of [contributions, spotlight]) {
    assert.doesNotMatch(text, /Charmed Paladin|Secret Foe|Enemy \d/);
  }
});

test("a quiet party member still gets a contribution line", () => {
  const log = reportLog();
  log.participants.push({ combatantId: "bard", name: "Bard", side: SIDES.FRIENDLY, isPlayerOwned: true });
  assert.match(section(markdownFor(log), "Party Contributions"), /^- Bard stayed in the fight and helped hold the line\.$/m);
});

test("enemy names are anonymized unless NPC names are explicitly included", () => {
  const anonymous = markdownFor(reportLog());
  assert.doesNotMatch(anonymous, /Secret Foe|Charmed Paladin/);
  assert.match(anonymous, /^- Round 1: Hero hit Enemy 1 with Longsword Slash for 8 damage\.$/m);

  const named = markdownFor(reportLog({ includeNpcNames: true }));
  assert.match(named, /Hero hit Secret Foe with Longsword Slash/);

  const notAnonymized = markdownFor(reportLog({ anonymizeEnemies: false }));
  assert.match(notAnonymized, /Hero hit Secret Foe with Longsword Slash/);
});

test("the enemy pressure section keeps enemy names anonymous", () => {
  const pressure = section(markdownFor(reportLog()), "Enemy Pressure");
  assert.match(pressure, /^- The enemies dealt 20 damage, 10 per round\.$/m);
  assert.match(pressure, /^- Round 2: Hero dropped to 0 HP after Enemy 1 used Heavy Crossbow\.$/m);
  assert.match(pressure, /Enemy 2 hit Hero with Divine Smite for 4 damage/);
  assert.doesNotMatch(pressure, /Secret Foe|Charmed Paladin/);
});

test("enemy numbers appear only in enemy pressure and only with enemy stats", () => {
  const markdown = markdownFor(reportLog());
  assert.doesNotMatch(section(markdown, "Combat Recap"), /enem(y|ies) dealt|per round.*enem/i);

  const withoutEnemyStats = markdownFor(reportLog({ includeEnemyStats: false }));
  assert.equal(section(withoutEnemyStats, "Enemy Pressure"), null);
  assert.doesNotMatch(withoutEnemyStats, /The enemies dealt|Enemies defeated:/);
});

test("hidden combatants and their events stay out unless the GM includes them", () => {
  const hidden = markdownFor(reportLog());
  assert.doesNotMatch(hidden, /Hidden Lurker|Shadow Dagger|Enemy 3/);
  assert.match(section(hidden, "Aftermath"), /^- Enemies defeated: 1 of 2\.$/m);

  const shown = markdownFor(reportLog({ includeHiddenCombatants: true }));
  assert.match(section(shown, "Enemy Pressure"), /Enemy 3 hit Healer with Shadow Dagger for 7 damage/);
  assert.match(section(shown, "Aftermath"), /^- Enemies defeated: 1 of 3\.$/m);
});

test("combat recap reports party totals, defeated enemies and party members down", () => {
  const recap = section(markdownFor(reportLog()), "Combat Recap");
  assert.match(recap, /^- The party dealt 26 damage over 2 rounds\.$/m);
  assert.match(recap, /^- The party healed 11 HP during the fight\.$/m);
  assert.match(recap, /^- Party pace: 13 damage per round\.$/m);
  assert.match(recap, /^- 1 enemy was defeated\.$/m);
  assert.match(recap, /^- A party member dropped to 0 HP once\.$/m);
  assert.doesNotMatch(recap, /could not be assigned/);
});

test("combat recap mentions unclear changes only when the GM shares them", () => {
  const log = reportLog({ includeUnclearEvents: true });
  log.computed.summary.unclassifiedDeltas = 2;
  assert.match(section(markdownFor(log), "Combat Recap"), /^- 2 HP changes could not be assigned clearly and are not counted\.$/m);
});

test("close calls name who caused the drop when the source is known", () => {
  const log = reportLog();
  log.events.push(hpDelta("trap", 3, "", "controller", -4, 4));
  const closeCalls = section(markdownFor(log), "Close Calls");
  assert.match(closeCalls, /^- Round 2: Hero dropped to 0 HP after Enemy 1 used Heavy Crossbow\.$/m);
  assert.match(closeCalls, /^- Round 3: Controller dropped to 0 HP\.$/m);
  assert.doesNotMatch(closeCalls, /Enemy 1 dropped/);
});

test("a confirming HP change does not count a drop to 0 HP twice", () => {
  const log = reportLog();
  log.events.push(
    { id: "bolt", type: EVENT_TYPES.DAMAGE_APPLIED, round: 3, combatantId: "foe", confidence: CONFIDENCE.PROBABLE, visibility: VISIBILITY.PUBLIC, tags: ["chat-applied"], data: { amount: 5, actionName: "Crossbow Bolt", targetCombatantId: "healer" } },
    hpDelta("bolt-confirm", 3, "foe", "healer", -5, 5, { interpretedAs: "ignored", duplicateOfEventId: "bolt" })
  );
  const markdown = markdownFor(log);
  assert.match(section(markdown, "Combat Recap"), /^- Party members dropped to 0 HP 2 times\.$/m);
  assert.equal((section(markdown, "Close Calls").match(/Healer dropped to 0 HP/g) ?? []).length, 1);
  assert.match(section(markdown, "Close Calls"), /Healer dropped to 0 HP after Enemy 1 used Crossbow Bolt/);
});

test("highlights fall back to generic wording instead of raw event types", () => {
  const log = reportLog();
  log.events.push({ id: "nameless", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 30, targetCombatantId: "foe" } });
  const markdown = markdownFor(log);
  assert.match(section(markdown, "Hero Moments"), /^- Round 1: Hero hit Enemy 1 for 30 damage\.$/m);
  assert.doesNotMatch(markdown, /damage\.applied|resource\.delta|activeEffect|combat\.started|roll\./);
});

test("whispered rolls and chat applications stay private unless private rolls are shared", () => {
  const log = reportLog();
  log.events.push(
    { id: "secret-roll", type: EVENT_TYPES.ROLL_DAMAGE, round: 2, combatantId: "foe", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.ROLL, id: "m1" }, data: { total: 5, actionName: "Assassinate" } },
    hpDelta("secret-hit", 2, "foe", "controller", -5, 30, { actionName: "Assassinate", correlation: { status: "correlated", rollEventId: "secret-roll" } }),
    { id: "whisper-applied", type: EVENT_TYPES.DAMAGE_APPLIED, round: 2, combatantId: "foe", confidence: CONFIDENCE.PROBABLE, visibility: VISIBILITY.GM, source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: "m2" }, data: { amount: 2, actionName: "Poison Needle", targetCombatantId: "controller" } }
  );

  const hidden = markdownFor(log);
  assert.doesNotMatch(hidden, /Assassinate|Poison Needle/);
  assert.match(section(hidden, "Enemy Pressure"), /Enemy 1 hit Controller for 5 damage/);

  log.shareSettings.includePrivateRolls = true;
  const shared = markdownFor(log);
  assert.match(shared, /Enemy 1 hit Controller with Assassinate for 5 damage/);
});

test("GM notes, manual corrections and unclear events never become highlights", () => {
  const markdown = markdownFor(reportLog({ includePrivateRolls: true }));
  assert.doesNotMatch(markdown, /Secret plan|for 3 damage/);
  const unclear = markdownFor(reportLog({ includeUnclearEvents: true }));
  assert.doesNotMatch(unclear, /Secret plan|for 3 damage/);
});

test("summary only mode shares totals without single actions", () => {
  const markdown = markdownFor(reportLog({ shareMode: SHARE_MODES.SUMMARY_ONLY }));
  assert.ok(section(markdown, "Combat Recap"));
  assert.ok(section(markdown, "Party Contributions"));
  for (const heading of ["Blades and Bows", "Spellwork", "Close Calls", "Damage Spotlight", "Enemy Pressure", "Hero Moments"]) {
    assert.equal(section(markdown, heading), null, heading);
  }
});

test("full visible DPR mode shares enemy totals but no single enemy actions", () => {
  const markdown = markdownFor(reportLog({ shareMode: SHARE_MODES.FULL_VISIBLE_DPR }));
  assert.equal(section(markdown, "Enemy Pressure"), "\n- The enemies dealt 20 damage, 10 per round.\n");
  assert.ok(section(markdown, "Damage Spotlight"));
  assert.equal(section(markdown, "Close Calls"), null);
});

test("player report renders only selected report sections", () => {
  const markdown = markdownFor(reportLog({
    reportSections: { ...ALL_SECTIONS, partyContributions: false, martialHighlights: false, spellwork: false, healingSupport: false, damageSpotlight: false, awards: false, heroMoments: false, enemyPressure: false, tacticalTurningPoints: false, supportSaves: false, aftermath: false }
  }));

  assert.deepEqual(markdown.match(/^## .+$/gm), ["## Combat Recap", "## Control Plays", "## Close Calls"]);
  assert.match(section(markdown, "Control Plays"), /^- Round 1: Controller afflicted Enemy 1 with Slowed\.$/m);
  assert.doesNotMatch(markdown, /^Status:|^Started:|^Rounds:/m);
});

test("player report renders the perspective sections", () => {
  const markdown = markdownFor(reportLog());

  assert.match(section(markdown, "Blades and Bows"), /^- Round 1: Hero hit Enemy 1 with Longsword Slash for 8 damage\.$/m);
  assert.match(section(markdown, "Spellwork"), /^- Round 1: Hero hit Enemy 1 with Fireball for 12 damage\.$/m);
  assert.match(section(markdown, "Healing and Support"), /^- Round 2: Healer restored 6 HP to Hero with Cure Wounds\.$/m);
  assert.match(section(markdown, "Hero Moments"), /^- Round 2: Hero defeated Enemy 1 with Longsword\.$/m);
  const turningPoints = section(markdown, "Tactical Turning Points");
  assert.match(turningPoints, /^- Round 1: 20 damage by the party, 1 control effect and 5 HP healed\.$/m);
  assert.match(turningPoints, /^- Round 2: 6 damage by the party, 1 enemy defeated, 1 party member at 0 HP and 6 HP healed\.$/m);
  const support = section(markdown, "Support and Saves");
  assert.match(support, /^- Round 2: Healer got Hero back on their feet with Cure Wounds\.$/m);
  assert.match(support, /^- Round 1: Healer strengthened Hero with Bless\.$/m);
  const aftermath = section(markdown, "Aftermath");
  assert.match(aftermath, /^- The fight lasted 2 rounds\.$/m);
  assert.match(aftermath, /^- Still standing at the end: Hero, Healer and Controller\.$/m);
});

test("aftermath lists party members still at 0 HP", () => {
  const log = reportLog();
  log.events = log.events.filter((event) => event.id !== "revive");
  assert.match(section(markdownFor(log), "Aftermath"), /^- At 0 HP at the end: Hero\.$/m);
});

test("healing rolls are not counted next to the applied healing", () => {
  const log = reportLog();
  log.events.push({ id: "heal-roll", type: EVENT_TYPES.ROLL_HEALING, round: 1, combatantId: "healer", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { total: 5, actionName: "Healing Word" } });
  const markdown = markdownFor(log);
  assert.match(markdown, /^- Healer: 11 healing\.$/m);
  assert.equal((markdown.match(/restored 5 HP/g) ?? []).length, 1);
});

test("passive damage taken is not credited as enemy damage dealt", () => {
  const log = reportLog();
  log.computed.dpr.enemyDPR = 0;
  log.computed.dpr.bySide = [{ id: SIDES.FRIENDLY, side: SIDES.FRIENDLY, damageAppliedNet: 58, healingNet: 0 }, { id: SIDES.HOSTILE, side: SIDES.HOSTILE, damageAppliedNet: 0, healingNet: 0 }];
  log.computed.dpr.byCombatant = [{ id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 58, netDPR: 14.5 }];
  log.events = [hpDelta("taken", 1, "", "foe", -58, 80)];

  const markdown = markdownFor(log);
  assert.match(markdown, /^- Hero: 58 damage\.$/m);
  assert.doesNotMatch(markdown, /The enemies dealt|Enemy 1 hit/);
});

test("report text comes from the language files", () => {
  const keys = markdownFor(reportLog(), "keys");
  const body = keys.split("\n").slice(1).filter(Boolean);
  assert.ok(body.length > 20);
  for (const line of body) assert.match(line, /^(## |- )SCLS\.(ReportSection|Report|Award)\./, line);
  assert.match(keys, /^## SCLS\.ReportSection\.CombatRecap$/m);
  assert.match(keys, /^- SCLS\.Report\.Recap\.DamageOther$/m);
  assert.match(keys, /^- SCLS\.Report\.Contribution\.Line$/m);

  const german = markdownFor(reportLog(), "de");
  assert.match(german, /^## Kampfrückblick$/m);
  assert.match(german, /^## Klingen und Bögen$/m);
  assert.match(german, /^- Die Gruppe verursachte 26 Schaden in 2 Runden\.$/m);
  assert.match(german, /^- Runde 1: Hero traf Gegner 1 mit Longsword Slash für 8 Schaden\.$/m);
  assert.match(german, /^- Runde 2: Hero fiel auf 0 TP, nachdem Gegner 1 Heavy Crossbow eingesetzt hatte\.$/m);
});

test("report and export keys exist in English and German and follow the text rules", () => {
  const own = /^SCLS\.(Report|Export|ReportSection)\./;
  const sources = ["player-report-service.js", "export-service.js"].map((file) => readFileSync(new URL(`../scripts/services/${file}`, import.meta.url), "utf8")).join("\n");
  const used = new Set(Array.from(sources.matchAll(/"(SCLS\.(?:Report|Export|ReportSection)\.[A-Za-z.]+)"/g), (match) => match[1]));
  const ownKeys = (language) => Object.keys(translations[language]).filter((key) => own.test(key)).sort();

  assert.deepEqual(ownKeys("de"), ownKeys("en"));
  assert.deepEqual(Array.from(used).sort(), ownKeys("en"), "every key is used and every used key exists");
  for (const language of ["en", "de"]) {
    const keys = Object.keys(translations[language]);
    for (const key of keys) assert.ok(!keys.some((other) => other.startsWith(`${key}.`)), `${language}: ${key} is both a string and a namespace`);
    for (const key of ownKeys(language)) {
      const value = translations[language][key];
      assert.doesNotMatch(value, /;|\s[-–—]\s|[–—]/, `${language}: ${key}`);
      if (language === "de") assert.doesNotMatch(value.replace(/\{\w+\}/g, ""), /ae|oe|fuer|zurueck|rueck|ueber|stuetz|liess|muess/i, `${language}: ${key} should use umlauts`);
    }
  }
});

test("an empty report says so instead of rendering nothing", () => {
  const log = reportLog({ reportSections: Object.fromEntries(Object.keys(ALL_SECTIONS).map((key) => [key, false])) });
  assert.equal(markdownFor(log), "# Smoke Combat\n\nNo shareable combat details were recorded.\n");
});

test("disabled sharing blocks report publication", () => {
  const service = new PlayerReportService();
  assert.equal(service.canShare(reportLog({ isShared: false })), false);
  assert.equal(service.canShare(reportLog({ shareMode: SHARE_MODES.GM_ONLY })), false);
  assert.equal(service.canShare(reportLog()), true);
});

test("journal reports are readable by players and owned by the creating GM", async () => {
  const created = [];
  globalThis.JournalEntry = { create: async (data) => { created.push(data); return data; } };
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 }, JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
  try {
    const log = reportLog();
    const entry = await new PlayerReportService().createJournalReport(log);
    assert.deepEqual(entry.ownership, { default: 2, "gm-user": 3 });
    assert.equal(entry.name, "Smoke Combat");
    assert.match(entry.pages[0].text.content, /<h4>Combat Recap<\/h4>/);
    assert.equal(log.events.at(-1).type, EVENT_TYPES.SHARE_UPDATED);

    delete globalThis.CONST;
    assert.deepEqual(__test__.journalOwnership(), { default: 2, "gm-user": 3 });
    assert.equal(created.length, 1);
  } finally {
    delete globalThis.JournalEntry;
    delete globalThis.CONST;
  }
});

test("chat summaries are posted publicly as HTML", async () => {
  globalThis.ChatMessage = { create: async (data) => data, getSpeaker: () => ({ alias: "GM" }) };
  try {
    const message = await new PlayerReportService().postChatSummary(reportLog());
    assert.deepEqual(message.whisper, []);
    assert.match(message.content, /^<div class="scls-report">\n<h3 class="scls-report__title">Smoke Combat<\/h3>/);
    assert.match(message.content, /<li>Round 1: Hero hit Enemy 1 with Longsword Slash for 8 damage\.<\/li>/);
    assert.equal(await new PlayerReportService().postChatSummary(reportLog({ isShared: false })), null);
  } finally {
    delete globalThis.ChatMessage;
  }
});

test("stopping the share hides the journal reports of that combat from players", async () => {
  const journals = new Map();
  globalThis.JournalEntry = { create: async (data) => {
    const entry = { ...data, uuid: `JournalEntry.j${journals.size + 1}`, update: async (changes) => { entry.ownership.default = changes["ownership.default"]; } };
    journals.set(entry.uuid, entry);
    return entry;
  } };
  globalThis.fromUuid = async (uuid) => journals.get(uuid) ?? null;
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 }, JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 } };
  try {
    const log = reportLog();
    const service = new PlayerReportService();
    await service.createJournalReport(log);
    await service.createJournalReport(log);
    assert.deepEqual(log.shareSettings.journalUuids, ["JournalEntry.j1", "JournalEntry.j2"]);
    journals.delete("JournalEntry.j2");

    assert.equal(await service.revokeJournalReports(log), 1);
    assert.equal(journals.get("JournalEntry.j1").ownership.default, 0);
    assert.equal(journals.get("JournalEntry.j1").ownership["gm-user"], 3);
  } finally {
    delete globalThis.JournalEntry;
    delete globalThis.fromUuid;
    delete globalThis.CONST;
  }
});

test("the HTML report is a styled card with a heading and a list per section", () => {
  const service = new PlayerReportService();
  const log = reportLog({ reportSections: { ...Object.fromEntries(Object.keys(ALL_SECTIONS).map((key) => [key, false])), combatRecap: true, controlPlays: true } });
  log.title = "Ambush <at> the Ford";
  const html = service.renderHtml(service.buildReport(log));

  assert.match(html, /^<div class="scls-report">\n<h3 class="scls-report__title">Ambush &lt;at&gt; the Ford<\/h3>\n/);
  assert.deepEqual(html.match(/<h4>[^<]+<\/h4>/g), ["<h4>Combat Recap</h4>", "<h4>Control Plays</h4>"]);
  assert.match(html, /<div class="scls-report__section"><h4>Control Plays<\/h4><ul><li>Round 1: Controller afflicted Enemy 1 with Slowed\.<\/li><\/ul><\/div>/);
  assert.match(html, /<\/div>$/);
  assert.doesNotMatch(html, /<h1>|<h2>|&bull;/);

  const empty = service.renderHtml(service.buildReport(reportLog({ reportSections: Object.fromEntries(Object.keys(ALL_SECTIONS).map((key) => [key, false])) })));
  assert.match(empty, /<p class="scls-report__empty">No shareable combat details were recorded\.<\/p>/);
});

test("the Discord report bolds names, keeps headings at ## and contains no HTML", () => {
  const service = new PlayerReportService();
  const [message, ...rest] = service.discordMessages(reportLog());

  assert.equal(rest.length, 0);
  assert.match(message, /^## Smoke Combat\n\n\*\*Combat Recap\*\*\n- The party dealt 26 damage over 2 rounds\.$/m);
  assert.match(message, /^- Round 1: \*\*Hero\*\* hit \*\*Enemy 1\*\* with Longsword Slash for 8 damage\.$/m);
  assert.match(message, /^- \*\*Hero\*\*: 26 damage, 2 melee hits, 1 spell hit and 1 enemy defeated\.$/m);
  assert.doesNotMatch(message, /^#(?!# )|^###|<[a-z]/m);
  // The share settings apply exactly as in chat: anonymized enemies, no hidden combatants, no GM notes.
  assert.doesNotMatch(message, /Secret Foe|Charmed Paladin|Hidden Lurker|Shadow Dagger|Secret plan/);
  assert.match(service.discordMessages(reportLog({ includeNpcNames: true }))[0], /\*\*Hero\*\* hit \*\*Secret Foe\*\* with Longsword Slash/);
});

test("the Discord report escapes formatting characters and mass mentions in names and actions", () => {
  const log = reportLog();
  log.participants[0].name = "@everyone *Star*_Blade";
  log.computed.dpr.byCombatant[0].name = log.participants[0].name;
  log.events.find((event) => event.id === "slash").data.actionName = "Sword|of~Doom`";
  const message = new PlayerReportService().discordMessages(log).join("\n");

  assert.match(message, /\*\*@\u200beveryone \\\*Star\\\*\\_Blade\*\* hit \*\*Enemy 1\*\* with Sword\\\|of\\~Doom\\` for 8 damage\./);
  assert.doesNotMatch(message, /[\u0001\u0002]/);
  assert.doesNotMatch(message, /@everyone/);
});

test("the Discord text is split at sections and lines into messages of at most 2,000 characters", () => {
  const { splitDiscordMessage } = __test__;
  const section = (name, count, width = 60) => [`**${name}**`, ...Array.from({ length: count }, (_, index) => `- ${name} line ${index + 1} `.padEnd(width, "x"))].join("\n");
  const text = ["## Title", section("A", 10), section("B", 20), section("C", 50)].join("\n\n");
  const messages = splitDiscordMessage(text);

  assert.equal(messages.length, 3);
  for (const message of messages) assert.ok(message.length <= 2000, `${message.length}`);
  // Sections that fit stay whole. A section longer than one message starts a new one and continues at a line break.
  assert.equal(messages[0], ["## Title", section("A", 10), section("B", 20)].join("\n\n"));
  assert.ok(messages[1].startsWith("**C**\n- C line 1 "));
  assert.ok(messages[2].startsWith("- C line "));
  for (const message of messages) for (const line of message.split("\n")) assert.ok(line === "" || /^(## |\*\*|- )/.test(line), line);
  assert.equal(messages.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));

  assert.deepEqual(splitDiscordMessage("short"), ["short"]);
  assert.deepEqual(splitDiscordMessage(""), []);
  const long = splitDiscordMessage(`- ${"word ".repeat(700)}`.trim());
  assert.equal(long.length, 2);
  assert.ok(long.every((message) => message.length <= 2000));
  assert.equal(long.join(" "), `- ${"word ".repeat(700)}`.trim());
});

test("a long player report becomes several Discord messages that keep every line", () => {
  const log = reportLog();
  for (let index = 0; index < 60; index += 1) {
    log.events.push({ id: `bolt-${index}`, type: EVENT_TYPES.DAMAGE_APPLIED, round: 3, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 1, actionName: `Arcane Bolt Number ${index} with a long and descriptive name`, actionKind: "spell", targetCombatantId: "foe" } });
  }
  log.participants.push(...Array.from({ length: 40 }, (_, index) => ({ combatantId: `ally-${index}`, name: `Allied Adventurer ${index}`, side: SIDES.FRIENDLY, isPlayerOwned: true })));
  const service = new PlayerReportService();
  const messages = service.discordMessages(log);
  const single = service.renderDiscordMarkdown(service.buildReport(log, { markNames: true }));

  assert.ok(single.length > 2000);
  assert.ok(messages.length > 1);
  for (const message of messages) assert.ok(message.length <= 2000);
  assert.equal(messages.join("\n\n").split("\n").filter(Boolean).length, single.split("\n").filter(Boolean).length);
});

test("the awards section names party members only, with the share toggle and in the Discord copy", () => {
  const log = reportLog();
  log.computed.byCombatant = log.computed.dpr.byCombatant.map((entry) => ({ ...entry, control: entry.id === "controller" ? 1 : 0, takedowns: entry.id === "hero" ? 1 : 0, damageTakenNet: entry.id === "healer" ? 7 : 0 }));
  const awards = section(markdownFor(log), "Awards");
  assert.match(awards, /^- MVP: Hero, 26 damage and healing\.$/m);
  assert.match(awards, /^- Best Healer: Healer, 11 healing\.$/m);
  assert.match(awards, /^- Crowd Control: Controller, 1 control effect\.$/m);
  assert.match(awards, /^- Takedowns: Hero, 1 takedown\.$/m);
  assert.match(awards, /^- Clutch Save: Healer, 1 ally back on their feet\.$/m);
  assert.doesNotMatch(awards, /Secret Foe|Charmed Paladin|Hidden Lurker|Enemy \d/);

  assert.equal(section(markdownFor({ ...log, shareSettings: { ...log.shareSettings, reportSections: { ...ALL_SECTIONS, awards: false } } }), "Awards"), null);
  const [discord] = new PlayerReportService().discordMessages(log);
  assert.match(discord, /^\*\*Awards\*\*\n- MVP: \*\*Hero\*\*, 26 damage and healing\.$/m);

  const german = section(markdownFor(log, "de"), "Auszeichnungen");
  assert.match(german, /^- MVP: Hero, 26 Schaden und Heilung\.$/m);
});

test("Crucible reports speak of health, morale and the state reached instead of 0 HP", () => {
  const log = reportLog();
  log.systemId = "crucible";
  log.events.find((event) => event.id === "downed").data.downState = "weakened";
  log.events.push(hpDelta("taunt", 2, "controller", "foe", -4, 4, { pool: "morale", resourcePath: "system.resources.morale.value", actionName: "Taunt", actionKind: "other", downState: "broken", targetDowned: true }));
  const markdown = markdownFor(log);
  assert.match(section(markdown, "Combat Recap"), /^- The party restored 11 health during the fight\.$/m);
  assert.match(section(markdown, "Combat Recap"), /^- A party member went down once\.$/m);
  assert.match(section(markdown, "Close Calls"), /^- Round 2: Hero was weakened after Enemy 1 used Heavy Crossbow\.$/m);
  assert.match(section(markdown, "Healing and Support"), /^- Round 2: Healer restored 6 health to Hero with Cure Wounds\.$/m);
  assert.match(section(markdown, "Tactical Turning Points"), /1 party member down and 6 health restored/);
  // The foe was already defeated by the hero; breaking it afterwards is no second defeat.
  assert.match(section(markdown, "Hero Moments"), /Hero defeated Enemy 1 with Longsword/);
  assert.doesNotMatch(section(markdown, "Hero Moments"), /Controller defeated Enemy 1/);
  assert.doesNotMatch(markdown, /HP/);

  const german = markdownFor(log, "de");
  assert.match(german, /^- Runde 2: Hero wurde geschwächt, nachdem Gegner 1 Heavy Crossbow eingesetzt hatte\.$/m);
  assert.doesNotMatch(german, /TP/);
});

test("Crucible morale damage is told as morale damage and not added to party damage", () => {
  const log = reportLog({ includeNpcNames: true });
  log.systemId = "crucible";
  log.computed.dpr.byCombatant.find((entry) => entry.id === "controller").moraleDamageDealt = 9;
  log.events.push(hpDelta("taunt", 1, "controller", "foe", -9, 9, { pool: "morale", resourcePath: "system.resources.morale.value", actionName: "Taunt", actionKind: "melee" }));
  const markdown = markdownFor(log);
  assert.match(section(markdown, "Blades and Bows"), /Controller hit Secret Foe with Taunt for 9 morale damage\./);
  // The foe broke after it was already defeated by the hero: no second defeat for the controller.
  assert.match(section(markdown, "Party Contributions"), /^- Controller: 9 morale damage, 1 melee hit and 1 control effect\.$/m);
  assert.match(section(markdown, "Combat Recap"), /^- 1 enemy was defeated\.$/m);
  assert.match(section(markdown, "Tactical Turning Points"), /^- Round 1: 20 damage by the party/m);
});

test("an undone Crucible hit is no hit in the report and its card's critical is no hero moment", () => {
  const log = reportLog({ includeNpcNames: true });
  log.systemId = "crucible";
  log.events.push(
    { id: "card", type: EVENT_TYPES.ACTION_USED, round: 3, combatantId: "controller", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { messageId: "m-undo", status: "reversed", actionName: "Longbow", actionKind: "ranged" } },
    { id: "card-roll", type: EVENT_TYPES.ROLL_ATTACK, round: 3, combatantId: "controller", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, source: { kind: SOURCE_KINDS.ROLL, id: "m-undo" }, data: { isCritical: true, actionName: "Longbow" } },
    hpDelta("undone-hit", 3, "controller", "foe", -15, 15, { actionName: "Longbow", actionKind: "ranged", reversed: true }),
    hpDelta("undo", 3, "controller", "foe", 15, 0, { interpretedAs: "correctionDamageDown", reversal: true, reversalOf: "undone-hit" })
  );
  const markdown = markdownFor(log);
  assert.doesNotMatch(markdown, /Longbow/);
  assert.doesNotMatch(section(markdown, "Party Contributions") ?? "", /Controller:[^\n]*ranged hit/);
});
