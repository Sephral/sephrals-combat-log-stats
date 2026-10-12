import { CONFIDENCE, EVENT_TYPES } from "../constants.js";
import { ACTION_KINDS } from "../services/event-insights.js";
import { GenericSystemAdapter } from "./generic-adapter.js";

// dnd5e 5.x writes the roll type to flags.dnd5e.roll.type (attack, damage, healing, save, ability,
// skill, tool, death, hitDie, generic) and the source item and activity to flags.dnd5e.item/activity.
const ROLL_TYPES = Object.freeze({
  attack: EVENT_TYPES.ROLL_ATTACK,
  damage: EVENT_TYPES.ROLL_DAMAGE,
  healing: EVENT_TYPES.ROLL_HEALING,
  save: EVENT_TYPES.ROLL_SAVE,
  death: EVENT_TYPES.ROLL_SAVE,
  ability: EVENT_TYPES.ROLL_CHECK,
  skill: EVENT_TYPES.ROLL_CHECK,
  tool: EVENT_TYPES.ROLL_CHECK,
  hitDie: EVENT_TYPES.ROLL_OTHER,
  generic: EVENT_TYPES.ROLL_OTHER
});

export class Dnd5eSystemAdapter extends GenericSystemAdapter {
  id = "dnd5e";

  getResourcePaths() {
    return [
      "system.attributes.hp.value",
      "system.attributes.hp.temp",
      "system.attributes.hp.tempmax",
      "system.attributes.hp.max"
    ];
  }

  classifyRoll(roll, message) {
    const flags = message?.flags?.dnd5e ?? {};
    const rollType = String(flags.roll?.type ?? roll?.options?.rollType ?? "");
    if (ROLL_TYPES[rollType]) return { type: ROLL_TYPES[rollType], confidence: CONFIDENCE.SAFE };
    if (/initiative/i.test(String(message?.flavor ?? "")) || flags.core?.initiativeRoll || message?.flags?.core?.initiativeRoll) {
      return { type: EVENT_TYPES.ROLL_OTHER, confidence: CONFIDENCE.SAFE };
    }
    return super.classifyRoll(roll, message);
  }

  extractRollData(roll, message = null, classification = null) {
    const data = super.extractRollData(roll, message, classification);
    const action = this.describeAction(message);
    const damageType = roll?.options?.type;
    return {
      ...data,
      ...action,
      isCritical: Boolean(roll?.isCritical),
      isFumble: Boolean(roll?.isFumble),
      damageTypes: damageType ? [String(damageType)] : []
    };
  }

  // Name and kind (melee, ranged, spell) of the item or activity behind a dnd5e chat message.
  describeAction(message) {
    const flags = message?.flags?.dnd5e ?? {};
    const item = resolveItem(message, flags);
    const activity = resolveActivity(item, flags);
    const itemData = item ?? flags.item?.data ?? null;
    const actionName = String(itemData?.name ?? activity?.name ?? "").trim() || super.describeAction(message).actionName;
    return {
      actionName,
      actionKind: actionKindFor(itemData, activity),
      itemUuid: String(flags.item?.uuid ?? item?.uuid ?? ""),
      itemType: String(itemData?.type ?? flags.item?.type ?? ""),
      activityType: String(activity?.type ?? flags.activity?.type ?? "")
    };
  }

  // The tray and Actor5e#applyDamage pass the damage roll message as options.originatingMessage.
  registerSystemHooks(service) {
    globalThis.Hooks?.on?.("dnd5e.preApplyDamage", (actor, amount, _updates, options = {}) => {
      service?.noteSystemApplication?.(actor, {
        amount: Number(amount) || 0,
        message: options?.originatingMessage ?? null
      });
    });
  }
}

function resolveItem(message, flags) {
  const uuid = flags.item?.uuid;
  if (uuid && typeof globalThis.fromUuidSync === "function") {
    try {
      const item = globalThis.fromUuidSync(uuid);
      if (item) return item;
    } catch {
      // A missing compendium or deleted item falls back to the speaker's actor below.
    }
  }
  const actor = typeof message?.getAssociatedActor === "function" ? message.getAssociatedActor() : null;
  return flags.item?.id ? actor?.items?.get?.(flags.item.id) ?? null : null;
}

function resolveActivity(item, flags) {
  const id = flags.activity?.id;
  if (!id) return null;
  return item?.system?.activities?.get?.(id) ?? null;
}

function actionKindFor(item, activity) {
  if (item?.type === "spell") return ACTION_KINDS.SPELL;
  const attackType = activity?.attack?.type ?? {};
  if (attackType.classification === "spell") return ACTION_KINDS.SPELL;
  if (attackType.value === "ranged") return ACTION_KINDS.RANGED;
  if (attackType.value === "melee") return ACTION_KINDS.MELEE;
  const weaponType = String(item?.system?.type?.value ?? "");
  if (item?.type === "weapon") return /R$/.test(weaponType) ? ACTION_KINDS.RANGED : ACTION_KINDS.MELEE;
  if (activity?.type === "save" || activity?.type === "damage") return item?.type === "spell" ? ACTION_KINDS.SPELL : ACTION_KINDS.OTHER;
  return ACTION_KINDS.OTHER;
}
