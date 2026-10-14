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
    // Item cards hold several rolls (midi-qol puts attack and damage into one card), so the roll's own type comes first.
    const rollType = String(roll?.options?.rollType ?? flags.roll?.type ?? midiRollType(roll) ?? "");
    // dnd5e rolls healing as a DamageRoll of the type healing or temphp.
    if (rollType === "damage" && HEALING_TYPES.has(String(roll?.options?.type ?? ""))) return { type: EVENT_TYPES.ROLL_HEALING, confidence: CONFIDENCE.SAFE };
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

  // The tray and Actor5e#applyDamage of dnd5e 5.3 pass the damage roll message as options.originatingMessage (5.2 does
  // not). midi-qol applies its damage without a message, but names the attacker in options.midi.sourceActorUuid.
  // The expected hit points let the service skip applications that changed nothing (0 damage after immunity).
  registerSystemHooks(service) {
    globalThis.Hooks?.on?.("dnd5e.preApplyDamage", (actor, amount, updates, options = {}) => {
      const hp = actor?.system?.attributes?.hp ?? {};
      const expected = { value: numberOrUndefined(updates?.["system.attributes.hp.value"]), temp: numberOrUndefined(updates?.["system.attributes.hp.temp"]) };
      const change = { value: [Number(hp.value), expected.value], temp: [Number(hp.temp), expected.temp] };
      const midi = midiApplication(actor, change, options, Number(amount) || 0);
      service?.noteSystemApplication?.(actor, {
        amount: Number(amount) || 0,
        message: options?.originatingMessage ?? midiCardOf(midi.sourceActorUuid),
        sourceActorUuid: midi.sourceActorUuid,
        reversal: midi.reversal,
        expected,
        options
      });
    });
  }

  // An update that no hook announced on the recording GM's screen: midi-qol may apply damage on another GM's client
  // or a player may click its damage card. The update options carry midi-qol's options to every client.
  describeUpdateApplication(actor, before, after, options = {}) {
    if (!options?.midi) return null;
    const hp = (snapshot) => snapshot?.system?.attributes?.hp ?? {};
    const change = { value: [Number(hp(before).value), Number(hp(after).value)], temp: [Number(hp(before).temp), Number(hp(after).temp)] };
    const amount = ((change.value[0] || 0) + (change.temp[0] || 0)) - ((change.value[1] || 0) + (change.temp[1] || 0));
    const midi = midiApplication(actor, change, options, amount);
    if (!midi.sourceActorUuid && !midi.reversal) return null;
    return { amount, messageId: "", message: midiCardOf(midi.sourceActorUuid), sourceActorUuid: midi.sourceActorUuid, reversal: midi.reversal };
  }

  // With gmAttackDamageCards midi-qol posts a GM copy of rolls that are also in its item card.
  skipRolls(message) {
    return Boolean(message?.flags?.["midi-qol"]?.gmHide);
  }

  // midi-qol re-creates a finished item card from its data when damage is rolled again: same timestamp and speaker,
  // new id, the old rolls included. Their rolls belong to the first card.
  findCopiedCard(message) {
    if (!message?.flags?.["midi-qol"] || !message.timestamp) return null;
    const twin = Array.from(globalThis.game?.messages?.contents ?? []).find((other) => other?.id !== message.id && other?.flags?.["midi-qol"]
      && other.timestamp === message.timestamp && other.speaker?.actor === message.speaker?.actor && other.speaker?.token === message.speaker?.token);
    return twin?.id ?? null;
  }
}

const HEALING_TYPES = new Set(["healing", "temphp"]);

function numberOrUndefined(value) {
  return value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value);
}

// midi-qol marks its rolls with defaultDamage, otherDamage or bonusDamage, and formula rolls with utility.
function midiRollType(roll) {
  const type = String(roll?.options?.["midi-qol"]?.rollType ?? "");
  if (/damage/i.test(type)) return "damage";
  if (type === "utility") return "generic";
  return type || null;
}

// The attacker of a midi-qol application, and whether it undoes an earlier one.
// * A workflow names the attacker in options.midi.sourceActorUuid. applyTokenDamage and overtime effects may name the
//   damaged actor itself; that is no attacker (self healing is).
// * The buttons of midi-qol's damage card (apply, undo) may pass stored options without the attacker; the card names
//   it in flags.midi-qol.actorUuid and keeps the hit points before and after each target's change.
// * A change from a card's "after" back to its "before" is an undo. Any recent card counts, and temporary hit points
//   must fit as well when the card knows them.
// change: { value: [before, after], temp: [before, after] }
function midiApplication(actor, change, options, amount = 0) {
  const midi = options?.midi;
  if (!midi) return { sourceActorUuid: "", reversal: false };
  let sourceActorUuid = String(midi.sourceActorUuid ?? "");
  if (sourceActorUuid && sourceActorUuid === actor?.uuid && amount > 0) sourceActorUuid = "";
  const entryOf = (message) => {
    const list = message?.flags?.["midi-qol"]?.undoDamage;
    return Array.isArray(list) ? list.find((entry) => entry?.actorUuid === actor?.uuid) ?? null : null;
  };
  const cards = findMidiCards((message) => Boolean(entryOf(message)));
  const same = (expected, value) => Number.isFinite(value) && Number(expected) === value;
  const loose = (expected, value) => expected === undefined || expected === null || !Number.isFinite(value) || Number(expected) === value;
  const undone = cards.find((card) => {
    const entry = entryOf(card);
    const moved = Number(entry.oldHP) !== Number(entry.newHP) || Number(entry.oldTempHP ?? 0) !== Number(entry.newTempHP ?? 0);
    return moved && same(entry.oldHP, change.value[1]) && same(entry.newHP, change.value[0])
      && loose(entry.oldTempHP, change.temp[1]) && loose(entry.newTempHP, change.temp[0]);
  });
  const card = undone ?? cards[0] ?? null;
  const cardSource = String(card?.flags?.["midi-qol"]?.actorUuid ?? "");
  return { sourceActorUuid: sourceActorUuid || (cardSource !== actor?.uuid || amount <= 0 ? cardSource : ""), reversal: Boolean(undone) };
}

// The last chat messages of midi-qol that fit, newest first.
function findMidiCards(test, limit = 40) {
  const messages = Array.from(globalThis.game?.messages?.contents ?? []).slice(-limit).reverse();
  return messages.filter((message) => message?.flags?.["midi-qol"] && test(message));
}

// The newest item card of the attacker, for the action name and the roll of an application.
function midiCardOf(sourceActorUuid) {
  if (!sourceActorUuid) return null;
  return findMidiCards((message) => message.flags["midi-qol"].sourceActorUuid === sourceActorUuid && Array.from(message.rolls ?? []).length > 0)[0] ?? null;
}

export const __test__ = { midiApplication, midiRollType };

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
