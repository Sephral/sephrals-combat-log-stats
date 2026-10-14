import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
globalThis.game = { i18n: { lang: "en", localize: (key) => english[key] ?? key }, settings: { get: () => undefined } };

const { awardDetail, awardLine, computeAwards, __test__ } = await import("../scripts/services/awards-service.js");

const members = [{ id: "aria", name: "Aria" }, { id: "bran", name: "Bran" }, { id: "cleo", name: "Cleo" }];
const rows = [
  { id: "aria", damageAppliedNet: 30, healingNet: 0, damageTakenNet: 12, downed: 0, control: 0, takedowns: 2 },
  { id: "bran", damageAppliedNet: 10, healingNet: 14, damageTakenNet: 25, downed: 1, control: 2, takedowns: 0 },
  { id: "cleo", damageAppliedNet: 0, healingNet: 0, damageTakenNet: 18, downed: 0, control: 2, takedowns: 0 },
  { id: "orc", damageAppliedNet: 99, healingNet: 50, damageTakenNet: 99, downed: 0, control: 9, takedowns: 9 }
];
const attack = (id, combatantId, { crit = false, fumble = false, dice = [10] } = {}) => ({
  id,
  type: EVENT_TYPES.ROLL_ATTACK,
  combatantId,
  confidence: CONFIDENCE.SAFE,
  data: { isCritical: crit, isFumble: fumble, dice: [{ faces: 20, results: dice }] }
});
const byKey = (awards) => Object.fromEntries(awards.map((award) => [award.key, award]));

test("awards go to party members with the best value and never to enemies", () => {
  const awards = byKey(computeAwards({ members, rows, events: [] }));
  assert.deepEqual(awards.mvp.winners.map((winner) => winner.name), ["Aria"]);
  assert.equal(awards.mvp.value, 30);
  assert.deepEqual(awards.healer.winners.map((winner) => winner.name), ["Bran"]);
  assert.equal(awards.takedowns.value, 2);
  for (const award of Object.values(awards)) assert.ok(award.winners.every((winner) => winner.id !== "orc"), award.key);
});

test("the damage sponge never went down, equal values share an award", () => {
  const awards = byKey(computeAwards({ members, rows, events: [] }));
  // Bran took the most damage but went down.
  assert.deepEqual(awards.sponge.winners.map((winner) => winner.name), ["Cleo"]);
  assert.deepEqual(awards.control.winners.map((winner) => winner.name), ["Bran", "Cleo"]);
  assert.equal(awardLine(awards.control), "Crowd Control: Bran and Cleo, 2 control effects.");
});

test("MVP adds damage, healing and morale damage, a tie goes to more takedowns", () => {
  const tied = [
    { id: "aria", damageAppliedNet: 20, healingNet: 0, takedowns: 0 },
    { id: "bran", damageAppliedNet: 10, healingNet: 4, moraleDamageDealt: 6, takedowns: 1 }
  ];
  const [mvp] = computeAwards({ members, rows: tied, events: [] });
  assert.equal(mvp.key, "mvp");
  assert.equal(mvp.value, 20);
  assert.deepEqual(mvp.winners.map((winner) => winner.name), ["Bran"]);
  assert.equal(awardLine(mvp), "MVP: Bran, 20 damage and healing.");
});

test("categories without data are left out", () => {
  assert.deepEqual(computeAwards({ members, rows: [], events: [] }), []);
  assert.deepEqual(computeAwards({ members: [], rows, events: [] }), []);
});

test("lucky counts critical hits, unlucky counts fumbles and the dice break ties", () => {
  const events = [
    attack("a1", "aria", { crit: true, dice: [20] }),
    attack("b1", "bran", { crit: true, dice: [15] }),
    attack("b2", "bran", { fumble: true, dice: [1] }),
    attack("c1", "cleo", { fumble: true, dice: [10] }),
    attack("o1", "orc", { crit: true, dice: [20] }),
    attack("o2", "orc", { crit: true, dice: [20] })
  ];
  const awards = byKey(computeAwards({ members, rows: [], events }));
  assert.deepEqual(awards.lucky.winners.map((winner) => winner.name), ["Aria"]);
  assert.equal(awardDetail(awards.lucky), "1 critical hit");
  assert.deepEqual(awards.unlucky.winners.map((winner) => winner.name), ["Bran"]);
  assert.equal(awardDetail(awards.unlucky), "1 fumble");
});

test("without fumbles the lowest average dice are unlucky, with at least three tests", () => {
  const events = ["x1", "x2", "x3"].map((id) => attack(id, "cleo", { dice: [3] })).concat(["y1", "y2"].map((id) => attack(id, "bran", { dice: [1] })));
  const awards = byKey(computeAwards({ members, rows: [], events }));
  assert.deepEqual(awards.unlucky.winners.map((winner) => winner.name), ["Cleo"]);
  assert.equal(awardDetail(awards.unlucky), "the lowest rolls of the fight");
  // Good dice are no bad luck.
  const good = ["z1", "z2", "z3"].map((id) => attack(id, "cleo", { dice: [18] }));
  assert.equal(byKey(computeAwards({ members, rows: [], events: good })).unlucky, undefined);
});

test("Crucible dice pools count toward the luck of the dice", () => {
  const summary = __test__.rollSummary([{ type: EVENT_TYPES.ROLL_CHECK, combatantId: "aria", data: { dice: [{ faces: 8, results: [8, 8, 1] }] } }], new Set(["aria"]));
  assert.equal(Math.round(summary.get("aria").average * 1000) / 1000, Math.round((14 / 21) * 1000) / 1000);
});

test("a clutch save brings a downed ally back, healing oneself does not count", () => {
  const heal = (id, source, target) => ({
    id,
    type: EVENT_TYPES.RESOURCE_DELTA,
    combatantId: source,
    confidence: CONFIDENCE.SAFE,
    data: { resourcePath: "system.resources.health.value", interpretedAs: "healing", delta: 5, oldValue: 0, newValue: 5, sourceCombatantId: source, targetCombatantId: target, attribution: "systemApplied" }
  });
  const awards = byKey(computeAwards({ members, rows: [], events: [heal("h1", "bran", "aria"), heal("h2", "cleo", "cleo"), heal("h3", "bran", "cleo")] }));
  assert.deepEqual(awards.clutch.winners.map((winner) => winner.name), ["Bran"]);
  assert.equal(awards.clutch.value, 2);
  assert.equal(awardDetail(awards.clutch), "2 allies back on their feet");
});
