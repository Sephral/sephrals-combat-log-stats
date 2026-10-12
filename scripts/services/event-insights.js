import { EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../constants.js";

// Shared reading of combat log events for the stats, the log window, player reports and exports.
// Events written since 1.0 carry structured fields (actionName, actionKind, control, targetDowned,
// sourceCombatantId, targetCombatantId). Older logs fall back to name matching.

// Conditions one combatant imposes on another. Automatic states such as bloodied, dead or
// concentrating are no control plays.
export const CONTROL_STATUSES = Object.freeze([
  "blinded", "charmed", "deafened", "frightened", "grappled", "incapacitated", "paralyzed", "petrified",
  "poisoned", "prone", "restrained", "stunned", "silenced", "sleeping", "unconscious", "slowed", "dazed", "cursed"
]);

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
