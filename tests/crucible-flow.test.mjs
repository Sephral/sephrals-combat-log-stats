import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_STATUS, CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS, SETTINGS } from "../scripts/constants.js";

const settings = new Map([
  [`sephrals-combat-log-stats.${SETTINGS.RESOURCE_DELTA_WINDOW_MS}`, 3000],
  [`sephrals-combat-log-stats.${SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS}`, false],
  [`sephrals-combat-log-stats.${SETTINGS.DEFAULT_DPR_METHOD}`, "appliedNet"]
]);

globalThis.game = {
  user: { id: "gm", isGM: true },
  system: { id: "crucible" },
  world: { id: "test-world" },
  version: "14.369",
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`) },
  modules: { get: () => ({ version: "1.0.0" }) },
  combats: { contents: [] }
};
globalThis.Hooks = { callAll: () => {} };

const { CombatLogService } = await import("../scripts/services/combat-log-service.js");
const { CombatStatsService } = await import("../scripts/services/stats-service.js");

// A Crucible actor as the service sees it: values in the source, maxima and reserve use derived.
function crucibleActor({ id, uuid, token = null, type = "hero", health = 20, wounds = 0, morale = 12, madness = 0, reserves = type === "hero" }) {
  const actor = {
    id,
    uuid,
    type,
    documentName: "Actor",
    isToken: Boolean(token),
    token,
    system: {
      usesReserveResources: reserves,
      resources: { health: { value: health, max: 20 }, wounds: { value: wounds, max: 30 }, morale: { value: morale, max: 12 }, madness: { value: madness, max: 18 } }
    },
    toObject() {
      const values = Object.fromEntries(Object.entries(this.system.resources).map(([key, resource]) => [key, { value: resource.value }]));
      return { type: this.type, system: { resources: values } };
    }
  };
  return actor;
}

function fixture() {
  const hero = crucibleActor({ id: "hero", uuid: "Actor.hero", health: 20 });
  const orc = crucibleActor({ id: "orcBase", uuid: "Scene.s.Token.orc.Actor.orcBase", token: { uuid: "Scene.s.Token.orc" }, type: "adversary", health: 12, morale: 8 });
  const combat = { id: "combat1", uuid: "Combat.combat1", round: 1, turn: 0, combatants: [], scene: { uuid: "Scene.s" } };
  const log = {
    id: "log1",
    combatId: combat.id,
    systemId: "crucible",
    sceneUuid: "Scene.s",
    participants: [
      { combatantId: "c-hero", actorId: "hero", actorUuid: "Actor.hero", actorLink: true, tokenId: "heroToken", tokenUuid: "Scene.s.Token.heroToken", name: "Aria", side: "friendly" },
      { combatantId: "c-orc", actorId: "orcBase", actorUuid: orc.uuid, actorLink: false, tokenId: "orc", tokenUuid: "Scene.s.Token.orc", name: "Orc", side: "hostile" }
    ],
    sessionSegments: [],
    events: []
  };
  game.combats.contents = [combat];
  const service = new CombatLogService({ persistDelayMs: 0 });
  service.persistence.saveLog = async (saved) => saved;
  service.activeLogs.set(combat.id, log);
  return { service, log, hero, orc, combat };
}

function strikeCard(id, { health = -5, wounds = 0, morale = 0, target = "Scene.s.Token.orc.Actor.orcBase", confirmed = false } = {}) {
  const resources = [{ resource: "health", delta: health }, { resource: "wounds", delta: wounds }, { resource: "morale", delta: morale }].filter((entry) => entry.delta);
  return {
    id,
    speaker: { scene: "s", token: "heroToken", actor: "hero" },
    author: { id: "player" },
    whisper: [],
    rolls: [{ class: "AttackRoll", formula: "3d8 + 3", total: 19, isCriticalSuccess: false, isCriticalFailure: false, data: { dc: 12 }, dice: [{ faces: 8, results: [{ result: 5 }, { result: 6 }, { result: 5 }] }] }],
    flags: {
      crucible: {
        actor: "Actor.hero",
        action: { id: "strike", name: "Longsword Strike", tags: ["strike", "melee"], range: { category: "melee" } },
        confirmed,
        targets: [{ actor: target, token: "Scene.s.Token.orc" }],
        events: [
          { type: "activation", target: "Actor.hero", resources: [{ resource: "action", delta: -2 }], effects: [] },
          { type: "strike", target, rollIndex: 0, resources, effects: [] }
        ]
      }
    }
  };
}

async function changeResources(service, actor, changes) {
  service.actorSnapshots.set(actor.uuid, actor.toObject());
  for (const [key, value] of Object.entries(changes)) actor.system.resources[key].value = value;
  return service.actorUpdated(actor, {}, {}, "gm");
}

const deltas = (log) => log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA);
const actionEvent = (log, messageId) => log.events.find((event) => event.type === EVENT_TYPES.ACTION_USED && event.data.messageId === messageId);
const stats = (log) => CombatStatsService.compute(log, { defaultDprMethod: "appliedNet" });
const row = (computed, id) => computed.byCombatant.find((entry) => entry.id === id);

test("an action card is kept as an open action with its planned outcome per target", async () => {
  const { service, log } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -5 }));

  const action = actionEvent(log, "card1");
  assert.equal(action.combatantId, "c-hero");
  assert.equal(action.data.status, ACTION_STATUS.PENDING);
  assert.equal(action.data.actionName, "Longsword Strike");
  assert.equal(action.data.plannedDamage, 5);
  assert.equal(action.data.outcomes.length, 1);
  assert.equal(action.data.outcomes[0].targetCombatantId, "c-orc");
  assert.deepEqual(action.data.outcomes[0].pools, { health: -5 });
  assert.equal(action.data.rollEventId, log.events.find((event) => event.type === EVENT_TYPES.ROLL_ATTACK).id);

  const computed = stats(log);
  assert.equal(computed.summary.openActions, 1);
  assert.equal(computed.warningCounts.openActions, 1);
  assert.equal(computed.summary.netDamageApplied, 0);
  // The planned damage counts as rolled damage, like a damage roll in other systems.
  assert.equal(row(computed, "c-hero").damageRolled, 5);
});

test("the confirmed outcome is credited exactly to the acting combatant", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -5 }));
  await changeResources(service, orc, { health: 7 });
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: true } } });

  const [delta] = deltas(log);
  assert.equal(delta.combatantId, "c-hero");
  assert.equal(delta.confidence, CONFIDENCE.SAFE);
  assert.equal(delta.data.attribution, "systemApplied");
  assert.equal(delta.data.sourceCombatantId, "c-hero");
  assert.equal(delta.data.targetCombatantId, "c-orc");
  assert.equal(delta.data.actionName, "Longsword Strike");
  assert.equal(delta.data.correlation.status, "plannedAction");
  assert.equal(delta.data.correlation.messageId, "card1");
  const action = actionEvent(log, "card1");
  assert.equal(action.data.status, ACTION_STATUS.CONFIRMED);
  assert.equal(action.data.outcomes[0].state, "applied");
  assert.deepEqual(action.data.outcomes[0].deltaEventIds, [delta.id]);

  const computed = stats(log);
  assert.equal(computed.summary.openActions, 0);
  assert.equal(row(computed, "c-hero").damageAppliedNet, 5);
  assert.equal(row(computed, "c-orc").damageTakenNet, 5);
  assert.equal(row(computed, "c-hero").martial, 1);
});

test("a killing blow names the state and counts as a takedown", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -12 }));
  await changeResources(service, orc, { health: 0 });

  const [delta] = deltas(log);
  assert.equal(delta.data.downState, "dead");
  assert.equal(delta.data.targetDowned, true);
  const computed = stats(log);
  assert.equal(row(computed, "c-hero").takedowns, 1);
  assert.equal(computed.summary.enemiesDefeated, 1);
});

test("undoing a confirmed card becomes a correction and opens the card again", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -12 }));
  await changeResources(service, orc, { health: 0 });
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: true } } });
  // Crucible reverses: the pools go back first, then the flag.
  await changeResources(service, orc, { health: 12 });
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: false } } });

  const [original, undo] = deltas(log);
  assert.equal(original.data.reversed, true);
  assert.equal(undo.data.reversal, true);
  assert.equal(undo.data.reversalOf, original.id);
  assert.equal(undo.data.interpretedAs, RESOURCE_INTERPRETATIONS.CORRECTION_DAMAGE_DOWN);
  assert.equal(undo.combatantId, "c-hero");
  const action = actionEvent(log, "card1");
  assert.equal(action.data.status, ACTION_STATUS.REVERSED);
  assert.equal(action.data.outcomes[0].state, "pending");
  assert.equal(action.data.outcomes[0].reversals, 1);

  let computed = stats(log);
  assert.equal(row(computed, "c-hero").damageAppliedNet, 0);
  assert.equal(row(computed, "c-orc").damageTakenNet, 0);
  assert.equal(row(computed, "c-hero").takedowns, 0);
  assert.equal(computed.summary.damageCorrectionsDown, 12);
  assert.equal(computed.summary.openActions, 1);

  // Confirming again matches the card again.
  await changeResources(service, orc, { health: 0 });
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: true } } });
  computed = stats(log);
  assert.equal(deltas(log)[2].data.sourceCombatantId, "c-hero");
  assert.equal(row(computed, "c-hero").damageAppliedNet, 12);
  assert.equal(row(computed, "c-hero").takedowns, 1);
});

test("equal open cards wait for the confirmation of their message", async () => {
  const { service, log, orc, hero } = fixture();
  log.participants.push({ combatantId: "c-bran", actorId: "bran", actorUuid: "Actor.bran", actorLink: true, tokenId: "branToken", tokenUuid: "Scene.s.Token.branToken", name: "Bran", side: "friendly" });
  await service.chatMessageCreated(strikeCard("card-aria", { health: -4 }));
  const bran = strikeCard("card-bran", { health: -4 });
  bran.speaker = { scene: "s", token: "branToken", actor: "bran" };
  bran.flags.crucible.actor = "Actor.bran";
  await service.chatMessageCreated(bran);

  await changeResources(service, orc, { health: 8 });
  const [delta] = deltas(log);
  assert.equal(delta.data.attribution, undefined);
  assert.equal(delta.data.correlation.status, "awaitingConfirmation");
  assert.equal(delta.data.plannedCandidates.length, 2);

  await service.chatMessageUpdated({ id: "card-bran" }, { flags: { crucible: { confirmed: true } } });
  assert.equal(delta.data.sourceCombatantId, "c-bran");
  assert.equal(delta.confidence, CONFIDENCE.SAFE);
  assert.equal(delta.data.plannedCandidates, undefined);
  assert.equal(actionEvent(log, "card-aria").data.outcomes[0].state, "pending");
  assert.equal(actionEvent(log, "card-bran").data.outcomes[0].state, "applied");
  assert.ok(hero);
});

test("a change cut short by an empty pool is a probable match", async () => {
  const { service, log, orc } = fixture();
  orc.system.resources.health.value = 3;
  await service.chatMessageCreated(strikeCard("card1", { health: -8 }));
  await changeResources(service, orc, { health: 0 });
  const [delta] = deltas(log);
  assert.equal(delta.data.sourceCombatantId, "c-hero");
  assert.equal(delta.confidence, CONFIDENCE.PROBABLE);
});

test("damage nobody planned stays without a source", async () => {
  const { service, log, orc } = fixture();
  await changeResources(service, orc, { health: 9 });
  const [delta] = deltas(log);
  assert.equal(delta.data.attribution, undefined);
  assert.equal(delta.data.correlation.status, "uncorrelated");
  assert.equal(row(stats(log), "c-orc").damageTakenNet, 3);
});

test("morale damage is counted on its own and is not part of damage per round", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: 0, morale: -8 }));
  await changeResources(service, orc, { morale: 0 });

  const [delta] = deltas(log);
  assert.equal(delta.data.pool, "morale");
  assert.equal(delta.data.downState, "broken");
  assert.equal(delta.data.sourceCombatantId, "c-hero");
  const computed = stats(log);
  assert.equal(row(computed, "c-hero").moraleDamageDealt, 8);
  assert.equal(row(computed, "c-orc").moraleDamageTaken, 8);
  assert.equal(row(computed, "c-hero").damageAppliedNet, 0);
  assert.equal(computed.summary.moraleDamageApplied, 8);
  assert.equal(computed.summary.netDamageApplied, 0);
  assert.equal(computed.dpr.partyDPR, 0);
});

test("a deleted open card is no open action and no rolled damage", async () => {
  const { service, log } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -5 }));
  await service.chatMessageDeleted({ id: "card1" });
  assert.equal(actionEvent(log, "card1").data.status, ACTION_STATUS.DELETED);
  const computed = stats(log);
  assert.equal(computed.summary.openActions, 0);
  assert.equal(row(computed, "c-hero").damageRolled, 0);
});

test("the initiative report is not credited to anybody", async () => {
  const { service, log } = fixture();
  await service.chatMessageCreated({
    id: "init",
    speaker: { scene: "s", token: "heroToken", actor: "hero" },
    rolls: [{ class: "InitiativeCheck", formula: "3d8", total: 14 }, { class: "InitiativeCheck", formula: "3d8", total: 9 }],
    flags: { crucible: { isInitiativeReport: true }, core: { initiativeRoll: true } }
  });
  assert.equal(log.events.some((event) => String(event.type).startsWith("roll.")), false);
  assert.equal(log.events.some((event) => event.type === EVENT_TYPES.ACTION_USED), false);
});

test("Crucible states are automatic effects and staggered counts as control", async () => {
  const { service, log, orc, combat } = fixture();
  combat.combatant = { id: "c-hero" };
  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "weakened", parent: orc, name: "Weakened", statuses: new Set(["weakened"]) }, {});
  await service.activeEffectChanged(EVENT_TYPES.ACTIVE_EFFECT_CREATED, { id: "staggered", parent: orc, name: "Staggered", origin: "", statuses: new Set(["staggered"]) }, {});
  const [weakened, staggered] = log.events;
  assert.equal(weakened.data.automatic, true);
  assert.equal(weakened.data.control, false);
  assert.equal(staggered.data.automatic, false);
  assert.equal(staggered.data.control, true);
  assert.equal(row(stats(log), "c-hero").control, 1);
});

test("a match is probable until the card's confirmation makes it safe", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -5 }));
  await changeResources(service, orc, { health: 7 });
  assert.equal(deltas(log)[0].confidence, CONFIDENCE.PROBABLE);
  assert.equal(deltas(log)[0].data.sourceCombatantId, "c-hero");
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: true } } });
  assert.equal(deltas(log)[0].confidence, CONFIDENCE.SAFE);
});

test("a change that only looked like an open card loses the card when the card is confirmed later", async () => {
  const { service, log, orc } = fixture();
  await service.chatMessageCreated(strikeCard("card1", { health: -5 }));
  // A trap deals the same 5 damage while the card is still open.
  await changeResources(service, orc, { health: 7 });
  const trap = deltas(log)[0];
  trap.createdAt = new Date(Date.now() - 60000).toISOString();
  assert.equal(trap.data.sourceCombatantId, "c-hero");

  // Much later the GM confirms the card.
  await changeResources(service, orc, { health: 2 });
  await service.chatMessageUpdated({ id: "card1" }, { flags: { crucible: { confirmed: true } } });
  const strike = deltas(log)[1];
  assert.equal(trap.data.attribution, undefined);
  assert.equal(trap.combatantId, "c-orc");
  assert.equal(trap.data.correlation.status, "uncorrelated");
  assert.equal(strike.data.sourceCombatantId, "c-hero");
  assert.equal(strike.confidence, CONFIDENCE.SAFE);
  assert.deepEqual(actionEvent(log, "card1").data.outcomes[0].deltaEventIds, [strike.id]);
  const computed = stats(log);
  assert.equal(row(computed, "c-hero").damageAppliedNet, 5);
  assert.equal(row(computed, "c-orc").damageTakenNet, 10);
});

test("a confirmed card finds a change that a status cut short", async () => {
  const { service, log, hero } = fixture();
  // Aria heals herself for 6, but only 2 health were missing: the change is cut short at the maximum.
  const card = strikeCard("heal", { health: 6, target: "Actor.hero" });
  card.flags.crucible.action = { id: "spell.life.touch.none", name: "Mend", tags: ["spell"] };
  hero.system.resources.health.value = 18;
  await service.chatMessageCreated(card);
  await changeResources(service, hero, { health: 20 });
  assert.equal(deltas(log)[0].data.attribution, undefined);
  await service.chatMessageUpdated({ id: "heal" }, { flags: { crucible: { confirmed: true } } });
  const [heal] = deltas(log);
  assert.equal(heal.data.sourceCombatantId, "c-hero");
  assert.equal(heal.confidence, CONFIDENCE.PROBABLE);
  assert.equal(heal.data.actionName, "Mend");
});

test("a change while nobody recorded that runs from health into wounds is one offline change of the pool", async () => {
  const service = new CombatLogService();
  const actor = crucibleActor({ id: "hero", uuid: "Actor.hero", health: 54, wounds: 0 });
  const log = { id: "log", participants: [{ combatantId: "c-hero", actorUuid: "Actor.hero", name: "Hero" }], events: [], latestSnapshots: { "c-hero": service.adapter.snapshotResources(actor, service.adapter.getResourcePaths()) } };
  actor.system.resources.health.value = 0;
  actor.system.resources.wounds.value = 5;
  await service.detectOfflineDeltas(log, { id: "combat", round: 2, turn: 0, combatants: [{ id: "c-hero", actor }] });
  const offline = log.events.filter((event) => event.type === EVENT_TYPES.RESOURCE_DELTA_OFFLINE);
  assert.equal(offline.length, 1);
  assert.equal(offline[0].data.delta, -59);
  assert.equal(offline[0].data.pool, "health");
  assert.deepEqual(offline[0].data.parts, { health: -54, wounds: 5 });
  assert.equal(offline[0].confidence, CONFIDENCE.UNCLEAR);
  assert.equal(offline[0].data.interpretedAs, RESOURCE_INTERPRETATIONS.UNKNOWN);
});
