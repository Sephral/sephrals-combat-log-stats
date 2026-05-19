import assert from "node:assert/strict";
import test from "node:test";

import { LANGUAGE_MODES, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { registerSettings } from "../scripts/settings.js";

let languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;

globalThis.game = {
  i18n: { lang: "en", localize: (key) => `foundry:${key}` },
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

const { activeLanguage, loadModuleTranslations, localize } = await import("../scripts/utils.js");

await loadModuleTranslations();

test("language setting follows Foundry by default", () => {
  languageMode = LANGUAGE_MODES.FOLLOW_FOUNDRY;
  game.i18n.lang = "de";
  assert.equal(activeLanguage(), LANGUAGE_MODES.DE);
  assert.equal(localize("SCLS.Test.Language"), "Deutsch");
});

test("language setting can force English", () => {
  languageMode = LANGUAGE_MODES.EN;
  game.i18n.lang = "de";
  assert.equal(activeLanguage(), LANGUAGE_MODES.EN);
  assert.equal(localize("SCLS.Test.Language"), "English");
});

test("language setting can force German", () => {
  languageMode = LANGUAGE_MODES.DE;
  game.i18n.lang = "en";
  assert.equal(activeLanguage(), LANGUAGE_MODES.DE);
  assert.equal(localize("SCLS.Test.Language"), "Deutsch");
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