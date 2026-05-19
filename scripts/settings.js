import { DEFAULT_RESOURCE_PATHS, DPR_METHODS, HOOKS, LANGUAGE_MODES, MODULE_ID, SETTINGS, SHARE_MODES } from "./constants.js";

const SETTING_DEFINITIONS = [
  [SETTINGS.INDEX, { scope: "world", config: false, type: Object, default: { schemaVersion: 1, logs: [] } }],
  [SETTINGS.ENABLE_AUTO_TRACKING, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.SHOW_SUMMARY_ON_COMBAT_END, { scope: "client", config: true, type: Boolean, default: true }],
  [SETTINGS.AUTO_RESUME_ACTIVE_COMBATS, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.TRACK_CHAT_MESSAGES, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_ROLLS, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_RESOURCE_DELTAS, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_ACTIVE_EFFECTS, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_TEMPLATES, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_TOKEN_UPDATES, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.RESOURCE_DELTA_WINDOW_MS, { scope: "world", config: false, type: Number, default: 60000 }],
  [SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, { scope: "world", config: true, type: Boolean, default: false }],
  [SETTINGS.DEFAULT_DPR_METHOD, { scope: "world", config: false, type: String, choices: { [DPR_METHODS.ROLLED]: "Rolled", [DPR_METHODS.APPLIED_GROSS]: "Applied Gross", [DPR_METHODS.APPLIED_NET]: "Applied Net" }, default: DPR_METHODS.APPLIED_NET }],
  [SETTINGS.ENABLE_PLAYER_SHARING, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.DEFAULT_SHARE_MODE, { scope: "world", config: false, type: String, choices: { [SHARE_MODES.GM_ONLY]: "GM only", [SHARE_MODES.SUMMARY_ONLY]: "Players: Summary only", [SHARE_MODES.PARTY_DPR_ONLY]: "Players: Party DPR only", [SHARE_MODES.FULL_VISIBLE_DPR]: "Players: Full visible DPR", [SHARE_MODES.FULL_VISIBLE_RECAP]: "Players: Full visible combat recap", [SHARE_MODES.PUBLIC_REPORT]: "Public combat report" }, default: SHARE_MODES.GM_ONLY }],
  [SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END, { scope: "world", config: false, type: Boolean, default: false }],
  [SETTINGS.AUTO_EXPORT_JOURNAL_ON_END, { scope: "world", config: false, type: Boolean, default: false }],
  [SETTINGS.RETENTION_DAYS, { scope: "world", config: true, type: Number, default: 0 }],
  [SETTINGS.RESOURCE_PATHS, { scope: "world", config: false, type: Object, default: DEFAULT_RESOURCE_PATHS }],
  [SETTINGS.LANGUAGE, { scope: "client", config: true, type: String, choices: { [LANGUAGE_MODES.FOLLOW_FOUNDRY]: "SCLS.Language.FollowFoundry", [LANGUAGE_MODES.DE]: "SCLS.Language.DE", [LANGUAGE_MODES.EN]: "SCLS.Language.EN" }, default: LANGUAGE_MODES.FOLLOW_FOUNDRY, onChange: () => Hooks.callAll(HOOKS.LANGUAGE_CHANGED) }],
  [SETTINGS.DEBUG_MODE, { scope: "client", config: true, type: Boolean, default: false }]
];

export function registerSettings() {
  for (const [key, definition] of SETTING_DEFINITIONS) {
    const label = definition.config ? { name: `SCLS.Setting.${key}.Name`, hint: `SCLS.Setting.${key}.Hint` } : { name: key, hint: "" };
    game.settings.register(MODULE_ID, key, {
      ...label,
      ...definition
    });
  }
}

export function getSetting(key, fallback = null) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}
