import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, SHARE_MODES, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
const settings = new Map();

globalThis.game = {
  user: { id: "gm", isGM: true },
  i18n: { lang: "en", localize: (key) => english[key] ?? key },
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`), register: () => {} }
};
globalThis.Hooks = { on: () => {}, off: () => {} };
globalThis.foundry = { applications: { api: { ApplicationV2: class { async close() {} } } } };

const { ALL_SESSIONS, SESSION_GAP_MS, fightSpan, groupSessions, memberKey, sessionDiscordMessages, sessionReport, renderSessionHtml, sessionRows, summarizeFights } = await import("../scripts/services/session-service.js");
const { sessionPanel } = await import("../scripts/apps/session-panel.js");
const { playerViewLog } = await import("../scripts/services/player-view-service.js");
const { CombatLogApp } = await import("../scripts/apps/combat-log-app.js");

const HOUR = 60 * 60 * 1000;
const at = (iso, offsetMs = 0) => new Date(new Date(iso).getTime() + offsetMs).toISOString();

const ARIA = { combatantId: "", actorUuid: "Actor.aria", name: "Aria", side: SIDES.FRIENDLY, img: "aria.webp" };
const BRAM = { combatantId: "", actorUuid: "Actor.bram", name: "Bram", side: SIDES.FRIENDLY, img: "bram.webp" };

// A fight of minutes length with the party (Aria, Bram) and one goblin. hits: [source, target, amount, downed].
function fight(id, startedAt, { minutes = 30, hits = [], rounds = 2, extraEvents = [], share = {}, hidden = false } = {}) {
  const ids = { aria: `${id}-aria`, bram: `${id}-bram`, goblin: `${id}-goblin` };
  const events = [
    { id: `${id}-start`, type: EVENT_TYPES.COMBAT_STARTED, createdAt: startedAt, round: 1, confidence: CONFIDENCE.SAFE, data: {} },
    ...Array.from({ length: rounds }, (_, index) => ({ id: `${id}-round-${index + 1}`, type: EVENT_TYPES.ROUND_CHANGED, createdAt: at(startedAt, (index * minutes * 60000) / rounds), round: index + 1, confidence: CONFIDENCE.SAFE, data: {} })),
    ...hits.map(([source, target, amount, downed = false], index) => ({
      id: `${id}-hit-${index}`,
      type: EVENT_TYPES.DAMAGE_APPLIED,
      createdAt: at(startedAt, 60000 * (index + 1)),
      round: 1,
      combatantId: ids[source],
      visibility: VISIBILITY.PUBLIC,
      source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id: `${id}-message-${index}` },
      confidence: CONFIDENCE.SAFE,
      data: { amount, targetCombatantId: ids[target], targetDowned: downed }
    })),
    ...extraEvents.map((event) => ({ ...event, combatantId: ids[event.combatantId] ?? event.combatantId })),
    { id: `${id}-end`, type: EVENT_TYPES.COMBAT_ENDED, createdAt: at(startedAt, minutes * 60000), round: rounds, confidence: CONFIDENCE.SAFE, data: {} }
  ];
  return {
    id,
    title: `Fight ${id}`,
    status: "ended",
    systemId: "dnd5e",
    startedAt,
    endedAt: at(startedAt, minutes * 60000),
    participants: [
      { ...ARIA, combatantId: ids.aria },
      { ...BRAM, combatantId: ids.bram },
      { combatantId: ids.goblin, actorUuid: "Actor.goblin", name: "Goblin Boss", side: SIDES.HOSTILE, hidden }
    ],
    events,
    shareSettings: share
  };
}

test("fights less than six hours apart form one session, also past midnight", () => {
  const logs = [
    fight("a", "2026-10-24T19:00:00.000Z"),
    fight("b", "2026-10-24T22:30:00.000Z"),
    fight("c", "2026-10-25T01:15:00.000Z"),
    fight("d", "2026-10-31T19:00:00.000Z")
  ];
  const sessions = groupSessions(logs);

  assert.deepEqual(sessions.map((session) => session.logs.map((log) => log.id)), [["d"], ["a", "b", "c"]], "latest session first");
  assert.equal(sessions[1].id, "session-a");
  assert.equal(sessions[1].startedAt, "2026-10-24T19:00:00.000Z");
  assert.equal(sessions[1].endedAt, "2026-10-25T01:45:00.000Z");
});

test("a fight that goes on a week later counts for the session in which it started", () => {
  const long = fight("long", "2026-10-24T20:00:00.000Z", { minutes: 40 });
  // Resumed a week later: more rounds, then the end.
  long.events.push({ id: "long-resumed", type: EVENT_TYPES.COMBAT_RESUMED, createdAt: "2026-10-31T19:00:00.000Z", round: 3, data: {} });
  long.events.push({ id: "long-turn", type: EVENT_TYPES.TURN_CHANGED, createdAt: "2026-10-31T19:20:00.000Z", round: 3, data: {} });
  long.endedAt = "2026-10-31T19:30:00.000Z";
  const next = fight("next", "2026-10-31T20:00:00.000Z");

  const span = fightSpan(long);
  assert.equal(new Date(span.end).toISOString(), "2026-10-24T20:40:00.000Z", "the first sitting ends before the long pause");
  assert.equal(span.durationMs, 70 * 60000, "40 minutes, then 30 minutes a week later");
  const sessions = groupSessions([long, next]);
  assert.deepEqual(sessions.map((session) => session.logs.map((log) => log.id)), [["next"], ["long"]]);
  assert.ok(SESSION_GAP_MS >= 6 * HOUR);
});

test("a long break inside a fight is no time in combat, a share afterwards neither", () => {
  const log = fight("idle", "2026-10-24T19:00:00.000Z", { minutes: 20, rounds: 1 });
  // The combat stays open for two hours of role play, then the GM ends it and shares the report later.
  log.endedAt = "2026-10-24T22:20:00.000Z";
  log.events.find((event) => event.type === EVENT_TYPES.COMBAT_ENDED).createdAt = log.endedAt;
  log.events.push({ id: "idle-turn", type: EVENT_TYPES.TURN_CHANGED, createdAt: "2026-10-24T19:20:00.000Z", round: 1, data: {} });
  log.events.push({ id: "idle-share", type: EVENT_TYPES.SHARE_CREATED, createdAt: "2026-10-25T10:00:00.000Z", data: {} });
  const span = fightSpan(log);

  assert.equal(span.durationMs, 20 * 60000);
  assert.equal(new Date(span.end).toISOString(), "2026-10-24T22:20:00.000Z", "the session still runs until the fight ended");
});

test("a session adds up damage, the party against the enemies, and every member across fights", () => {
  const logs = [
    fight("a", "2026-10-24T19:00:00.000Z", { rounds: 2, hits: [["aria", "goblin", 12], ["bram", "goblin", 8, true], ["goblin", "bram", 5]] }),
    fight("b", "2026-10-24T20:00:00.000Z", { rounds: 3, hits: [["aria", "goblin", 20, true], ["goblin", "aria", 9], ["goblin", "aria", 4]] })
  ];
  const summary = summarizeFights(logs);

  assert.equal(summary.fights, 2);
  assert.equal(summary.rounds, 5);
  assert.equal(summary.durationMs, 60 * 60000);
  assert.equal(summary.damage, 58, "all damage dealt, party and enemies");
  assert.equal(summary.enemiesDefeated, 2);
  assert.equal(summary.enemyStats, true);
  assert.equal(summary.party.damageDealt, 40);
  assert.equal(summary.party.damageTaken, 18);
  assert.equal(summary.party.dpr, 8, "40 damage over 5 rounds");
  assert.equal(summary.enemies.damageDealt, 18);
  assert.equal(summary.enemies.damageTaken, 40);
  assert.equal(summary.enemies.downed, 2);
  assert.equal(summary.enemies.dpr, 3.6);

  assert.deepEqual(summary.members.map((member) => [member.name, member.fights, member.damageAppliedNet, member.damageTakenNet, member.takedowns]), [
    ["Aria", 2, 32, 13, 1],
    ["Bram", 2, 8, 5, 1]
  ]);
  assert.equal(summary.members[0].netDPR, 6.4);
  assert.deepEqual(summary.fightRows.map((row) => [row.id, row.partyDamage, row.enemyDamage]), [["a", 20, 5], ["b", 20, 13]]);
  const mvp = summary.awards.find((award) => award.key === "mvp");
  assert.deepEqual(mvp.winners.map((winner) => winner.name), ["Aria"]);
  assert.equal(mvp.value, 32);
  assert.deepEqual(summary.awards.find((award) => award.key === "takedowns").winners.map((winner) => winner.name), ["Aria", "Bram"]);
});

test("members are found by their world actor, tokens without one by name", () => {
  assert.equal(memberKey({ actorUuid: "Actor.aria", name: "Aria" }), "Actor.aria");
  assert.equal(memberKey({ actorUuid: "Scene.s.Token.t.Actor.wolf", name: " Wolf " }), "name:wolf");
  assert.equal(memberKey({ actorUuid: "", name: "Aria" }), "name:aria");
});

test("session awards count critical hits of every fight for the same member", () => {
  const crit = (id, combatantId) => ({ id, type: EVENT_TYPES.ROLL_ATTACK, combatantId, createdAt: "2026-10-24T19:05:00.000Z", visibility: VISIBILITY.PUBLIC, confidence: CONFIDENCE.SAFE, data: { isCritical: true } });
  const logs = [
    fight("a", "2026-10-24T19:00:00.000Z", { extraEvents: [crit("a-crit", "bram")] }),
    fight("b", "2026-10-24T20:00:00.000Z", { extraEvents: [crit("b-crit-1", "bram"), crit("b-crit-2", "aria")] })
  ];
  const lucky = summarizeFights(logs).awards.find((award) => award.key === "lucky");

  assert.deepEqual(lucky.winners.map((winner) => winner.name), ["Bram"]);
  assert.equal(lucky.value, 2);
});

test("player views without enemy numbers leave the enemies out of the whole session", () => {
  const shared = { isShared: true, shareMode: SHARE_MODES.FULL_VISIBLE_DPR, includeEnemyStats: true, anonymizeEnemies: true };
  const logs = [
    fight("a", "2026-10-24T19:00:00.000Z", { hits: [["aria", "goblin", 12], ["goblin", "aria", 5]], share: shared }),
    fight("b", "2026-10-24T20:00:00.000Z", { hits: [["bram", "goblin", 7], ["goblin", "bram", 3]], share: { anonymizeEnemies: true } })
  ];
  const sharedOnly = summarizeFights([playerViewLog(logs[0])]);
  assert.equal(sharedOnly.enemyStats, true);
  assert.equal(sharedOnly.enemies.damageDealt, 5);

  const summary = summarizeFights(logs.map((log) => playerViewLog(log)));
  assert.equal(summary.enemyStats, false, "one fight keeps its enemy numbers back");
  assert.equal(summary.damage, 19, "the totals are the party's");
  assert.equal(summary.party.damageDealt, 19);
  assert.equal(summary.fightRows[1].enemyDamage, null);
  const panel = sessionPanel(logs.map((log) => playerViewLog(log)));
  assert.equal(panel.enemyStats, false);
  assert.equal(panel.cards.find((entry) => entry.tone === "damage").label, english["SCLS.Label.PartyNetDamage"]);
  assert.equal(panel.chartLegend.length, 1);
  assert.equal(JSON.stringify(panel).includes("Goblin Boss"), false);
});

test("a hidden enemy stays out of what players see of the session", () => {
  const log = fight("a", "2026-10-24T19:00:00.000Z", { hits: [["aria", "goblin", 12]], hidden: true });
  const summary = summarizeFights([playerViewLog(log)]);

  assert.equal(summary.party.damageDealt, 0, "damage to a hidden combatant is not part of the player numbers");
  assert.equal(summarizeFights([log]).party.damageDealt, 12, "the GM sees it");
});

test("the panel follows the latest session and offers all sessions with absolute sums", () => {
  const logs = [
    fight("a", "2026-10-17T19:00:00.000Z", { hits: [["aria", "goblin", 10], ["goblin", "aria", 4]] }),
    fight("b", "2026-10-24T19:00:00.000Z", { hits: [["bram", "goblin", 6]] }),
    fight("c", "2026-10-24T20:00:00.000Z", { hits: [["aria", "goblin", 9], ["goblin", "bram", 2]] })
  ];
  const latest = sessionPanel(logs);
  assert.equal(latest.selectedId, "session-b");
  assert.deepEqual(latest.options.map((option) => option.value), ["session-b", "session-a", ALL_SESSIONS]);
  assert.equal(latest.options[0].selected, true);
  assert.equal(latest.options.at(-1).label, "All sessions · 3 fights");
  assert.deepEqual(latest.fightRows.map((row) => row.id), ["b", "c"]);
  assert.equal(latest.cards.find((entry) => entry.tone === "damage").value, "17");
  assert.deepEqual(latest.versus.slice(0, 2).map((row) => [row.label, row.party, row.enemies]), [[english["SCLS.Label.DamageDealt"], "15", "2"], [english["SCLS.Label.DamagePerRound"], "3.75", "0.5"]]);
  assert.equal(latest.versus[0].share, 88);
  assert.ok(latest.chart.includes("Fight b"), "the tooltips name the fights");

  const all = sessionPanel(logs, { selectedId: ALL_SESSIONS });
  assert.equal(all.isAll, true);
  assert.equal(all.cards.find((entry) => entry.tone === "damage").value, "31");
  assert.deepEqual(all.sessionRows.map((row) => [row.id, row.fights, row.partyDamage, row.enemyDamage]), [["session-b", "2", "15", "2"], ["session-a", "1", "10", "4"]]);
  assert.equal(all.fightRows.length, 0);

  const gone = sessionPanel(logs, { selectedId: "session-x" });
  assert.equal(gone.selectedId, "session-b", "an unknown session falls back to the latest");
  assert.deepEqual(sessionPanel([]), { hasFights: false, selectedId: null });
});

test("the session report reads like the player report and bolds names for Discord", () => {
  const logs = [
    fight("a", "2026-10-24T19:00:00.000Z", { hits: [["aria", "goblin", 12, true], ["goblin", "bram", 5]] }),
    fight("b", "2026-10-24T20:00:00.000Z", { hits: [["bram", "goblin", 6]] })
  ];
  const summary = summarizeFights(logs);
  const report = sessionReport(summary, { title: "Session of Saturday" });

  assert.deepEqual(report.sections.map((section) => section.label), [english["SCLS.Session.Report.Recap"], english["SCLS.Session.Report.Party"], english["SCLS.Metrics.Awards"], english["SCLS.Label.Fights"]]);
  assert.equal(report.sections[0].entries[0], "2 fights, 4 rounds, 1h 0m in combat.");
  assert.ok(report.sections[0].entries.includes("The party dealt 18 damage, 4.5 per round."));
  assert.ok(report.sections[0].entries.includes("The enemies dealt 5 damage, 1.25 per round."));
  assert.equal(report.sections[1].entries[0], "Aria: 12 damage and 1 enemy defeated.");
  assert.equal(report.sections[3].entries[0], "Fight a: 2 rounds, party 12 damage, enemies 5.");
  const html = renderSessionHtml(report);
  assert.ok(html.startsWith('<div class="scls-report scls-report--session">'));
  assert.ok(html.includes("<h3 class=\"scls-report__title\">Session of Saturday</h3>"));

  const discord = sessionDiscordMessages(sessionReport(summary, { title: "Session of Saturday", markNames: true }));
  assert.equal(discord.length, 1);
  assert.ok(discord[0].startsWith("## Session of Saturday"));
  assert.ok(discord[0].includes("- **Aria**: 12 damage and 1 enemy defeated."));
  assert.ok(discord[0].includes("MVP: **Aria**"));

  const sessions = groupSessions(logs);
  const overAll = sessionReport(summary, { title: "All", sessions: sessionRows(summary, sessions) });
  assert.equal(overAll.sections.at(-1).label, english["SCLS.Tab.sessions"]);
  assert.equal(overAll.sections.at(-1).entries.length, 1);
});

test("Crucible sessions speak of health and show morale damage", () => {
  const log = fight("a", "2026-10-24T19:00:00.000Z", { hits: [["aria", "goblin", 4]] });
  log.systemId = "crucible";
  log.events.push({ id: "heal", type: EVENT_TYPES.HEALING_APPLIED, combatantId: "a-bram", createdAt: "2026-10-24T19:10:00.000Z", round: 1, confidence: CONFIDENCE.SAFE, data: { amount: 3, targetCombatantId: "a-aria" } });
  const summary = summarizeFights([log]);

  assert.equal(summary.morale, true);
  assert.ok(sessionReport(summary).sections[0].entries.includes("The party restored 3 health."));
  assert.ok(sessionPanel([log]).cards.some((entry) => entry.tone === "morale"));
});

test("every new text exists in English and German", () => {
  const used = [
    ...readFileSync(new URL("../scripts/services/session-service.js", import.meta.url), "utf8").matchAll(/"(SCLS\.[A-Za-z.]+)"/g),
    ...readFileSync(new URL("../scripts/apps/session-panel.js", import.meta.url), "utf8").matchAll(/"(SCLS\.[A-Za-z.]+)"/g),
    ...readFileSync(new URL("../templates/combat-log-app.hbs", import.meta.url), "utf8").matchAll(/"(SCLS\.[A-Za-z.]+)"/g)
  ].map((match) => match[1]);
  const keys = new Set(used.flatMap((key) => key.endsWith(".") ? [] : /Count\.[A-Za-z]+$/.test(key) && !(key in english) ? [`${key}One`, `${key}Other`] : [key]));
  for (const key of keys) {
    assert.ok(key in english, `en: ${key}`);
    assert.ok(key in german, `de: ${key}`);
  }
  assert.deepEqual(Object.keys(english).sort(), Object.keys(german).sort());
});

test("the window builds the Sessions tab only while it is open, for players from their view", async () => {
  const stored = fight("a", "2026-10-24T19:00:00.000Z", { hits: [["aria", "goblin", 12], ["goblin", "aria", 5]], hidden: false });
  const service = {
    statsOptions: () => ({}),
    listActiveLogs: () => [],
    persistence: {
      loadLog: async () => structuredClone(stored),
      loadActiveLogs: async () => [],
      loadHistoryEntries: async () => [{ combatLogId: "a", title: stored.title, status: "ended", loaded: true }]
    }
  };
  game.user.isGM = false;
  try {
    const app = new CombatLogApp(service);
    app.activeTab = "history";
    const history = await app._prepareContext({});
    assert.equal(history.sessions, null, "not built for another tab");

    app.activeTab = "sessions";
    const context = await app._prepareContext({});
    assert.equal(context.activeTab, "sessions");
    assert.equal(context.sessions.hasFights, true);
    assert.equal(context.sessions.enemyStats, false);
    assert.equal(context.sessions.cards.find((entry) => entry.tone === "damage").value, "12");
    assert.equal(JSON.stringify(context.sessions).includes("Goblin Boss"), false);

    await app.handleSelectChange({ currentTarget: { dataset: { sclsAction: "selectSession" }, value: ALL_SESSIONS }, preventDefault() {} }).catch(() => {});
    assert.equal(app.sessionId, ALL_SESSIONS, "players may choose a session");
  } finally {
    game.user.isGM = true;
  }
});
