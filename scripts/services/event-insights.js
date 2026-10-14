import { ACTION_STATUS, EVENT_TYPES, RESOURCE_INTERPRETATIONS, RESOURCE_POOLS } from "../constants.js";

// Shared reading of combat log events for the stats, the log window, player reports and exports.
// Events written since 1.0 carry structured fields (actionName, actionKind, control, targetDowned,
// sourceCombatantId, targetCombatantId). Older logs fall back to name matching.

// Conditions one combatant imposes on another. Automatic states such as bloodied, dead or
// concentrating are no control plays.
export const CONTROL_STATUSES = Object.freeze([
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "paralyzed", "petrified",
  "poisoned", "prone", "restrained", "stunned", "silenced", "sleeping", "unconscious", "slowed", "dazed", "cursed"
]);

// States the system sets on its own (dnd5e: bloodied at half hit points, dead, concentrating, encumbrance).
// They are recorded but are no action of a combatant, so the log window and the reports leave them out.
export const AUTOMATIC_STATUSES = Object.freeze([
  "bloodied", "dead", "defeated", "concentrating", "encumbered", "heavilyEncumbered", "exceedingCarryingCapacity"
]);
const LEGACY_AUTOMATIC = /^(bloodied|dead|defeated|concentrating|concentration)\b/i;

export const ACTION_KINDS = Object.freeze({ MELEE: "melee", RANGED: "ranged", SPELL: "spell", OTHER: "other" });

const ATTRIBUTED = new Set(["correlatedChatRoll", "systemApplied", "manualSource"]);
const RESOURCE_TYPES = new Set([EVENT_TYPES.RESOURCE_DELTA, EVENT_TYPES.RESOURCE_DELTA_OFFLINE]);
const EFFECT_TYPES = new Set([EVENT_TYPES.ACTIVE_EFFECT_CREATED, EVENT_TYPES.ACTIVE_EFFECT_UPDATED, EVENT_TYPES.ACTIVE_EFFECT_DELETED]);

const LEGACY_CONTROL = /control|stun|slow|prone|restrain|fear|fright|hex|pin|blind|charm|silence|web|hold|banish|paraly|grappl|incapacit|petrif/i;
const LEGACY_MAGIC = /spell|magic|fireball|bolt|shatter|cone|wave|burst|cloud|storm|spirit|sacred|radiant|necrotic|shadow|arcane|thunder|lightning|orb|missile|ray|hex|blight|guiding|burning|scorching|vitriolic|sphere|guardians/i;
const LEGACY_RANGED = /bow|crossbow|shot|arrow|bolt|ray|missile|blast|throw|thrown|sling/i;
const LEGACY_MARTIAL = /sword|slash|strike|dagger|scimitar|bite|claw|bash|slam|charge|lunge|cut|stab|rake|spear|pommel|shield|flourish|riposte|attack|weapon|axe|mace|hammer|club|whip/i;

export function eventAmount(event) {
  return Math.abs(Number(event?.data?.amount ?? event?.data?.delta ?? event?.data?.total ?? 0)) || 0;
}

export function actionName(event) {
  return String(event?.data?.actionName ?? event?.data?.itemName ?? event?.data?.spellName ?? "").trim();
}

export function isResourceDelta(event) {
  return RESOURCE_TYPES.has(event?.type);
}

export function isEffectEvent(event) {
  return EFFECT_TYPES.has(event?.type);
}

export function isSourceAttributed(event) {
  if (ATTRIBUTED.has(event?.data?.attribution)) return true;
  return Boolean(event?.data?.sourceCombatantId || event?.data?.sourceActorUuid || event?.data?.sourceTokenUuid);
}

// Combatant id of whoever caused the event, or "" when unknown.
export function sourceCombatantId(event) {
  if (isEffectEvent(event)) return String(event?.data?.sourceCombatantId ?? (event?.data?.targetCombatantId ? event?.combatantId : "") ?? "");
  if (isResourceDelta(event)) return isSourceAttributed(event) ? String(event?.combatantId ?? "") : "";
  return String(event?.combatantId ?? "");
}

// Combatant id of whoever was affected by the event, or "" when unknown.
export function targetCombatantId(event) {
  if (event?.data?.targetCombatantId) return String(event.data.targetCombatantId);
  if (isEffectEvent(event)) return String(event?.combatantId ?? "");
  if (isResourceDelta(event) && !isSourceAttributed(event)) return String(event?.combatantId ?? "");
  return "";
}

export function isDamageApplied(event) {
  if ([EVENT_TYPES.DAMAGE_APPLIED, EVENT_TYPES.DAMAGE_MANUAL_ADDED].includes(event?.type)) return true;
  return isResourceDelta(event) && event?.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE;
}

export function isDamageDealt(event) {
  if ([EVENT_TYPES.DAMAGE_APPLIED, EVENT_TYPES.DAMAGE_MANUAL_ADDED].includes(event?.type)) return Boolean(event?.combatantId);
  return isResourceDelta(event) && event?.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE && isSourceAttributed(event);
}

// Applied healing only, never healing rolls.
export function isHealingApplied(event) {
  if ([EVENT_TYPES.HEALING_APPLIED, EVENT_TYPES.HEALING_MANUAL_ADDED].includes(event?.type)) return true;
  return isResourceDelta(event) && event?.data?.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING;
}

export function isHealingGiven(event) {
  if ([EVENT_TYPES.HEALING_APPLIED, EVENT_TYPES.HEALING_MANUAL_ADDED].includes(event?.type)) return Boolean(event?.combatantId);
  return isResourceDelta(event) && event?.data?.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING && isSourceAttributed(event);
}

export function isAutomaticEffect(event) {
  if (!isEffectEvent(event)) return false;
  // Since 1.1 the system adapter decides when the effect is recorded (Crucible: weakened, broken, insane).
  if (typeof event?.data?.automatic === "boolean") return event.data.automatic;
  const statuses = Array.isArray(event?.data?.statuses) ? event.data.statuses.map(String) : [];
  if (statuses.length) return statuses.every((status) => AUTOMATIC_STATUSES.includes(status));
  return LEGACY_AUTOMATIC.test(String(event?.data?.name ?? "").trim());
}

export function isControl(event) {
  if (event?.type !== EVENT_TYPES.ACTIVE_EFFECT_CREATED) return false;
  if (typeof event?.data?.control === "boolean") return event.data.control;
  const name = `${event?.data?.name ?? ""} ${actionName(event)}`;
  return LEGACY_CONTROL.test(name) && !/bloodied|concentrat|dead/i.test(name);
}

export function actionKind(event) {
  const kind = event?.data?.actionKind;
  if (Object.values(ACTION_KINDS).includes(kind)) return kind;
  const name = actionName(event);
  if (!name) return ACTION_KINDS.OTHER;
  if (LEGACY_MAGIC.test(name)) return ACTION_KINDS.SPELL;
  if (LEGACY_RANGED.test(name)) return ACTION_KINDS.RANGED;
  if (LEGACY_MARTIAL.test(name)) return ACTION_KINDS.MELEE;
  return ACTION_KINDS.OTHER;
}

export function isMartial(event) {
  return isDamageDealt(event) && actionKind(event) === ACTION_KINDS.MELEE;
}

export function isRanged(event) {
  return isDamageDealt(event) && actionKind(event) === ACTION_KINDS.RANGED;
}

export function isMagic(event) {
  return isDamageDealt(event) && actionKind(event) === ACTION_KINDS.SPELL;
}

// A participant dropped from above 0 to 0 hit points.
export function isDowned(event) {
  // An undone action card (Crucible) takes its takedown back.
  if (event?.data?.reversed) return false;
  if (typeof event?.data?.targetDowned === "boolean") return event.data.targetDowned;
  if (!isResourceDelta(event)) return false;
  const path = String(event?.data?.resourcePath ?? "");
  if (path && !path.endsWith("hp.value")) return false;
  return event?.data?.interpretedAs === RESOURCE_INTERPRETATIONS.DAMAGE && Number(event?.data?.newValue) === 0 && Number(event?.data?.oldValue) > 0;
}

export function isCritical(event) {
  return event?.type === EVENT_TYPES.ROLL_ATTACK && Boolean(event?.data?.isCritical);
}

export function isFumble(event) {
  return event?.type === EVENT_TYPES.ROLL_ATTACK && Boolean(event?.data?.isFumble);
}

// Events that change the numbers; used to decide whether the manual classification warning applies.
export function isStatEvent(event) {
  return isResourceDelta(event) || String(event?.type ?? "").startsWith("damage.") || String(event?.type ?? "").startsWith("healing.");
}

// The pool a hit point change belongs to. Only Crucible logs know "morale" (morale and madness).
export function resourcePool(event) {
  return event?.data?.pool === RESOURCE_POOLS.MORALE ? RESOURCE_POOLS.MORALE : RESOURCE_POOLS.HEALTH;
}

export function isMoraleEvent(event) {
  return resourcePool(event) === RESOURCE_POOLS.MORALE;
}

// The state a combatant reached with this event (Crucible: weakened, dead, broken, insane), "" otherwise.
export function downState(event) {
  return String(event?.data?.downState ?? "");
}

// A Crucible action card the GM has not confirmed (yet, or again after undoing it).
export function isOpenAction(event) {
  if (event?.type !== EVENT_TYPES.ACTION_USED || event.ignored) return false;
  return [ACTION_STATUS.PENDING, ACTION_STATUS.REVERSED].includes(event?.data?.status ?? ACTION_STATUS.PENDING);
}

// Natural dice of a test as a share of the best possible result, 0 to 1. One kept d20, or a dice pool without d20
// (Crucible's 3d8). Damage dice and rolls with several d20 results (advantage stored with both dice) have none.
export function naturalRollShare(event) {
  if (![EVENT_TYPES.ROLL_ATTACK, EVENT_TYPES.ROLL_CHECK, EVENT_TYPES.ROLL_SAVE].includes(event?.type)) return null;
  const dice = Array.isArray(event?.data?.dice) ? event.data.dice : [];
  const terms = dice.map((die) => ({ faces: Number(die?.faces) || 0, results: (die?.results ?? []).map(Number).filter(Number.isFinite) })).filter((die) => die.faces > 1 && die.results.length);
  if (!terms.length) return null;
  const d20 = terms.filter((die) => die.faces === 20);
  if (d20.length) return d20.length === 1 && d20[0].results.length === 1 ? (d20[0].results[0] - 1) / 19 : null;
  let rolled = 0;
  let best = 0;
  for (const die of terms) {
    for (const result of die.results) {
      rolled += Math.max(0, result - 1);
      best += die.faces - 1;
    }
  }
  return best ? rolled / best : null;
}

// Source and affected participant of an event. Damage or healing on oneself has no separate source.
export function eventActors(event) {
  const targetId = targetCombatantId(event);
  const sourceId = sourceCombatantId(event);
  return { sourceId: sourceId && sourceId !== targetId ? sourceId : "", targetId };
}

// Each drop to 0 HP once. A hit point change that confirms a chat application belongs to that application.
// Crucible: a combatant that is already down in one pool (broken) and then drops in the other (dead) is one defeat.
export function downIncidents(events) {
  const fresh = downTracker();
  const counted = new Set(events.filter((event) => fresh(event)));
  return incidents(events, (event) => counted.has(event));
}

// Feed it every counted event in order; it answers true for a drop of a combatant that was not down yet.
// A pool that rises above 0 again is back up, so a later drop counts again (dnd5e: down, healed, down again).
export function downTracker() {
  const down = new Map();
  return (event) => {
    const targetId = targetCombatantId(event) || (isResourceDelta(event) ? String(event?.combatantId ?? "") : "");
    if (!targetId) return false;
    const pools = down.get(targetId) ?? new Set();
    if (isDowned(event)) {
      const fresh = pools.size === 0;
      pools.add(resourcePool(event));
      down.set(targetId, pools);
      return fresh;
    }
    const data = event?.data ?? {};
    if (isResourceDelta(event) && Number(data.delta) > 0 && Number(data.newValue) > 0 && !/temp|max/i.test(String(data.resourcePath ?? ""))) pools.delete(resourcePool(event));
    return false;
  };
}

// Message ids of action cards the GM undid and has not confirmed again (Crucible).
export function reversedCardMessageIds(events) {
  return new Set((events ?? []).filter((event) => event?.type === EVENT_TYPES.ACTION_USED && !event.ignored && event.data?.status === ACTION_STATUS.REVERSED).map((event) => String(event.data?.messageId ?? "")).filter(Boolean));
}

// A hit whose card was undone, or the roll and the card of an undone action: no hit, no critical, no fumble.
export function isUndone(event, reversedMessageIds = new Set()) {
  if (event?.data?.reversed) return true;
  if (!reversedMessageIds.size) return false;
  if (event?.type === EVENT_TYPES.ACTION_USED) return reversedMessageIds.has(String(event.data?.messageId ?? ""));
  return String(event?.type ?? "").startsWith("roll.") && reversedMessageIds.has(String(event?.source?.id ?? ""));
}

// Healing that brought a participant back from 0 HP (Crucible: from 0 health or 0 morale).
export function rescueIncidents(events) {
  return incidents(events, (event, original) => {
    if (!isResourceDelta(event)) return false;
    const { oldValue, newValue, resourcePath = "" } = event.data ?? {};
    if (oldValue === null || oldValue === undefined || oldValue === "" || Number(oldValue) !== 0 || !(Number(newValue) > 0)) return false;
    if (/temp|max/i.test(String(resourcePath))) return false;
    return event.data?.interpretedAs === RESOURCE_INTERPRETATIONS.HEALING || Boolean(original && isHealingApplied(original));
  });
}

function incidents(events, matches) {
  const byId = new Map(events.filter((event) => event?.id).map((event) => [event.id, event]));
  const found = new Map();
  events.forEach((event, index) => {
    const original = byId.get(event.data?.duplicateOfEventId) ?? null;
    if (!matches(event, original)) return;
    const key = original?.id ?? event.data?.duplicateOfEventId ?? event.id ?? `index-${index}`;
    if (found.has(key)) return;
    const primary = original ?? event;
    const own = eventActors(primary);
    const detected = eventActors(event);
    const targetId = own.targetId || detected.targetId;
    if (!targetId) return;
    const sourceId = own.sourceId || detected.sourceId;
    found.set(key, { event: primary, events: [primary, event], index, round: primary.round ?? event.round, targetId, sourceId: sourceId !== targetId ? sourceId : "" });
  });
  return Array.from(found.values());
}
