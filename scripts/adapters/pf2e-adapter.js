import { CONFIDENCE, EVENT_TYPES } from "../constants.js";
import { ACTION_KINDS } from "../services/event-insights.js";
import { GenericSystemAdapter, rollFlag } from "./generic-adapter.js";

// Pathfinder 2e writes what a roll is to flags.pf2e.context.type (attack-roll, spell-attack-roll, saving-throw,
// skill-check, perception-check, flat-check, damage-roll, ...), the degree of success to context.outcome and the
// item behind it to flags.pf2e.origin ({ type, uuid }). Applied damage and healing come as "damage-taken" cards
// ("Goblin takes 6 damage.", "Valeros is healed for 4 damage.") next to the hit point change itself.
const CONTEXT_TYPES = Object.freeze({
  "attack-roll": EVENT_TYPES.ROLL_ATTACK,
  "spell-attack-roll": EVENT_TYPES.ROLL_ATTACK,
  "saving-throw": EVENT_TYPES.ROLL_SAVE,
  "damage-roll": EVENT_TYPES.ROLL_DAMAGE,
  "skill-check": EVENT_TYPES.ROLL_CHECK,
  "perception-check": EVENT_TYPES.ROLL_CHECK,
  "flat-check": EVENT_TYPES.ROLL_CHECK,
  "counteract-check": EVENT_TYPES.ROLL_CHECK,
  "initiative": EVENT_TYPES.ROLL_OTHER
});

export class Pf2eSystemAdapter extends GenericSystemAdapter {
  id = "pf2e";

  classifyRoll(roll, message) {
    const context = contextOf(message);
    const type = CONTEXT_TYPES[String(context.type ?? "")];
    if (type === EVENT_TYPES.ROLL_DAMAGE && isHealingRoll(roll, message)) return { type: EVENT_TYPES.ROLL_HEALING, confidence: CONFIDENCE.SAFE };
    if (type) return { type, confidence: CONFIDENCE.SAFE };
    return super.classifyRoll(roll, message);
  }

  extractRollData(roll, message = null, classification = null) {
    const data = super.extractRollData(roll, message, classification);
    const type = (classification ?? this.classifyRoll(roll, message))?.type;
    if (type !== EVENT_TYPES.ROLL_ATTACK) return { ...data, isCritical: false, isFumble: false };
    // The degree of success decides (a natural 1 only lowers it by a step): critical success and critical failure.
    const outcome = String(contextOf(message).outcome ?? "");
    const degree = Number(rollFlag(roll, "degreeOfSuccess"));
    if (outcome) return { ...data, isCritical: outcome === "criticalSuccess", isFumble: outcome === "criticalFailure" };
    if (Number.isFinite(degree)) return { ...data, isCritical: degree === 3, isFumble: degree === 0 };
    return data;
  }

  // A saving throw or a check is made by the one it is about: it names no target (the origin of a spell save is the caster).
  // Without this the roll of the saving creature would be taken for the cause of the damage it takes next.
  extractMessageTargets(message) {
    const type = CONTEXT_TYPES[String(contextOf(message).type ?? "")];
    if (type === EVENT_TYPES.ROLL_SAVE || type === EVENT_TYPES.ROLL_CHECK) return { actorUuids: [], tokenUuids: [], names: [] };
    return super.extractMessageTargets(message);
  }

  // The item behind a card: its name from the origin item, else the card title without its "Melee Strike:" prefix.
  describeAction(message) {
    const pf2e = message?.flags?.pf2e ?? {};
    const origin = pf2e.origin ?? {};
    let item = null;
    try {
      item = origin.uuid && globalThis.fromUuidSync ? globalThis.fromUuidSync(origin.uuid) : null;
    } catch {
      item = null;
    }
    const title = String(contextOf(message).title ?? "").replace(/^[^:]{2,30}:\s*/, "").trim();
    const actionName = String(item?.name ?? title ?? "").trim() || super.describeAction(message).actionName;
    const identifier = String(contextOf(message).identifier ?? "");
    const kind = origin.type === "spell" || contextOf(message).type === "spell-attack-roll" ? ACTION_KINDS.SPELL
      : /\.melee$/.test(identifier) ? ACTION_KINDS.MELEE
        : /\.ranged$/.test(identifier) ? ACTION_KINDS.RANGED
          : ["weapon", "melee"].includes(String(item?.type ?? origin.type ?? "")) ? (item?.isRanged ? ACTION_KINDS.RANGED : ACTION_KINDS.MELEE) : ACTION_KINDS.OTHER;
    return { actionName, actionKind: kind, itemUuid: String(origin.uuid ?? ""), itemType: String(origin.type ?? "") };
  }

  // The damage and healing cards of pf2e ("damage-taken") carry what they applied in flags.pf2e.appliedDamage: the
  // target's UUID, whether it was healing and the hit point change (a positive number is damage, in healing a negative
  // one). The card text is translated, so it is only read where a card has no such flag.
  extractChatApplications(message) {
    const applied = message?.flags?.pf2e?.appliedDamage;
    if (!applied || typeof applied !== "object") return super.extractChatApplications(message);
    const change = (Array.isArray(applied.updates) ? applied.updates : []).find((update) => update?.path === "system.attributes.hp.value");
    const amount = Math.abs(Number(change?.value) || 0);
    if (!amount) return [];
    const name = /class="target-name"[^>]*>([^<]{1,80})</.exec(String(message?.content ?? ""))?.[1]?.trim() ?? "";
    return [{
      type: applied.isHealing ? EVENT_TYPES.HEALING_APPLIED : EVENT_TYPES.DAMAGE_APPLIED,
      amount,
      confidence: CONFIDENCE.SAFE,
      targetActorUuid: String(applied.uuid ?? ""),
      targetName: name,
      reason: "pf2eAppliedDamage"
    }];
  }
}

function contextOf(message) {
  return message?.flags?.pf2e?.context ?? {};
}

// pf2e rolls healing as a damage roll with the damage kind healing.
function isHealingRoll(roll, message) {
  const kind = roll?.options?.damage?.damage?.kind ?? roll?.options?.kind ?? roll?.kind;
  if (kind === "healing") return true;
  return /\bhealing\b/i.test(String(roll?.options?.damageType ?? "")) || (Array.isArray(contextOf(message).options) && contextOf(message).options.includes("healing"));
}

export const __test__ = { CONTEXT_TYPES, isHealingRoll };
