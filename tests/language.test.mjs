import assert from "node:assert/strict";
import test from "node:test";

import { LANGUAGE_MODES, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { registerSettings } from "../scripts/settings.js";

let languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;

// Simulates Foundry's merged translations per language with English fallback (module files plus community translations).
const foundryTranslations = {
  en: { "SCLS.Test.Language": "Foundry English", "SCLS.Test.FoundryOnly": "Foundry only" },
  de: { "SCLS.Test.Language": "Foundry Deutsch" },
  fr: { "SCLS.Test.Language": "Français" }
};

globalThis.game = {
  i18n: {
    lang: "en",
    localize(key) {
      return foundryTranslations[this.lang]?.[key] ?? foundryTranslations.en[key] ?? key;
    }
  },
  settings: {
    get: (moduleId, key) => moduleId === MODULE_ID && key === SETTINGS.LANGUAGE ? languageMode : undefined,
    register: () => {}
  }
};

globalThis.fetch = async (path) => ({
  ok: true,
  async json() {
    if (String(path).includes("/de.json")) return { "SCLS.Test.Language": "Deutsch" };
    return { "SCLS.Test.Language": "English" };
  }
});

const { activeLanguage, activeLocale, format, formatDateTime, loadModuleTranslations, localize } = await import("../scripts/utils.js");

await loadModuleTranslations();

const sampleDate = "2026-03-14T15:09:00.000Z";
const expectedDate = (locale) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(sampleDate));

test("language setting follows Foundry by default", () => {
  languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;
  game.i18n.lang = "de";
  assert.equal(activeLanguage(), LANGUAGE_MODES.DE);
  assert.equal(activeLocale(), "de");
  assert.equal(localize("SCLS.Test.Language"), "Foundry Deutsch");
});

test("follow Foundry uses community translations instead of the bundled English file", () => {
  languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;
  game.i18n.lang = "fr";
  assert.equal(localize("SCLS.Test.Language"), "Français");
  assert.equal(format("SCLS.Test.Language"), "Français");
  assert.equal(localize("SCLS.Test.FoundryOnly"), "Foundry only");
});

test("follow Foundry formats dates with the Foundry language", () => {
  languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;
  game.i18n.lang = "fr";
  assert.equal(activeLocale(), "fr");
  assert.equal(formatDateTime(sampleDate), expectedDate("fr"));
});

test("language setting can force English", () => {
  languageMode = LANGUAGE_MODES.EN;
  game.i18n.lang = "de";
  assert.equal(activeLanguage(), LANGUAGE_MODES.EN);
  assert.equal(localize("SCLS.Test.Language"), "English");
});

test("forced English overrides a community translation and falls back to Foundry for missing keys", () => {
  languageMode = LANGUAGE_MODES.EN;
  game.i18n.lang = "fr";
  assert.equal(localize("SCLS.Test.Language"), "English");
  assert.equal(localize("SCLS.Test.FoundryOnly"), "Foundry only");
  assert.equal(formatDateTime(sampleDate), expectedDate("en"));
});

test("language setting can force German", () => {
  languageMode = LANGUAGE_MODES.DE;
  game.i18n.lang = "en";
  assert.equal(activeLanguage(), LANGUAGE_MODES.DE);
  assert.equal(activeLocale(), LANGUAGE_MODES.DE);
  assert.equal(localize("SCLS.Test.Language"), "Deutsch");
  assert.equal(formatDateTime(sampleDate), expectedDate("de"));
});

test("language setting registers client choices", () => {
  const registrations = new Map();
  game.settings.register = (moduleId, key, definition) => registrations.set(`${moduleId}.${key}`, definition);
  registerSettings();
  const definition = registrations.get(`${MODULE_ID}.${SETTINGS.LANGUAGE}`);
  assert.equal(definition.scope, "client");
  assert.equal(definition.config, true);
  assert.equal(definition.default, LANGUAGE_MODES.FOLLOW_FOUNDRY);
  assert.deepEqual(Object.keys(definition.choices), [LANGUAGE_MODES.FOLLOW_FOUNDRY, LANGUAGE_MODES.DE, LANGUAGE_MODES.EN]);
});
