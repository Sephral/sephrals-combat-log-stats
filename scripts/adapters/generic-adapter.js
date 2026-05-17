import { CONFIDENCE, EVENT_TYPES, RESOURCE_INTERPRETATIONS } from "../constants.js";
import { getProperty, numberOrNull } from "../utils.js";

export class GenericSystemAdapter {
  id = "generic";

  getResourcePaths() {
    return ["system.attributes.hp.value", "system.attributes.hp.temp", "system.attributes.hp.tempmax", "system.attributes.hp.max"];
  }

  snapshotResources(actor, resourcePaths = this.getResourcePaths()) {
    const resources = {};
    for (const path of resourcePaths) resources[path] = getProperty(actor, path);
    return resources;
  }

  detectResourceDeltas(before, after, resourcePaths = this.getResourcePaths()) {
    const deltas = [];
    for (const path of resourcePaths) {
      const oldValue = numberOrNull(getProperty(before, path));
      const newValue = numberOrNull(getProperty(after, path));
      if (oldValue === null || newValue === null || oldValue === newValue) continue;
      const delta = newValue - oldValue;
      deltas.push({
        resourcePath: path,
        oldValue,
        newValue,
        delta,
        interpretedAs: this.interpretResourceDelta(path, delta),
        confidence: this.confidenceForResourceDelta(path),
        manualCorrection: false,
        notes: ""
      });
    }
    return deltas;
  }

  interpretResourceDelta(path, delta) {
    if (path.includes("tempmax") || path.endsWith(".max")) return RESOURCE_INTERPRETATIONS.MAX_HP_CHANGE;
    if (path.includes(".temp")) return delta >= 0 ? RESOURCE_INTERPRETATIONS.TEMP_HP_GAIN : RESOURCE_INTERPRETATIONS.TEMP_HP_LOSS;
    if (delta < 0) return RESOURCE_INTERPRETATIONS.DAMAGE;
    if (delta > 0) return RESOURCE_INTERPRETATIONS.HEALING;
    return RESOURCE_INTERPRETATIONS.UNKNOWN;
  }

  confidenceForResourceDelta(path) {
    if (path.includes("hp.value") || path.endsWith(".value")) return CONFIDENCE.PROBABLE;
    if (path.includes("hp.temp") || path.includes("hp.max")) return CONFIDENCE.PROBABLE;
    return CONFIDENCE.UNCLEAR;
  }

  classifyRoll(roll, message) {
    const flavor = String(message?.flavor ?? message?.content ?? "").toLowerCase();
    const formula = String(roll?.formula ?? "").toLowerCase();
    if (/heal|healing|cure/.test(flavor)) return { type: EVENT_TYPES.ROLL_HEALING, confidence: CONFIDENCE.PROBABLE };
    if (/damage|dmg/.test(flavor) || /\d+d\d+/.test(formula)) return { type: EVENT_TYPES.ROLL_DAMAGE, confidence: CONFIDENCE.UNCLEAR };
    if (/attack|hit/.test(flavor)) return { type: EVENT_TYPES.ROLL_ATTACK, confidence: CONFIDENCE.UNCLEAR };
    if (/save|saving throw/.test(flavor)) return { type: EVENT_TYPES.ROLL_SAVE, confidence: CONFIDENCE.UNCLEAR };
    if (/check|skill|ability/.test(flavor)) return { type: EVENT_TYPES.ROLL_CHECK, confidence: CONFIDENCE.UNCLEAR };
    return { type: EVENT_TYPES.ROLL_OTHER, confidence: CONFIDENCE.UNCLEAR };
  }

  extractRollData(roll, message = null) {
    const targets = this.extractMessageTargets(message);
    return {
      formula: String(roll?.formula ?? ""),
      total: numberOrNull(roll?.total),
      dice: Array.from(roll?.dice ?? []).map((die) => ({ faces: die.faces, results: (die.results ?? []).map((result) => result.result) })),
      targetActorUuids: targets.actorUuids,
      targetTokenUuids: targets.tokenUuids,
      targetNames: targets.names
    };
  }

  extractMessageTargets(message) {
    const targets = { actorUuids: new Set(), tokenUuids: new Set(), names: new Set() };
    collectTargetsFromValue(message?.flags ?? {}, targets, "flags");
    collectTargetsFromValue(message?.speaker ?? {}, targets, "speaker");
    return {
      actorUuids: Array.from(targets.actorUuids),
      tokenUuids: Array.from(targets.tokenUuids),
      names: Array.from(targets.names)
    };
  }

  extractChatApplications(message) {
    const applications = [];
    const text = messageText(message);
    for (const match of text.matchAll(/\b(.{2,80}?)\s+(?:takes|took|suffers|suffered)\s+(\d+)\s+(?:points?\s+of\s+)?damage\b/gi)) {
      applications.push(chatApplication(EVENT_TYPES.DAMAGE_APPLIED, Number(match[2]), { targetName: cleanupName(match[1]), reason: "textTakesDamage" }));
    }
    for (const match of text.matchAll(/\b(\d+)\s+(?:points?\s+of\s+)?damage\s+(?:applied|dealt)\s+to\s+(.{2,80}?)(?:[.;,]|$)/gi)) {
      applications.push(chatApplication(EVENT_TYPES.DAMAGE_APPLIED, Number(match[1]), { targetName: cleanupName(match[2]), reason: "textAppliedDamage" }));
    }
    for (const match of text.matchAll(/\b(.{2,80}?)\s+(?:heals|healed|regains|regained)\s+(\d+)\s+(?:hit\s+points?|hp|healing)?\b/gi)) {
      applications.push(chatApplication(EVENT_TYPES.HEALING_APPLIED, Number(match[2]), { targetName: cleanupName(match[1]), reason: "textHealing" }));
    }
    for (const match of text.matchAll(/\b(\d+)\s+(?:points?\s+of\s+)?(?:healing|hit\s+points?|hp)\s+(?:applied|restored)\s+to\s+(.{2,80}?)(?:[.;,]|$)/gi)) {
      applications.push(chatApplication(EVENT_TYPES.HEALING_APPLIED, Number(match[1]), { targetName: cleanupName(match[2]), reason: "textAppliedHealing" }));
    }

    collectStructuredApplications(message?.flags ?? {}, applications);
    return dedupeApplications(applications);
  }
}

function chatApplication(type, amount, data = {}) {
  return {
    type,
    amount: Math.abs(Number(amount) || 0),
    confidence: CONFIDENCE.PROBABLE,
    ...data
  };
}

function messageText(message) {
  const html = String(message?.content ?? "");
  const flavor = String(message?.flavor ?? "");
  const primaryText = html.trim() ? html : flavor;
  return primaryText
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupName(value) {
  return String(value ?? "")
    .replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, "")
    .replace(/\b(?:target|targets|to|for|applied|damage|healing)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeApplications(applications) {
  const deduped = [];
  for (const application of applications) {
    if (!application.amount) continue;
    if (deduped.some((existing) => isSameApplication(existing, application))) continue;
    deduped.push(application);
  }
  return deduped;
}

function isSameApplication(left, right) {
  if (left.type !== right.type || Number(left.amount) !== Number(right.amount)) return false;
  const leftActor = left.targetActorUuid ?? "";
  const rightActor = right.targetActorUuid ?? "";
  if (leftActor && rightActor && leftActor === rightActor) return true;
  const leftToken = left.targetTokenUuid ?? "";
  const rightToken = right.targetTokenUuid ?? "";
  if (leftToken && rightToken && leftToken === rightToken) return true;
  const leftName = normalizeApplicationName(left.targetName);
  const rightName = normalizeApplicationName(right.targetName);
  return Boolean(leftName && rightName && leftName === rightName);
}

function normalizeApplicationName(value) {
  return cleanupName(value).toLowerCase();
}

function collectTargetsFromValue(value, targets, path = "") {
  if (!value || typeof value !== "object") {
    collectTargetPrimitive(value, targets, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTargetsFromValue(entry, targets, path);
    return;
  }
  const maybeTarget = /target|hit|save/i.test(path);
  const actorUuid = value.actorUuid ?? value.actor?.uuid ?? value.document?.actor?.uuid;
  const tokenUuid = value.tokenUuid ?? value.token?.uuid ?? value.document?.uuid;
  const uuid = value.uuid ?? value.documentUuid;
  if (maybeTarget) {
    if (typeof actorUuid === "string" && actorUuid.startsWith("Actor.")) targets.actorUuids.add(actorUuid);
    if (typeof tokenUuid === "string" && tokenUuid.includes(".Token.")) targets.tokenUuids.add(tokenUuid);
    if (typeof uuid === "string" && uuid.startsWith("Actor.")) targets.actorUuids.add(uuid);
    if (typeof uuid === "string" && uuid.includes(".Token.")) targets.tokenUuids.add(uuid);
    if (typeof value.name === "string") targets.names.add(cleanupName(value.name));
  }
  for (const [key, entry] of Object.entries(value)) collectTargetsFromValue(entry, targets, `${path}.${key}`);
}

function collectTargetPrimitive(value, targets, path) {
  if (typeof value !== "string" || !/target|hit|save/i.test(path)) return;
  for (const match of value.matchAll(/Actor\.[A-Za-z0-9]+/g)) targets.actorUuids.add(match[0]);
  for (const match of value.matchAll(/Scene\.[A-Za-z0-9]+\.Token\.[A-Za-z0-9]+/g)) targets.tokenUuids.add(match[0]);
}

function collectStructuredApplications(value, applications, path = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectStructuredApplications(entry, applications, path);
    return;
  }
  const amount = numberOrNull(value.amount ?? value.damage ?? value.healing ?? value.total ?? value.damageTotal ?? value.healingTotal);
  const pathHintsApplication = /applied|application|damageList|damageDetail/i.test(path);
  const hasTarget = value.targetActorUuid || value.targetTokenUuid || value.actorUuid || value.tokenUuid || value.targetName || value.name;
  if (amount !== null && amount !== 0 && pathHintsApplication && hasTarget) {
    const type = /heal/i.test(path) || value.healing || value.healingTotal ? EVENT_TYPES.HEALING_APPLIED : EVENT_TYPES.DAMAGE_APPLIED;
    applications.push(chatApplication(type, amount, {
      targetActorUuid: typeof value.targetActorUuid === "string" ? value.targetActorUuid : typeof value.actorUuid === "string" ? value.actorUuid : "",
      targetTokenUuid: typeof value.targetTokenUuid === "string" ? value.targetTokenUuid : typeof value.tokenUuid === "string" ? value.tokenUuid : "",
      targetName: cleanupName(value.targetName ?? value.name ?? ""),
      reason: "structuredChatApplication"
    }));
  }
  for (const [key, entry] of Object.entries(value)) collectStructuredApplications(entry, applications, `${path}.${key}`);
}
