import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIDENCE, EVENT_TYPES, MODULE_ID, SETTINGS, SIDES, SOURCE_KINDS, VISIBILITY } from "../scripts/constants.js";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../lang/de.json", import.meta.url), "utf8"));
const settings = new Map();
const notices = [];
const uploads = [];
const messages = [];
let lang = "en";
let user = { id: "gm", isGM: true, can: () => true };

globalThis.game = {
  get user() { return user; },
  world: { id: "test" },
  version: "14.370",
  i18n: { lang: "en", localize: (key) => (lang === "de" ? german : english)[key] ?? key },
  modules: { get: () => ({ title: "Combat Log & Stats" }) },
  settings: { get: (moduleId, key) => settings.get(`${moduleId}.${key}`), register: () => {} }
};
globalThis.Hooks = { on: () => {}, off: () => {} };
globalThis.ui = { notifications: { info: (text) => notices.push(["info", text]), warn: (text) => notices.push(["warn", text]) } };
globalThis.ChatMessage = { create: async (data) => { messages.push(data); return data; } };
globalThis.foundry = {
  utils: { getRoute: (path) => `/${path}` },
  applications: { apps: { FilePicker: { implementation: {
    browse: async () => { throw new Error("missing"); },
    createDirectory: async () => true,
    upload: async (source, folder, file) => { uploads.push({ source, folder, name: file.name, type: file.type, size: file.size }); return { path: `${folder}/${file.name}` }; }
  } } } }
};

const { layoutShareImage, shareImageFileName, shareImageModel, THEMES, wrapText, IMAGE_WIDTH } = await import("../scripts/services/share-image.js");
const { canCopyImage, canPostImage, postFightImage, shareImageMessageHtml } = await import("../scripts/services/share-image-actions.js");
const { shareImageButtonsHtml } = await import("../scripts/services/end-card-service.js");
const { CombatStatsService } = await import("../scripts/services/stats-service.js");

const START = "2026-11-14T19:00:00.000Z";
const at = (ms) => new Date(new Date(START).getTime() + ms).toISOString();

// Aria and Bram against a goblin boss: Aria hits for 30 (with a spell), Bram for 9, Bram goes down and is healed.
function fightLog({ hidden = false, share = {} } = {}) {
  const base = (id, type, ms, extra = {}) => ({ id, type, createdAt: at(ms), round: 1, confidence: CONFIDENCE.SAFE, visibility: VISIBILITY.PUBLIC, source: { kind: SOURCE_KINDS.CHAT_MESSAGE, id }, data: {}, ...extra });
  const log = {
    id: "fight-1",
    title: "Goblin ambush",
    status: "ended",
    systemId: "dnd5e",
    startedAt: START,
    endedAt: at(600000),
    participants: [
      { combatantId: "aria", actorUuid: "Actor.aria", name: "Aria", side: SIDES.FRIENDLY },
      { combatantId: "bram", actorUuid: "Actor.bram", name: "Bram", side: SIDES.FRIENDLY },
      { combatantId: "boss", actorUuid: "Actor.boss", name: "Goblin Boss", side: SIDES.HOSTILE, hidden }
    ],
    events: [
      base("e0", EVENT_TYPES.COMBAT_STARTED, 0),
      base("e1", EVENT_TYPES.ROUND_CHANGED, 1000),
      base("d1", EVENT_TYPES.DAMAGE_APPLIED, 60000, { combatantId: "aria", data: { amount: 30, targetCombatantId: "boss", targetDowned: true, actionName: "Fireball" } }),
      base("d2", EVENT_TYPES.DAMAGE_APPLIED, 120000, { combatantId: "bram", data: { amount: 9, targetCombatantId: "boss" } }),
      base("d3", EVENT_TYPES.DAMAGE_APPLIED, 180000, { combatantId: "boss", data: { amount: 50, targetCombatantId: "bram", targetDowned: true } }),
      base("h1", EVENT_TYPES.HEALING_APPLIED, 240000, { combatantId: "aria", data: { amount: 7, targetCombatantId: "bram" } }),
      base("e9", EVENT_TYPES.ROUND_CHANGED, 300000, { round: 3 }),
      base("end", EVENT_TYPES.COMBAT_ENDED, 600000, { round: 3 })
    ],
    shareSettings: share
  };
  log.computed = CombatStatsService.compute(log);
  return log;
}

const recap = { shareMode: "fullVisibleRecap", isShared: true, anonymizeEnemies: true, includeNpcNames: false, includeEnemyStats: false, includeHiddenCombatants: false };
const fakeMeasure = (text, font) => String(text).length * (Number(/(\d+)px/.exec(font)?.[1]) || 16) * 0.5;

test("a fight with sharing set up tells the card's highlights, the footer is on by default", () => {
  settings.clear();
  const model = shareImageModel(fightLog({ share: recap }), {});
  assert.equal(model.label, "Fight over");
  assert.equal(model.title, "Goblin ambush");
  assert.deepEqual(model.tiles.map((tile) => tile.label), ["Rounds", "Time", "Defeated", "Downed"]);
  assert.deepEqual(model.tiles.map((tile) => tile.value), ["3", "10m 0s", "1", "1"]);
  assert.ok(model.lines.includes("Top damage: Aria with 30"));
  assert.ok(model.lines.some((line) => line.startsWith("Biggest hit: Aria with 30")));
  assert.equal(model.footer, "Sephral’s Combat Log & Stats");
  assert.equal(shareImageModel(fightLog({ share: recap }), { credit: false }).footer, "");
  settings.set(`${MODULE_ID}.${SETTINGS.SHARE_IMAGE_CREDIT}`, false);
  assert.equal(shareImageModel(fightLog({ share: recap })).footer, "");
  settings.clear();
});

test("a fight never set up for sharing is drawn at summary level and the fight stays untouched", () => {
  const log = fightLog();
  const before = JSON.stringify(log.shareSettings);
  const model = shareImageModel(log, {});
  assert.ok(!model.lines.some((line) => line.startsWith("Biggest hit")), "single hits are not part of a summary");
  assert.ok(!model.lines.some((line) => line.startsWith("Closest call")));
  assert.ok(model.lines.includes("Top damage: Aria with 30"));
  assert.equal(JSON.stringify(log.shareSettings), before);
  assert.equal(log.shareSettings.shareMode, undefined);
});

test("hidden enemies and enemy numbers stay out of the picture", () => {
  const model = shareImageModel(fightLog({ hidden: true, share: recap }), {});
  const text = JSON.stringify(model);
  assert.ok(!text.includes("Goblin Boss"));
  assert.ok(!/Dropped to 0 HP: Bram/.test(text), "damage by a hidden combatant is not part of the player view");
  assert.deepEqual(model.tiles.find((tile) => tile.label === "Defeated")?.value, "0");
});

test("a fight in German uses German words", () => {
  lang = "de";
  try {
    const model = shareImageModel(fightLog({ share: recap }), {});
    assert.equal(model.label, "Kampf vorbei");
    assert.deepEqual(model.tiles.map((tile) => tile.label), ["Runden", "Dauer", "Besiegt", "Am Boden"]);
  } finally {
    lang = "en";
  }
});

test("wrapText breaks at spaces and cuts a word that is wider than a line", () => {
  const measure = (text) => text.length * 10;
  assert.deepEqual(wrapText(measure, "aaa bbb ccc ddd", 70), ["aaa bbb", "ccc ddd"]);
  assert.deepEqual(wrapText(measure, "abcdefghij", 40), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText(measure, "", 40), []);
});

test("the layout stays inside the picture, in both themes", () => {
  const model = {
    ...shareImageModel(fightLog({ share: recap }), {}),
    title: "A very long fight title that goes on and on and on and on and on and on and on and on and on and on",
    story: ["In round one the party opened with a fireball that hit three goblins at once and scorched the rug.", "Round two was quiet."],
    awards: [
      { label: "MVP", names: "Aria", detail: "42 damage and healing" },
      { label: "Healer", names: "Bram, Cleo and Dorn with a very long list of names that needs two lines", detail: "7 healing" },
      { label: "Lucky", names: "Cleo", detail: "1 critical hit" }
    ]
  };
  for (const theme of ["dark", "light"]) {
    const layout = layoutShareImage(model, { theme, measure: fakeMeasure });
    assert.equal(layout.width, IMAGE_WIDTH);
    assert.ok(layout.height > 600 && layout.height <= 3600);
    assert.equal(layout.theme, THEMES[theme]);
    for (const op of layout.ops.filter((entry) => entry.type === "rect")) assert.ok(op.x >= 0 && op.x + op.w <= IMAGE_WIDTH + 0.5 && op.y >= 0 && op.y + op.h <= layout.height + 0.5, JSON.stringify(op));
    const texts = layout.ops.filter((entry) => entry.type === "text");
    for (const op of texts) {
      assert.ok(op.y > 0 && op.y <= layout.height, JSON.stringify(op));
      const w = fakeMeasure(op.text, op.font);
      const left = op.align === "left" ? op.x : op.align === "right" ? op.x - w : op.x - w / 2;
      assert.ok(left >= 0 && left + w <= IMAGE_WIDTH + 0.5, `${op.text} runs out of the picture`);
    }
    assert.ok(texts.some((op) => op.text === "Sephral’s Combat Log & Stats"));
    assert.ok(texts.some((op) => op.text === "MVP"));
  }
  const dark = layoutShareImage(model, { theme: "dark", measure: fakeMeasure }).ops[0].color;
  const light = layoutShareImage(model, { theme: "light", measure: fakeMeasure }).ops[0].color;
  assert.notEqual(dark, light);
});

test("without the footer there is no credit line, without awards or story no heading", () => {
  const model = { ...shareImageModel(fightLog({ share: recap }), { credit: false }), story: [], awards: [] };
  const layout = layoutShareImage(model, { theme: "dark", measure: fakeMeasure });
  const all = layout.ops.filter((op) => op.type === "text").map((op) => op.text).join("|");
  assert.ok(!all.includes("Sephral"));
  assert.ok(!all.includes("COURSE OF THE FIGHT"));
  assert.ok(!all.includes("AWARDS"));
});

test("the file name is the title and the day, letters and digits only", () => {
  assert.equal(shareImageFileName({ title: "Goblin ambush!" }, new Date("2026-11-21T10:00:00Z")), "goblin-ambush-2026-11-21.png");
  assert.equal(shareImageFileName({ title: "Über Höhlen" }, new Date("2026-11-21T10:00:00Z")), "uber-hohlen-2026-11-21.png");
  assert.equal(shareImageFileName({}, new Date("2026-11-21T10:00:00Z")), "fight-2026-11-21.png");
});

test("the card carries the three buttons with the log id escaped", () => {
  const html = shareImageButtonsHtml('a"b');
  assert.equal((html.match(/data-scls-image=/g) ?? []).length, 3);
  assert.ok(html.includes('data-scls-log-id="a&quot;b"'));
  for (const kind of ["copy", "save", "post"]) assert.ok(html.includes(`data-scls-image="${kind}"`));
});

test("the clipboard needs a secure page and ClipboardItem", () => {
  const saved = { secure: globalThis.isSecureContext, item: globalThis.ClipboardItem };
  try {
    globalThis.isSecureContext = false;
    globalThis.ClipboardItem = class {};
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { write: async () => {} } }, configurable: true });
    assert.equal(canCopyImage(), false, "plain http");
    globalThis.isSecureContext = true;
    assert.equal(canCopyImage(), true);
    delete globalThis.ClipboardItem;
    assert.equal(canCopyImage(), false, "no ClipboardItem");
  } finally {
    globalThis.isSecureContext = saved.secure;
    if (saved.item) globalThis.ClipboardItem = saved.item;
  }
});

test("posting needs the right to upload, and player reports on", async () => {
  notices.length = 0;
  messages.length = 0;
  uploads.length = 0;
  user = { id: "p1", isGM: false, can: () => false };
  assert.equal(canPostImage(), false);
  assert.equal(await postFightImage(fightLog({ share: recap }), { persistence: {} }), null);
  assert.deepEqual(notices.at(-1), ["warn", english["SCLS.ShareImage.PostNoUpload"]]);
  user = { id: "p1", isGM: false, can: (permission) => permission === "FILES_UPLOAD" };
  assert.equal(canPostImage(), true, "a player with the upload permission may post");
  user = { id: "gm", isGM: true, can: () => true };
  settings.set(`${MODULE_ID}.${SETTINGS.ENABLE_PLAYER_SHARING}`, false);
  assert.equal(await postFightImage(fightLog({ share: recap }), { persistence: {} }), null);
  assert.deepEqual(notices.at(-1), ["warn", english["SCLS.ShareImage.PostOff"]]);
  assert.equal(uploads.length + messages.length, 0);
  settings.clear();
});

test("posting uploads the PNG next to the log store and puts it in the chat for everyone", async () => {
  notices.length = 0;
  messages.length = 0;
  uploads.length = 0;
  const savedDocument = globalThis.document;
  const context = { fillRect() {}, fill() {}, stroke() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fillText() {}, scale() {}, measureText: (text) => ({ width: String(text).length * 8 }) };
  globalThis.document = {
    body: { classList: { contains: (name) => name === "theme-light" } },
    fonts: { load: async () => [] },
    createElement: () => ({ getContext: () => context, toBlob: (callback) => callback(new Blob(["png"], { type: "image/png" })) })
  };
  globalThis.getComputedStyle = () => ({ fontFamily: "Signika" });
  try {
    const persistence = { ensureDirectories: async () => {}, storageBasePath: () => "worlds/test/data/sephrals-combat-log-stats", storageSource: () => "data" };
    const message = await postFightImage(fightLog({ share: recap }), { persistence });
    assert.ok(message);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].source, "data");
    assert.equal(uploads[0].folder, "worlds/test/data/sephrals-combat-log-stats/images");
    assert.equal(uploads[0].type, "image/png");
    assert.match(uploads[0].name, /^fight-fight-1-[a-z0-9]+\.png$/);
    assert.deepEqual(messages[0].whisper, []);
    assert.ok(messages[0].content.includes(`src="/worlds/test/data/sephrals-combat-log-stats/images/${uploads[0].name}"`));
    assert.equal(messages[0].flags[MODULE_ID].shareImage.logId, "fight-1");
    assert.deepEqual(notices.at(-1), ["info", english["SCLS.ShareImage.Posted"]]);
  } finally {
    globalThis.document = savedDocument;
    delete globalThis.getComputedStyle;
  }
});

test("the chat message escapes the title", () => {
  const html = shareImageMessageHtml("/x.png", '<b>"x"</b>');
  assert.ok(!html.includes("<b>"));
  assert.ok(html.includes('alt="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"'));
});

test("every picture text exists in English and German without semicolons or dashes", () => {
  const keys = Object.keys(english).filter((key) => key.startsWith("SCLS.ShareImage.") || key.startsWith("SCLS.Setting.shareImageCredit."));
  assert.ok(keys.length >= 24);
  for (const key of keys) {
    assert.ok(german[key], `${key} missing in German`);
    for (const text of [english[key], german[key]]) assert.ok(!/;| - | – | — /.test(text), text);
  }
});
