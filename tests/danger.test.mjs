import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
let lang = "en";
globalThis.game = { system: { id: "dnd5e" }, i18n: { lang: "en", localize: (key) => (lang === "de" ? german : english)[key] ?? key }, settings: { get: () => undefined } };

const { dangerInput, dangerLabel, dangerState, dangerTooltip, DANGER_LEVELS } = await import("../scripts/services/danger-service.js");
const { Pf2eSystemAdapter } = await import("../scripts/adapters/pf2e-adapter.js");
const { CrucibleSystemAdapter } = await import("../scripts/adapters/crucible-adapter.js");

const hero = (hp, max = 20, down = false) => ({ hp, max, down });

test("a healthy party against fresh enemies is calm", () => {
  const state = dangerState({ heroes: [hero(20), hero(20)], foes: [hero(30, 30)], round: 1 });
  assert.equal(state.level, DANGER_LEVELS.SAFE);
  assert.equal(state.party, 1);
  assert.equal(state.down, 0);
});

test("levels rise as hit points drop and heroes fall", () => {
  const foes = [hero(21, 30)];
  const states = [
    dangerState({ heroes: [hero(20), hero(20)], foes, round: 2 }),
    dangerState({ heroes: [hero(8), hero(8)], foes, round: 3 }),
    dangerState({ heroes: [hero(0, 20, true), hero(8)], foes, round: 4 }),
    dangerState({ heroes: [hero(0, 20, true), hero(3)], foes: [hero(28, 30)], round: 5 })
  ];
  assert.deepEqual(states.map((state) => state.level), ["safe", "tense", "critical", "critical"]);
  assert.ok(states[0].score < states[1].score && states[1].score < states[2].score && states[2].score < states[3].score);
});

test("a party on the floor is critical, beaten enemies calm it down", () => {
  assert.equal(dangerState({ heroes: [hero(0, 20, true)], foes: null }).level, "critical");
  assert.equal(dangerState({ heroes: [hero(0, 20, true)], foes: null }).score, 1);
  assert.equal(dangerState({ heroes: [hero(6), hero(5)], foes: [hero(0, 30)] }).level, "safe");
});

test("unknown opponents count as a neutral half, no heroes or no maximum give no bar", () => {
  const withUnknown = dangerState({ heroes: [hero(10), hero(10)], foes: null });
  const withHalf = dangerState({ heroes: [hero(10), hero(10)], foes: [hero(15, 30)] });
  assert.equal(withUnknown.score, withHalf.score);
  assert.equal(withUnknown.foes, null);
  assert.equal(dangerState({ heroes: [] }), null);
  assert.equal(dangerState({ heroes: [hero(5, 0)] }), null);
});

test("the tooltip explains the numbers in both languages", () => {
  const state = dangerState({ heroes: [hero(3), hero(5, 20), hero(0, 20, true), hero(11)], foes: [hero(21, 30)], round: 3 });
  assert.equal(dangerTooltip({ ...state, party: 0.38, foes: 0.7, down: 1 }), "Party at 38 % HP, one hero down, enemies at 70 %, round 3");
  assert.equal(dangerTooltip({ ...state, party: 1, foes: null, down: 0 }), "Party at 100 % HP, nobody down, round 3");
  lang = "de";
  try {
    assert.equal(dangerTooltip({ ...state, party: 0.38, foes: 0.7, down: 1 }), "Gruppe bei 38 % TP, ein Held am Boden, Gegner bei 70 %, Runde 3");
    assert.ok(dangerTooltip({ ...state, down: 2, foes: null }, "crucible").includes("Gesundheit"));
    assert.equal(dangerLabel({ level: "critical" }), "Gefahr: brenzlig");
  } finally {
    lang = "en";
  }
});

test("combatants are split into heroes and hostile tokens, defeated foes count as 0", () => {
  const actor = (hp, max, player) => ({ system: { attributes: { hp: { value: hp, max } } }, hasPlayerOwner: player });
  const combat = {
    round: 4,
    combatants: [
      { actor: actor(10, 20, true), token: { disposition: 1 } },
      { actor: actor(0, 20, true), token: { disposition: 1 }, isDefeated: true },
      { actor: actor(15, 30, false), token: { disposition: -1 } },
      { actor: actor(30, 30, false), token: { disposition: -1 }, isDefeated: true },
      { actor: actor(9, 9, false), token: { disposition: 0 } },
      { actor: null }
    ]
  };
  const input = dangerInput(combat, "dnd5e");
  assert.equal(input.heroes.length, 2);
  assert.equal(input.heroes[1].down, true);
  assert.deepEqual(input.foes.map((foe) => foe.hp), [15, 0]);
  assert.equal(input.round, 4);
});

test("pf2e reads hit points like dnd5e, Crucible reads health and its states", () => {
  assert.deepEqual(new Pf2eSystemAdapter().readVitals({ system: { attributes: { hp: { value: 12, max: 30 } } } }), { hp: 12, max: 30, down: false });
  const crucible = new CrucibleSystemAdapter();
  assert.deepEqual(crucible.readVitals({ system: { resources: { health: { value: 0, max: 40 } }, isWeakened: true } }), { hp: 0, max: 40, down: true });
  assert.equal(crucible.readVitals({ system: { resources: { health: { value: 9, max: 40 } } } }).down, false);
  assert.equal(crucible.readVitals({ system: {} }), null);
});
