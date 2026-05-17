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
      { combatantId: "foe", name: "Secret Foe", side: SIDES.HOSTILE, isPlayerOwned: false }
    ],
    computed: {
      summary: { rounds: 2, netDamageApplied: 20, grossDamageApplied: 24, netHealingApplied: 5, unclassifiedDeltas: 1 },
      dpr: {
        partyDPR: 10,
        enemyDPR: 4,
        byCombatant: [
          { id: "hero", name: "Hero", side: SIDES.FRIENDLY, damageAppliedNet: 20, netDPR: 10, unclearEvents: 0 },
          { id: "foe", name: "Secret Foe", side: SIDES.HOSTILE, damageAppliedNet: 8, netDPR: 4, unclearEvents: 1 }
        ]
      },
      warnings: ["1 unclear resource changes are excluded from default DPR."]
    },
    events: [
      { id: "safe", type: EVENT_TYPES.ROLL_DAMAGE, round: 1, confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC },
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
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe"]);
  assert.equal(report.summary.unclassifiedDeltas, null);
});

test("player report keeps GM-only manual corrections hidden from private roll sharing", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includePrivateRolls: true, includeCorrections: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe"]);
});

test("player report can include manual corrections when GM notes and corrections are shared", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includeGMNotes: true, includeCorrections: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "gm", "manual"]);
});

test("player report can include unclear timeline entries when shared", () => {
  const report = new PlayerReportService().buildReport(reportLog({ includeUnclearEvents: true }));
  assert.deepEqual(report.timeline.map((entry) => entry.id), ["safe", "unclear"]);
  assert.equal(report.summary.unclassifiedDeltas, 1);
});

test("disabled sharing blocks report publication", () => {
  assert.equal(new PlayerReportService().canShare(reportLog({ isShared: false })), false);
  assert.equal(new PlayerReportService().canShare(reportLog({ shareMode: SHARE_MODES.GM_ONLY })), false);
  assert.equal(new PlayerReportService().canShare(reportLog()), true);
});
