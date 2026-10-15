import { DEFAULT_RESOURCE_PATHS, DPR_METHODS, HOOKS, LANGUAGE_MODES, MODULE_ID, SETTINGS, SHARE_MODES } from "./constants.js";

// Order is the order in Foundry's settings dialog. Language comes first, like in the other Sephral modules.
const SETTING_DEFINITIONS = [
  [SETTINGS.LANGUAGE, { scope: "client", config: true, type: String, choices: { [LANGUAGE_MODES.FOLLOW_FOUNDRY]: "SCLS.Language.FollowFoundry", [LANGUAGE_MODES.DE]: "SCLS.Language.DE", [LANGUAGE_MODES.EN]: "SCLS.Language.EN" }, default: LANGUAGE_MODES.FOLLOW_FOUNDRY, onChange: () => Hooks.callAll(HOOKS.LANGUAGE_CHANGED) }],
  [SETTINGS.ENABLE_AUTO_TRACKING, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.AUTO_RESUME_ACTIVE_COMBATS, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.SHOW_SUMMARY_ON_COMBAT_END, { scope: "client", config: true, type: Boolean, default: true }],
  [SETTINGS.TRACK_ACTIVE_EFFECTS, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.INCLUDE_UNCLEAR_DELTAS_IN_STATS, { scope: "world", config: true, type: Boolean, default: false }],
  [SETTINGS.DEFAULT_DPR_METHOD, { scope: "world", config: true, type: String, choices: { [DPR_METHODS.APPLIED_NET]: "SCLS.DprMethod.appliedNet", [DPR_METHODS.APPLIED_GROSS]: "SCLS.DprMethod.appliedGross", [DPR_METHODS.ROLLED]: "SCLS.DprMethod.rolled" }, default: DPR_METHODS.APPLIED_NET }],
  [SETTINGS.ENABLE_PLAYER_SHARING, { scope: "world", config: true, type: Boolean, default: true }],
  // Players may open the log window read only. Changing it adds or removes their tool and button right away.
  [SETTINGS.PLAYER_STATS_ACCESS, { scope: "world", config: true, type: Boolean, default: true, onChange: (value) => Hooks.callAll(HOOKS.PLAYER_ACCESS_CHANGED, value) }],
  [SETTINGS.DEFAULT_SHARE_MODE, { scope: "world", config: true, type: String, choices: { [SHARE_MODES.GM_ONLY]: "SCLS.ShareMode.gmOnly", [SHARE_MODES.SUMMARY_ONLY]: "SCLS.ShareMode.summaryOnly", [SHARE_MODES.PARTY_DPR_ONLY]: "SCLS.ShareMode.partyDprOnly", [SHARE_MODES.FULL_VISIBLE_DPR]: "SCLS.ShareMode.fullVisibleDpr", [SHARE_MODES.FULL_VISIBLE_RECAP]: "SCLS.ShareMode.fullVisibleRecap", [SHARE_MODES.PUBLIC_REPORT]: "SCLS.ShareMode.publicReport" }, default: SHARE_MODES.GM_ONLY }],
  [SETTINGS.DEFAULT_ANONYMIZE_ENEMIES, { scope: "world", config: true, type: Boolean, default: true }],
  [SETTINGS.AUTO_POST_PLAYER_SUMMARY_ON_END, { scope: "world", config: true, type: Boolean, default: false }],
  [SETTINGS.AUTO_EXPORT_JOURNAL_ON_END, { scope: "world", config: true, type: Boolean, default: false }],
  [SETTINGS.RETENTION_DAYS, { scope: "world", config: true, type: Number, default: 0 }],
  [SETTINGS.DEBUG_MODE, { scope: "client", config: true, type: Boolean, default: false }],
  // Internal or advanced values without a place in the settings dialog.
  [SETTINGS.INDEX, { scope: "world", config: false, type: Object, default: { schemaVersion: 1, logs: [] } }],
  [SETTINGS.TRACK_CHAT_MESSAGES, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_ROLLS, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.TRACK_RESOURCE_DELTAS, { scope: "world", config: false, type: Boolean, default: true }],
  [SETTINGS.RESOURCE_DELTA_WINDOW_MS, { scope: "world", config: false, type: Number, default: 60000 }],
  [SETTINGS.RESOURCE_PATHS, { scope: "world", config: false, type: Object, default: DEFAULT_RESOURCE_PATHS }]
];

export function settingDefinition(key) {
  return SETTING_DEFINITIONS.find(([entry]) => entry === key)?.[1] ?? null;
}

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
