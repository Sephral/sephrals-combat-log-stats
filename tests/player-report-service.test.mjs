import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, SHARE_MODES, SIDES, VISIBILITY } from "../scripts/constants.js";
import { PlayerReportService } from "../scripts/services/player-report-service.js";

function reportLog(overrides = {}) {
  return {
    title: "Smoke Combat",
    status: "ended",
    startedAt: "2026-05-17T10:00:00.000Z",
    endedAt: "2026-05-17T10:10:00.000Z",
    participants: [
      { combatantId: "hero", name: "Hero", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "healer", name: "Healer", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "controller", name: "Controller", side: SIDES.FRIENDLY, isPlayerOwned: true },
      { combatantId: "foe", name: "Secret Foe", side: SIDES.HOSTILE, isPlayerOwned: false }
    ],
    computed: {
      summary: { rounds: 2, netDamageApplied: 20, grossDamageApplied: 24, netHealingApplied: 5, unclassifiedDeltas: 1 },
      dpr: {
        partyDPR: 10,
        enemyDPR: 4,
        bySide: [
          { id: SIDES.FRIENDLY, side: SIDES.FRIENDLY, damageAppliedNet: 20, damageAppliedGross: 20, healingNet: 5 },
          { id: SIDES.HOSTILE, side: SIDES.HOSTILE, damageAppliedNet: 8, damageAppliedGross: 8, healingNet: 0 }
        ],
        byCombatant: [
          { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 20, healingNet: 0, netDPR: 10, unclearEvents: 0 },
          { id: "healer", name: "Healer", side: SIDES.FRIENDLY, damageAppliedNet: 0, healingNet: 5, netDPR: 0, unclearEvents: 0 },
          { id: "controller", name: "Controller", side: SIDES.FRIENDLY, damageAppliedNet: 0, netDPR: 0, unclearEvents: 0 },
          { id: "foe", name: "Secret Foe", side: SIDES.HOSTILE, damageAppliedNet: 8, netDPR: 4, unclearEvents: 1 }
        ]
      },
      warnings: ["1 unclear resource changes are excluded from default DPR."]
    },
    events: [
      { id: "safe", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 12, actionName: "Fireball", targetCombatantId: "foe", targetName: "Secret Foe" } },
      { id: "martial", type: EVENT_TYPES.DAMAGE_APPLIED, round: 1, combatantId: "hero", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 8, actionName: "Longsword Slash", targetCombatantId: "foe", targetName: "Secret Foe" } },
      { id: "heal", type: EVENT_TYPES.HEALING_APPLIED, round: 1, combatantId: "healer", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 5, actionName: "Healing Word", targetCombatantId: "hero", targetName: "Hero" } },
      { id: "control", type: EVENT_TYPES.ACTIVE_EFFECT_CREATED, round: 1, combatantId: "controller", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { name: "Slowed", actionName: "Slow", targetCombatantId: "foe", targetName: "Secret Foe" } },
      { id: "downed", type: EVENT_TYPES.DAMAGE_APPLIED, round: 2, combatantId: "foe", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { amount: 9, actionName: "Heavy Crossbow", targetCombatantId: "hero", targetName: "Hero", targetHpAfter: 0 } },
      { id: "unclear", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, confidence: CONFIDENCE.UNCLEAR, visibility: VISIBILITY.PUBLIC },
      { id: "gm", type: EVENT_TYPES.GM_NOTE, round: 1, confidence: CONFIDENCE.MANUAL, visibility: VISIBILITY.GM },
      { id: "manual", type: EVENT_TYPES.DAMAGE_MANUAL_ADDED, round: 1, confidence: CONFIDENCE.MANUAL, visibility: VISIBILITY.GM }
    ],
    shareSettings: {
      isShared: true,
      shareMode: SHARE_MODES.FULL_VISIBLE_RECAP,
      includePartyStats: true,
      includeEnemyStats: true,
      includeNpcNames: false,
      includePrivateRolls: false,
      includeGMNotes: false,
      includeUnclearEvents: false,
      includeDPR: true,
      includeTimeline: true,
      includeCorrections: false,
      anonymizeEnemies: true,
      allowPlayersToOpenReport: true,
      ...overrides
    }
  };
}

test("player report anonymizes hostile names by default", () => {
  const report = new PlayerReportService().buildReport(reportLog());
  assert.equal(report.participants.find((entry) => entry.side === SIDES.HOSTILE)?.name, "Enemy 1");
  assert.equal(report.dpr.find((entry) => entry.side === SIDES.HOSTILE)?.name, "Enemy 1");
});

test("player report hides unclear and GM-only timeline entries by default", () => {
  const report = new PlayerReportService().buildReport(reportLog());
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "martial", "heal", "control", "downed"]);
  assert.equal(report.summary.unclassifiedDeltas, null);
});

test("player report renders a recap instead of raw participants and timeline", () => {
  const service = new PlayerReportService();
  const markdown = service.renderMarkdown(service.buildReport(reportLog()));

  assert.match(markdown, /## Combat Recap/);
  assert.doesNotMatch(markdown, /^Status:/m);
  assert.doesNotMatch(markdown, /^Started:/m);
  assert.doesNotMatch(markdown, /^Ended:/m);
  assert.doesNotMatch(markdown, /^Rounds:/m);
  assert.match(markdown, /## Party Contributions/);
  assert.match(markdown, /## Blades, Bows, and Close Calls/);
  assert.match(markdown, /## Spellwork/);
  assert.match(markdown, /## Healing and Support/);
  assert.match(markdown, /## Control Plays/);
  assert.match(markdown, /## Close Calls/);
  assert.match(markdown, /Fireball/);
  assert.match(markdown, /dropped to 0 HP/);
  assert.match(markdown, /## Damage Spotlight/);
  assert.doesNotMatch(markdown, /## Participants/);
  assert.doesNotMatch(markdown, /## Timeline/);
});

test("player report recap uses party totals instead of all-side totals", () => {
  const log = reportLog();
  log.computed.summary.netDamageApplied = 77;
  log.computed.summary.grossDamageApplied = 77;
  log.computed.dpr.partyDPR = 28;
  log.computed.dpr.enemyDPR = 10.5;
  log.computed.dpr.bySide = [
    { id: SIDES.FRIENDLY, side: SIDES.FRIENDLY, damageAppliedNet: 56, damageAppliedGross: 56, healingNet: 5 },
    { id: SIDES.HOSTILE, side: SIDES.HOSTILE, damageAppliedNet: 21, damageAppliedGross: 21, healingNet: 0 }
  ];

  const markdown = new PlayerReportService().renderMarkdown(new PlayerReportService().buildReport(log));

  assert.match(markdown, /The party dealt 56 total damage over 2 rounds/);
  assert.match(markdown, /Party pace: 28 damage per round/);
  assert.match(markdown, /Enemy pressure: 10\.5 damage per round/);
  assert.doesNotMatch(markdown, /The party dealt 77 total damage/);
});

test("player report mentions each friendly player contribution", () => {
  const service = new PlayerReportService();
  const markdown = service.renderMarkdown(service.buildReport(reportLog()));

  assert.match(markdown, /Hero:/);
  assert.match(markdown, /Healer:/);
  assert.match(markdown, /Controller:/);
  assert.match(markdown, /5 healing/);
  assert.match(markdown, /1 control plays/);
});

test("player report does not double count healing rolls and applications", () => {
  const log = reportLog();
  log.events.push({ id: "heal-roll", type: EVENT_TYPES.ROLL_HEALING, round: 1, combatantId: "healer", confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, data: { total: 5, actionName: "Healing Word", targetCombatantId: "hero", targetName: "Hero" } });

  const markdown = new PlayerReportService().renderMarkdown(new PlayerReportService().buildReport(log));

  assert.match(markdown, /Healer: 5 healing/);
  assert.doesNotMatch(markdown, /Healer: 10 healing/);
  assert.equal((markdown.match(/restored 5 HP/g) ?? []).length, 1);
});

test("player report does not credit passive damage taken as hostile damage dealt", () => {
  const log = reportLog();
  log.computed.summary.netDamageApplied = 58;
  log.computed.dpr.partyDPR = 14.5;
  log.computed.dpr.enemyDPR = 0;
  log.computed.dpr.byCombatant = [
    { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 58, damageTakenNet: 0, netDPR: 14.5, unclearEvents: 0 },
    { id: "foe", name: "Secret Foe", side: SIDES.HOSTILE, damageAppliedNet: 0, damageTakenNet: 58, netDPR: 0, unclearEvents: 0 }
  ];
  log.events = [
    { id: "taken", type: EVENT_TYPES.RESOURCE_DELTA, round: 1, combatantId: "foe", confidence: CONFIDENCE.PROBABLE, visibility: VISIBILITY.PUBLIC, data: { delta: -58, interpretedAs: "damage" } }
  ];

  const markdown = new PlayerReportService().renderMarkdown(new PlayerReportService().buildReport(log));

  assert.match(markdown, /Hero: 58 damage/);
  assert.match(markdown, /Party pace: 14\.5 damage per round/);
  assert.match(markdown, /Enemy pressure: 0 damage per round/);
  assert.doesNotMatch(markdown, /Enemy 1: 58 damage/);
});

test("player report keeps GM-only manual corrections hidden from private roll sharing", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includePrivateRolls: true, includeCorrections: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "martial", "heal", "control", "downed"]);
});

test("player report keeps GM notes and manual corrections hidden", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includeGMNotes: true, includeCorrections: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "martial", "heal", "control", "downed"]);
});

test("player report can include unclear timeline entries when shared", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includeUnclearEvents: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "martial", "heal", "control", "downed", "unclear"]);
  assert.equal(report.summary.unclassifiedDeltas, 1);
});

test("disabled sharing blocks report publication", () => {
  assert.equal(new PlayerReportService().canShare(reportLog({ isShared: false })), false);
  assert.equal(new PlayerReportService().canShare(reportLog({ shareMode: SHARE_MODES.GM_ONLY })), false);
  assert.equal(new PlayerReportService().canShare(reportLog()), true);
});

test("player report renders only selected report sections", () => {
  const service = new PlayerReportService();
  const markdown = service.renderMarkdown(service.buildReport(reportLog({
    reportSections: {
      combatRecap: true,
      partyContributions: false,
      martialHighlights: false,
      spellwork: false,
      healingSupport: false,
      controlPlays: true,
      closeCalls: true,
      damageSpotlight: false,
      heroMoments: false,
      enemyPressure: false,
      tacticalTurningPoints: false,
      supportSaves: false,
      aftermath: false
    }
  })));

  assert.match(markdown, /## Combat Recap/);
  assert.match(markdown, /## Control Plays/);
  assert.match(markdown, /## Close Calls/);
  assert.doesNotMatch(markdown, /## Party Contributions/);
  assert.doesNotMatch(markdown, /## Spellwork/);
  assert.doesNotMatch(markdown, /## Healing and Support/);
  assert.doesNotMatch(markdown, /## Damage Spotlight/);
});

test("player report renders selectable perspective sections", () => {
  const service = new PlayerReportService();
  const markdown = service.renderMarkdown(service.buildReport(reportLog({
    reportSections: {
      combatRecap: false,
      partyContributions: false,
      martialHighlights: false,
      spellwork: false,
      healingSupport: false,
      controlPlays: false,
      closeCalls: false,
      damageSpotlight: false,
      heroMoments: true,
      enemyPressure: true,
      tacticalTurningPoints: true,
      supportSaves: true,
      aftermath: true,
    }
  })));

  assert.match(markdown, /## Hero Moments/);
  assert.match(markdown, /Hero landed Fireball/);
  assert.match(markdown, /## Enemy Pressure/);
  assert.match(markdown, /Secret Foe nearly swung the fight/);
  assert.match(markdown, /## Tactical Turning Points/);
  assert.match(markdown, /changed the tactical shape/);
  assert.match(markdown, /## Support and Saves/);
  assert.match(markdown, /Healer supported Hero/);
  assert.match(markdown, /## Aftermath/);
  assert.match(markdown, /player-side combatants/);
});
