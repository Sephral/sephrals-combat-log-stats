import { CONFIDENCE, DOWN_STATES, EVENT_TYPES, RESOURCE_INTERPRETATIONS, RESOURCE_POOLS } from "../constants.js";
import { ACTION_KINDS, AUTOMATIC_STATUSES } from "../services/event-insights.js";
import { getProperty, numberOrNull } from "../utils.js";
import { GenericSystemAdapter, rollClassNames } from "./generic-adapter.js";

// Crucible 0.11 keeps four pools that matter in a fight. Health overflows into wounds, morale into madness
// (only for heroes and important adversaries).
const PATHS = Object.freeze({
  health: "system.resources.health.value",
  wounds: "system.resources.wounds.value",
  morale: "system.resources.morale.value",
  madness: "system.resources.madness.value"
});

// Each pool is read as one change: the active value falls, the reserve rises. 3 health and 4 wounds are 7 damage.
const POOLS = Object.freeze([
  { pool: RESOURCE_POOLS.HEALTH, active: "health", reserve: "wounds" },
  { pool: RESOURCE_POOLS.MORALE, active: "morale", reserve: "madness" }
]);

const TRACKED_RESOURCES = Object.freeze(Object.keys(PATHS));

// Conditions an action puts on another combatant. Buffs (hastened, resolute, guarded, mending) and
// damage over time (bleeding, burning) are no control plays.
const CONTROL_STATUSES = Object.freeze([
  "staggered", "stunned", "prone", "restrained", "slowed", "disoriented", "exhausted", "blinded", "deafened",
  "silenced", "frightened", "exposed", "hexed", "overrun", "paralyzed", "asleep", "incapacitated", "confused",
  "dominated", "unaware"
]);

// Crucible toggles these after every change of the pools.
const CRUCIBLE_AUTOMATIC_STATUSES = Object.freeze([...AUTOMATIC_STATUSES, "weakened", "broken", "insane"]);

const SPELL_TAGS = new Set(["spell", "composed", "iconicSpell"]);

export class CrucibleSystemAdapter extends GenericSystemAdapter {
  id = "crucible";

  getResourcePaths() {
    return Object.values(PATHS);
  }

  // The live actor gives the reserve maximum and whether the actor uses reserves at all. Without it the
  // snapshot decides (heroes and important adversaries use reserves).
  detectResourceDeltas(before, after, resourcePaths = this.getResourcePaths(), actor = null) {
    const paths = Array.from(resourcePaths ?? []);
    const poolPaths = new Set(Object.values(PATHS));
    const deltas = [];
    const reserves = usesReserves(actor, after ?? before);
    for (const { pool, active, reserve } of POOLS) {
      if (!paths.includes(PATHS[active]) && !paths.includes(PATHS[reserve])) continue;
      const activeBefore = numberOrNull(getProperty(before, PATHS[active]));
      const activeAfter = numberOrNull(getProperty(after, PATHS[active]));
      const reserveBefore = numberOrNull(getProperty(before, PATHS[reserve]));
      const reserveAfter = numberOrNull(getProperty(after, PATHS[reserve]));
      const activeDelta = activeBefore !== null && activeAfter !== null ? activeAfter - activeBefore : 0;
      const reserveDelta = reserveBefore !== null && reserveAfter !== null ? reserveAfter - reserveBefore : 0;
      const delta = activeDelta - reserveDelta;
      if (!delta) continue;
      const reserveMax = numberOrNull(getProperty(actor, `system.resources.${reserve}.max`));
      const stateBefore = poolState(pool, activeBefore, reserveBefore, reserveMax, reserves);
      const stateAfter = poolState(pool, activeAfter, reserveAfter, reserveMax, reserves);
      deltas.push({
        resourcePath: PATHS[active],
        pool,
        oldValue: activeBefore ?? 0,
        newValue: activeAfter ?? 0,
        delta,
        parts: { [active]: activeDelta, [reserve]: reserveDelta },
        interpretedAs: delta < 0 ? RESOURCE_INTERPRETATIONS.DAMAGE : RESOURCE_INTERPRETATIONS.HEALING,
        confidence: CONFIDENCE.PROBABLE,
        manualCorrection: false,
        notes: "",
        downState: stateAfter && stateAfter !== stateBefore ? stateAfter : "",
        // Down is the first state of a pool: weakened then dead counts once, broken counts on its own.
        targetDowned: Boolean(stateAfter) && !stateBefore
      });
    }
    // Health and morale lost in one update come from one hit. The morale part does not count as a second hit.
    const health = deltas.find((delta) => delta.pool === RESOURCE_POOLS.HEALTH);
    const morale = deltas.find((delta) => delta.pool === RESOURCE_POOLS.MORALE);
    if (health && morale && Math.sign(health.delta) === Math.sign(morale.delta)) morale.secondary = true;
    const others = paths.filter((path) => !poolPaths.has(path));
    return others.length ? [...deltas, ...super.detectResourceDeltas(before, after, others)] : deltas;
  }

  classifyRoll(roll, message) {
    const flags = message?.flags?.crucible ?? {};
    const names = `${rollClassNames(roll)} ${String(roll?.class ?? "").toLowerCase()}`;
    if (flags.isInitiativeReport || /initiativecheck/.test(names)) return { type: EVENT_TYPES.ROLL_OTHER, confidence: CONFIDENCE.SAFE };
    if (/attackroll/.test(names)) return { type: EVENT_TYPES.ROLL_ATTACK, confidence: CONFIDENCE.SAFE };
    if (flags.skill || flags.groupCheck || /standardcheck|passivecheck/.test(names)) return { type: EVENT_TYPES.ROLL_CHECK, confidence: CONFIDENCE.SAFE };
    return super.classifyRoll(roll, message);
  }

  // Crucible decides critical results by the margin over the difficulty, not by a natural die.
  extractRollData(roll, message = null, classification = null) {
    const data = super.extractRollData(roll, message, classification);
    const type = (classification ?? this.classifyRoll(roll, message))?.type;
    const tested = [EVENT_TYPES.ROLL_ATTACK, EVENT_TYPES.ROLL_CHECK, EVENT_TYPES.ROLL_SAVE].includes(type);
    const damageType = roll?.data?.damage?.type ?? roll?.data?.damageType;
    return {
      ...data,
      isCritical: tested && roll?.isCriticalSuccess === true,
      isFumble: tested && roll?.isCriticalFailure === true,
      damageTypes: damageType ? [String(damageType)] : []
    };
  }

  // Name and kind of the action behind an action card. Skill checks and other cards fall back to the flavor.
  describeAction(message) {
    const flags = message?.flags?.crucible ?? {};
    const action = flags.action;
    if (!action || typeof action !== "object") return super.describeAction(message);
    const name = String(action.name ?? "").trim();
    return {
      actionName: name || super.describeAction(message).actionName,
      actionKind: actionKindFor(action),
      actionId: String(action.id ?? ""),
      itemUuid: typeof flags.item === "string" ? flags.item : ""
    };
  }

  extractMessageTargets(message) {
    const targets = message?.flags?.crucible?.targets;
    if (!Array.isArray(targets)) return super.extractMessageTargets(message);
    const actorUuids = new Set();
    const tokenUuids = new Set();
    for (const target of targets) {
      if (typeof target?.actor === "string" && target.actor) actorUuids.add(target.actor);
      const token = typeof target?.token === "string" && target.token ? target.token : tokenUuidFromActorUuid(target?.actor);
      if (token) tokenUuids.add(token);
    }
    return { actorUuids: Array.from(actorUuids), tokenUuids: Array.from(tokenUuids), names: [] };
  }

  // Crucible changes pools only through confirmed action cards, never through chat text.
  extractChatApplications() {
    return [];
  }

  // The initiative report holds the rolls of every combatant under the GM's name. Turn summaries roll nothing.
  skipRolls(message) {
    const flags = message?.flags?.crucible ?? {};
    return Boolean(flags.isInitiativeReport || flags.isTurnChangeSummary);
  }

  // What an action card will do once the GM confirms it, per target: the realized deltas Crucible stored in
  // flags.crucible.events (crucible/module/models/action.mjs, #serializeEvents). Negated events do nothing.
  extractPlannedAction(message) {
    const flags = message?.flags?.crucible ?? {};
    if (!flags.action || !Array.isArray(flags.events)) return null;
    const rolls = Array.from(message?.rolls ?? []);
    const byTarget = new Map();
    for (const event of flags.events) {
      if (!event || event.negated || typeof event.target !== "string" || !event.target) continue;
      const entry = byTarget.get(event.target) ?? {
        targetActorUuid: event.target,
        targetTokenUuid: tokenUuidFromActorUuid(event.target),
        resources: {},
        statuses: new Set(),
        damageTypes: new Set(),
        isCritical: false,
        isFumble: false
      };
      for (const change of event.resources ?? []) {
        const resource = String(change?.resource ?? "");
        const delta = Number(change?.delta) || 0;
        if (!TRACKED_RESOURCES.includes(resource) || !delta) continue;
        entry.resources[resource] = (entry.resources[resource] ?? 0) + delta;
        if (change.damageType && !change.restoration) entry.damageTypes.add(String(change.damageType));
      }
      for (const effect of event.effects ?? []) {
        if (effect?._action === "delete") continue;
        for (const status of effect?.statuses ?? []) entry.statuses.add(String(status));
      }
      const roll = Number.isInteger(event.rollIndex) ? rolls[event.rollIndex] : null;
      if (event.isCriticalSuccess || roll?.isCriticalSuccess === true) entry.isCritical = true;
      if (event.isCriticalFailure || roll?.isCriticalFailure === true) entry.isFumble = true;
      byTarget.set(event.target, entry);
    }
    const outcomes = Array.from(byTarget.values()).map((entry) => ({
      targetActorUuid: entry.targetActorUuid,
      targetTokenUuid: entry.targetTokenUuid,
      resources: entry.resources,
      pools: poolDeltas(entry.resources),
      statuses: Array.from(entry.statuses),
      damageTypes: Array.from(entry.damageTypes),
      isCritical: entry.isCritical,
      isFumble: entry.isFumble
    }));
    return {
      ...this.describeAction(message),
      actorUuid: typeof flags.actor === "string" ? flags.actor : "",
      tokenUuid: typeof flags.token === "string" ? flags.token : "",
      confirmed: flags.confirmed === true,
      outcomes
    };
  }

  // true when an update confirmed an action card, false when the GM reversed it, null for other updates.
  readConfirmation(_message, changed = {}) {
    const value = getProperty(changed, "flags.crucible.confirmed");
    return typeof value === "boolean" ? value : null;
  }

  controlStatuses() {
    return CONTROL_STATUSES;
  }

  automaticStatuses() {
    return CRUCIBLE_AUTOMATIC_STATUSES;
  }
}

// Pool changes of a set of resource deltas, without empty pools: {health: -7, morale: -2}.
export function poolDeltas(resources = {}) {
  const pools = {};
  for (const { pool, active, reserve } of POOLS) {
    const delta = (Number(resources[active]) || 0) - (Number(resources[reserve]) || 0);
    if (delta) pools[pool] = delta;
  }
  return pools;
}

function usesReserves(actor, snapshot) {
  if (typeof actor?.system?.usesReserveResources === "boolean") return actor.system.usesReserveResources;
  const type = actor?.type ?? snapshot?.type;
  return type === "hero" || Boolean(getProperty(actor ?? snapshot, "system.advancement.important"));
}

// The state of one pool (crucible/module/models/actor-base.mjs: isWeakened, isDead, isBroken, isInsane).
function poolState(pool, active, reserve, reserveMax, reserves) {
  if (active === null) return "";
  if (pool === RESOURCE_POOLS.HEALTH) {
    if (reserves) {
      if (reserveMax > 0 && reserve !== null && reserve >= reserveMax) return DOWN_STATES.DEAD;
      return active <= 0 ? DOWN_STATES.WEAKENED : "";
    }
    return active <= 0 ? DOWN_STATES.DEAD : "";
  }
  if (reserves && reserveMax > 0 && reserve !== null && reserve >= reserveMax) return DOWN_STATES.INSANE;
  return active <= 0 ? DOWN_STATES.BROKEN : "";
}

function actionKindFor(action) {
  const tags = new Set(Array.isArray(action?.tags) ? action.tags.map(String) : []);
  if (String(action?.id ?? "").startsWith("spell.") || Array.from(tags).some((tag) => SPELL_TAGS.has(tag))) return ACTION_KINDS.SPELL;
  const category = String(action?.range?.category ?? "");
  if (category === "ranged" || tags.has("ranged")) return ACTION_KINDS.RANGED;
  if (category === "melee" || tags.has("melee")) return ACTION_KINDS.MELEE;
  return ACTION_KINDS.OTHER;
}

// Unlinked tokens have synthetic actors: "Scene.a.Token.b.Actor.c" belongs to the token "Scene.a.Token.b".
function tokenUuidFromActorUuid(uuid) {
  const match = /^(Scene\.[^.]+\.Token\.[^.]+)\.Actor\./.exec(String(uuid ?? ""));
  return match ? match[1] : "";
}

export const __test__ = { poolState, actionKindFor, tokenUuidFromActorUuid, usesReserves };
