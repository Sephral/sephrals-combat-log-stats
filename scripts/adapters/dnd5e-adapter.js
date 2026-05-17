import { CONFIDENCE, EVENT_TYPES } from "../constants.js";
import { GenericSystemAdapter } from "./generic-adapter.js";

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
    const context = String(flags.roll?.type ?? flags.roll?.itemType ?? flags.roll?.actionType ?? "").toLowerCase();
    const flavor = String(message?.flavor ?? message?.content ?? "").toLowerCase();

    if (context.includes("damage") || flavor.includes("damage")) return { type: EVENT_TYPES.ROLL_DAMAGE, confidence: CONFIDENCE.PROBABLE };
    if (context.includes("heal") || flavor.includes("healing")) return { type: EVENT_TYPES.ROLL_HEALING, confidence: CONFIDENCE.PROBABLE };
    if (context.includes("attack") || flags.roll?.isAttack) return { type: EVENT_TYPES.ROLL_ATTACK, confidence: CONFIDENCE.PROBABLE };
    if (context.includes("save") || flavor.includes("saving throw")) return { type: EVENT_TYPES.ROLL_SAVE, confidence: CONFIDENCE.PROBABLE };
    if (context.includes("check") || context.includes("skill")) return { type: EVENT_TYPES.ROLL_CHECK, confidence: CONFIDENCE.PROBABLE };

    return super.classifyRoll(roll, message);
  }
}
