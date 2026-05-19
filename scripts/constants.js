export const MODULE_ID = "sephrals-combat-log-stats";
export const MODULE_TITLE = "Sephral’s Combat Log & Stats";
export const SCHEMA_VERSION = 1;

export const HOOKS = Object.freeze({
  LOG_UPDATED: `${MODULE_ID}.logUpdated`,
  LANGUAGE_CHANGED: `${MODULE_ID}.languageChanged`
});

export const LANGUAGE_MODES = Object.freeze({
  FOLLOW_FOUNDRY: "followFoundry",
  DE: "de",
  EN: "en"
});

export const SETTINGS = Object.freeze({
  INDEX: "combatLogIndex",
  ENABLE_AUTO_TRACKING: "enableAutoTracking",
  SHOW_SUMMARY_ON_COMBAT_END: "showSummaryOnCombatEnd",
  AUTO_RESUME_ACTIVE_COMBATS: "autoResumeActiveCombats",
  TRACK_CHAT_MESSAGES: "trackChatMessages",
  TRACK_ROLLS: "trackRolls",
  TRACK_RESOURCE_DELTAS: "trackResourceDeltas",
  TRACK_ACTIVE_EFFECTS: "trackActiveEffects",
  TRACK_TEMPLATES: "trackTemplates",
  TRACK_TOKEN_UPDATES: "trackTokenUpdates",
  RESOURCE_DELTA_WINDOW_MS: "resourceDeltaWindowMs",
  INCLUDE_UNCLEAR_DELTAS_IN_STATS: "includeUnclearDeltasInStats",
  DEFAULT_DPR_METHOD: "defaultDprMethod",
  ENABLE_PLAYER_SHARING: "enablePlayerSharing",
  DEFAULT_SHARE_MODE: "defaultShareMode",
  DEFAULT_ANONYMIZE_ENEMIES: "defaultAnonymizeEnemies",
  AUTO_POST_PLAYER_SUMMARY_ON_END: "autoPostPlayerSummaryOnEnd",
  AUTO_EXPORT_JOURNAL_ON_END: "autoExportJournalOnEnd",
  RETENTION_DAYS: "retentionDays",
  RESOURCE_PATHS: "resourcePaths",
  LANGUAGE: "language",
  DEBUG_MODE: "debugMode"
});

export const LOG_STATUS = Object.freeze({
  ACTIVE: "active",
  ENDED: "ended",
  ORPHANED: "orphaned",
  ARCHIVED: "archived",
  DELETED: "deleted"
});

export const SEGMENT_REASONS = Object.freeze({
  COMBAT_STARTED: "combatStarted",
  RESUMED_AFTER_RELOAD: "resumedAfterReload",
  SERVER_SHUTDOWN: "serverShutdown",
  BROWSER_CLOSED: "browserClosed",
  MANUAL_PAUSE: "manualPause",
  UNKNOWN: "unknown",
  COMBAT_ENDED: "combatEnded"
});

export const SIDES = Object.freeze({
  FRIENDLY: "friendly",
  HOSTILE: "hostile",
  NEUTRAL: "neutral",
  UNKNOWN: "unknown"
});

export const VISIBILITY = Object.freeze({
  GM: "gm",
  PLAYERS: "players",
  PUBLIC: "public",
  UNKNOWN: "unknown"
});

export const CONFIDENCE = Object.freeze({
  SAFE: "safe",
  PROBABLE: "probable",
  UNCLEAR: "unclear",
  MANUAL: "manual",
  UNSUPPORTED: "unsupported"
});

export const SOURCE_KINDS = Object.freeze({
  HOOK: "hook",
  CHAT_MESSAGE: "chatMessage",
  ROLL: "roll",
  ACTOR_UPDATE: "actorUpdate",
  TOKEN_UPDATE: "tokenUpdate",
  COMBAT_UPDATE: "combatUpdate",
  ACTIVE_EFFECT_UPDATE: "activeEffectUpdate",
  TEMPLATE_UPDATE: "templateUpdate",
  MANUAL: "manual",
  SYSTEM_ADAPTER: "systemAdapter",
  IMPORT: "import",
  RESUME: "resume"
});

export const EVENT_TYPES = Object.freeze({
  COMBAT_STARTED: "combat.started",
  COMBAT_RESUMED: "combat.resumed",
  COMBAT_PAUSED: "combat.paused",
  COMBAT_ENDED: "combat.ended",
  COMBAT_DELETED: "combat.deleted",
  ROUND_CHANGED: "combat.roundChanged",
  TURN_CHANGED: "combat.turnChanged",
  COMBATANT_CREATED: "combatant.created",
  COMBATANT_UPDATED: "combatant.updated",
  COMBATANT_REMOVED: "combatant.removed",
  CHAT_MESSAGE_CREATED: "chat.messageCreated",
  ROLL_CREATED: "roll.created",
  ROLL_ATTACK: "roll.attack",
  ROLL_DAMAGE: "roll.damage",
  ROLL_HEALING: "roll.healing",
  ROLL_SAVE: "roll.save",
  ROLL_CHECK: "roll.check",
  ROLL_OTHER: "roll.other",
  RESOURCE_DELTA: "resource.delta",
  RESOURCE_DELTA_OFFLINE: "resource.delta.offlineDetected",
  ACTIVE_EFFECT_CREATED: "activeEffect.created",
  ACTIVE_EFFECT_UPDATED: "activeEffect.updated",
  ACTIVE_EFFECT_DELETED: "activeEffect.deleted",
  DAMAGE_APPLIED: "damage.applied",
  DAMAGE_CORRECTED_UP: "damage.correctedUp",
  DAMAGE_CORRECTED_DOWN: "damage.correctedDown",
  DAMAGE_MANUAL_ADDED: "damage.manualAdded",
  DAMAGE_MANUAL_REDUCED: "damage.manualReduced",
  HEALING_APPLIED: "healing.applied",
  HEALING_CORRECTED_UP: "healing.correctedUp",
  HEALING_CORRECTED_DOWN: "healing.correctedDown",
  HEALING_MANUAL_ADDED: "healing.manualAdded",
  HEALING_MANUAL_REDUCED: "healing.manualReduced",
  TEMP_HP_CHANGED: "tempHp.changed",
  CONDITION_ADDED: "condition.added",
  CONDITION_REMOVED: "condition.removed",
  TOKEN_CREATED: "token.created",
  TOKEN_UPDATED: "token.updated",
  TOKEN_DELETED: "token.deleted",
  TARGET_CHANGED: "target.changed",
  TEMPLATE_CREATED: "template.created",
  TEMPLATE_DELETED: "template.deleted",
  GM_NOTE: "gm.note",
  GM_MARKER: "gm.marker",
  SHARE_CREATED: "share.created",
  SHARE_UPDATED: "share.updated",
  SHARE_REVOKED: "share.revoked",
  EXPORT_CREATED: "export.created",
  SYSTEM_WARNING: "system.warning"
});

export const RESOURCE_INTERPRETATIONS = Object.freeze({
  DAMAGE: "damage",
  HEALING: "healing",
  TEMP_HP_GAIN: "tempHpGain",
  TEMP_HP_LOSS: "tempHpLoss",
  MAX_HP_CHANGE: "maxHpChange",
  CORRECTION_DAMAGE_DOWN: "correctionDamageDown",
  CORRECTION_DAMAGE_UP: "correctionDamageUp",
  CORRECTION_HEALING_DOWN: "correctionHealingDown",
  CORRECTION_HEALING_UP: "correctionHealingUp",
  UNKNOWN: "unknown",
  IGNORED: "ignored"
});

export const DPR_METHODS = Object.freeze({
  ROLLED: "rolled",
  APPLIED_GROSS: "appliedGross",
  APPLIED_NET: "appliedNet"
});

export const SHARE_MODES = Object.freeze({
  GM_ONLY: "gmOnly",
  SUMMARY_ONLY: "summaryOnly",
  PARTY_DPR_ONLY: "partyDprOnly",
  FULL_VISIBLE_DPR: "fullVisibleDpr",
  FULL_VISIBLE_RECAP: "fullVisibleRecap",
  PUBLIC_REPORT: "publicReport"
});

export const TABS = Object.freeze(["history", "summary", "timeline", "statistics", "dpr", "corrections", "participants", "sharing"]);

export const DEFAULT_RESOURCE_PATHS = Object.freeze({
  generic: ["system.attributes.hp.value", "system.attributes.hp.temp", "system.attributes.hp.tempmax", "system.attributes.hp.max"],
  dnd5e: ["system.attributes.hp.value", "system.attributes.hp.temp", "system.attributes.hp.tempmax", "system.attributes.hp.max"]
});
