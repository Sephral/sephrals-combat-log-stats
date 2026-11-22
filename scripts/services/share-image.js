import { LOG_STATUS, MODULE_ID, SETTINGS } from "../constants.js";
import { getSetting } from "../settings.js";
import { cloneData, formatDateTime, formatDuration, localize } from "../utils.js";
import { awardCards } from "./awards-service.js";
import { applyShareChoice, buildEndCard, endCardLines, needsShareChoice, SHARE_CHOICES } from "./end-card-service.js";
import { playerShareSettings, playerViewLog } from "./player-view-service.js";

// A fight as a picture for sharing: title, rounds and time, the card's highlights, the course of the fight and the
// awards, drawn on a canvas by this file alone so the picture looks the same on every screen and in every theme.
// What it tells comes from the player view of the fight (the same rules as the card for everyone and the player
// report), never from the GM's whole log. A fight that was never set up for sharing is drawn at summary level.

export const IMAGE_WIDTH = 1080;
export const IMAGE_SCALE = 2;
const PAD = 56;
const GAP = 20;
const MAX_STORY = 6;
// A picture this tall is no longer a picture to share; taller content is cut at the bottom, so the rounds and awards are limited (MAX_STORY and the awards).
const MAX_HEIGHT = 3600;

export const THEMES = Object.freeze({
  dark: { bg: "#17171d", card: "#23232c", text: "#f3efe4", muted: "#a8a5b2", accent: "#e3a93f", line: "#35353f", band: "#e3a93f", onBand: "#17171d" },
  light: { bg: "#f5f0e4", card: "#ffffff", text: "#241f1d", muted: "#6a625b", accent: "#9a2a1d", line: "#dfd5c1", band: "#9a2a1d", onBand: "#ffffff" }
});

/**
 * The words and numbers of the picture, from the player view of a log. Whether a hidden combatant, enemy numbers or a
 * single hit appears follows the sharing choices of that fight, like the end card for everyone.
 * @param {object} log        A combat log (stored or live)
 * @param {object} [options]
 * @param {object} [options.statsOptions]  see CombatLogService.statsOptions
 * @param {boolean} [options.credit]       the footer line; default: the setting (on)
 * @returns {{label: string, title: string, subtitle: string, tiles: {value: string, label: string}[], lines: string[],
 *   storyTitle: string, story: string[], awardsTitle: string, awards: {label: string, names: string, detail: string}[],
 *   footer: string, quiet: boolean}}
 */
export function shareImageModel(log, { statsOptions = {}, credit = getSetting(SETTINGS.SHARE_IMAGE_CREDIT, true) !== false } = {}) {
  // Never set up for sharing: summary level, on a copy, so the picture changes nothing about the fight.
  const source = needsShareChoice(log) ? withSummaryShare(log) : log;
  const share = playerShareSettings(source);
  const view = playerViewLog(source, { statsOptions, share });
  const data = buildEndCard(source, { statsOptions, everyone: true, countStory: false });
  const lines = endCardLines(data, log.systemId);
  const ended = log.status === LOG_STATUS.ENDED || Boolean(log.endedAt);
  const stamp = log.endedAt ?? log.startedAt ?? log.createdAt;
  const tiles = [
    { value: String(data.rounds), label: localize("SCLS.ShareImage.Rounds") },
    ...(data.durationMs > 0 ? [{ value: formatDuration(data.durationMs), label: localize("SCLS.ShareImage.Time") }] : []),
    ...(data.quiet ? [] : [
      { value: String(data.defeated), label: localize("SCLS.ShareImage.Defeated") },
      { value: String(data.downedCount), label: localize("SCLS.ShareImage.Downed") }
    ])
  ];
  const awards = data.quiet ? [] : awardCards(view).map((award) => ({ label: award.label, names: award.names, detail: award.detail }));
  return {
    label: localize(ended ? "SCLS.ShareImage.Over" : "SCLS.ShareImage.Running"),
    title: String(log.title || localize("SCLS.EndCard.TitlePlain")),
    subtitle: stamp ? formatDateTime(stamp) : "",
    tiles,
    lines: lines.slice(1),
    storyTitle: localize("SCLS.EndCard.Story"),
    story: (data.story ?? []).slice(0, MAX_STORY).map((entry) => String(entry?.text ?? "")).filter(Boolean),
    awardsTitle: localize("SCLS.Metrics.Awards"),
    awards,
    footer: credit ? localize("SCLS.ShareImage.Credit") : "",
    quiet: data.quiet
  };
}

function withSummaryShare(log) {
  const copy = cloneData(log);
  applyShareChoice(copy, SHARE_CHOICES.SUMMARY);
  return copy;
}

/** Breaks a text into lines no wider than maxWidth. A word wider than a line is cut by characters. */
export function wrapText(measure, text, maxWidth) {
  const lines = [];
  let current = "";
  const push = () => {
    if (current) lines.push(current);
    current = "";
  };
  for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    const attempt = current ? `${current} ${word}` : word;
    if (measure(attempt) <= maxWidth) {
      current = attempt;
      continue;
    }
    push();
    if (measure(word) <= maxWidth) {
      current = word;
      continue;
    }
    for (const char of Array.from(word)) {
      if (current && measure(current + char) > maxWidth) push();
      current += char;
    }
  }
  push();
  return lines;
}

/**
 * Positions everything. Pure: the only outside help is measure(text, font) for the width of a text.
 * @returns {{width: number, height: number, theme: object, ops: object[]}} drawing operations in picture pixels
 */
export function layoutShareImage(model, { theme = "dark", measure, family = "sans-serif" } = {}) {
  const colors = THEMES[theme] ?? THEMES.dark;
  const font = (size, weight = 400) => `${weight} ${size}px ${family}`;
  const width = (text, f) => measure(text, f);
  const inner = IMAGE_WIDTH - 2 * PAD;
  const rects = [];
  const texts = [];
  let y = 0;

  const text = (value, x, baseline, f, color, align = "left") => texts.push({ type: "text", text: value, x, y: baseline, font: f, color, align });
  const paragraph = (value, x, top, maxWidth, size, weight, color, { lineHeight = Math.round(size * 1.35), maxLines = 99 } = {}) => {
    const f = font(size, weight);
    let lines = wrapText((t) => width(t, f), value, maxWidth);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = ellipsize((t) => width(t, f), lines[maxLines - 1], maxWidth);
    }
    lines.forEach((line, index) => text(line, x, top + Math.round(size * 1.05) + index * lineHeight, f, color));
    return lines.length * lineHeight;
  };

  // Header band
  const bandTop = 0;
  rects.push({ type: "rect", x: 0, y: bandTop, w: IMAGE_WIDTH, h: 14, color: colors.band, radius: 0 });
  y = 14 + 44;
  text(String(model.label ?? "").toUpperCase(), PAD, y + 16, font(22, 700), colors.accent);
  y += 36;
  y += paragraph(model.title, PAD, y, inner, 56, 700, colors.text, { lineHeight: 64, maxLines: 3 });
  if (model.subtitle) {
    y += 6;
    y += paragraph(model.subtitle, PAD, y, inner, 24, 400, colors.muted, { maxLines: 1 });
  }
  y += 34;

  // Number tiles
  if (model.tiles?.length) {
    const count = model.tiles.length;
    const tileW = Math.floor((inner - GAP * (count - 1)) / count);
    const tileH = 128;
    model.tiles.forEach((tile, index) => {
      const x = PAD + index * (tileW + GAP);
      rects.push({ type: "rect", x, y, w: tileW, h: tileH, color: colors.card, radius: 18, stroke: colors.line });
      const valueFont = fitFont(width, tile.value, tileW - 24, 56, 30, 700, family);
      text(tile.value, x + tileW / 2, y + 66, valueFont, colors.text, "center");
      const labelFont = fitFont(width, String(tile.label).toUpperCase(), tileW - 24, 19, 13, 600, family);
      text(String(tile.label).toUpperCase(), x + tileW / 2, y + 106, labelFont, colors.muted, "center");
    });
    y += tileH + 36;
  }

  // The card's lines, with an accent bar each
  for (const line of model.lines ?? []) {
    const height = lineHeightOf(width, line, inner - 28, 29, font);
    rects.push({ type: "rect", x: PAD, y: y + 3, w: 6, h: height - 6, color: colors.accent, radius: 3 });
    paragraph(line, PAD + 28, y, inner - 28, 29, 500, colors.text, { lineHeight: 39 });
    y += height + 14;
  }
  if (model.lines?.length) y += 14;

  // Course of the fight
  if (model.story?.length) {
    text(String(model.storyTitle).toUpperCase(), PAD, y + 16, font(22, 700), colors.accent);
    y += 34;
    for (const sentence of model.story) {
      const f = font(26, 400);
      const lines = wrapText((t) => width(t, f), sentence, inner - 28);
      const height = lines.length * 36;
      text("•", PAD + 4, y + 28, font(26, 700), colors.accent);
      paragraph(sentence, PAD + 28, y, inner - 28, 26, 400, colors.text, { lineHeight: 36 });
      y += height + 10;
    }
    y += 18;
  }

  // Awards, two to a row
  if (model.awards?.length) {
    text(String(model.awardsTitle).toUpperCase(), PAD, y + 16, font(22, 700), colors.accent);
    y += 38;
    const cellW = Math.floor((inner - GAP) / 2);
    for (let start = 0; start < model.awards.length; start += 2) {
      const row = model.awards.slice(start, start + 2);
      const cells = row.map((award) => {
        const namesFont = font(27, 700);
        const detailFont = font(23, 400);
        const names = wrapText((t) => width(t, namesFont), award.names, cellW - 40).slice(0, 2);
        const detail = wrapText((t) => width(t, detailFont), award.detail, cellW - 40).slice(0, 2);
        return { award, names, detail, height: 24 + 28 + 10 + names.length * 34 + 4 + detail.length * 30 + 22 };
      });
      const rowH = Math.max(...cells.map((cell) => cell.height));
      cells.forEach((cell, index) => {
        const x = PAD + index * (cellW + GAP);
        rects.push({ type: "rect", x, y, w: cellW, h: rowH, color: colors.card, radius: 18, stroke: colors.line });
        text(String(cell.award.label).toUpperCase(), x + 20, y + 42, font(19, 700), colors.accent);
        cell.names.forEach((line, i) => text(line, x + 20, y + 24 + 28 + 10 + 24 + i * 34, font(27, 700), colors.text));
        cell.detail.forEach((line, i) => text(line, x + 20, y + 24 + 28 + 10 + cell.names.length * 34 + 4 + 22 + i * 30, font(23, 400), colors.muted));
      });
      y += rowH + GAP;
    }
    y += 6;
  }

  // Footer
  if (model.footer) {
    rects.push({ type: "rect", x: PAD, y: y + 6, w: inner, h: 2, color: colors.line, radius: 1 });
    y += 36;
    text(model.footer, IMAGE_WIDTH - PAD, y + 12, font(21, 600), colors.muted, "right");
    y += 40;
  } else {
    y += 20;
  }
  y += 24;

  const height = Math.min(MAX_HEIGHT, Math.max(320, Math.ceil(y)));
  return {
    width: IMAGE_WIDTH,
    height,
    theme: colors,
    ops: [{ type: "rect", x: 0, y: 0, w: IMAGE_WIDTH, h: height, color: colors.bg, radius: 0 }, ...rects, ...texts]
  };
}

function lineHeightOf(width, value, maxWidth, size, font) {
  const f = font(size, 500);
  return wrapText((t) => width(t, f), value, maxWidth).length * 39;
}

function ellipsize(measure, line, maxWidth) {
  let value = line;
  while (value.length > 1 && measure(`${value}…`) > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

// The biggest font size from max down to min at which the text fits.
function fitFont(width, value, maxWidth, max, min, weight, family) {
  for (let size = max; size > min; size -= 2) {
    const f = `${weight} ${size}px ${family}`;
    if (width(value, f) <= maxWidth) return f;
  }
  return `${weight} ${min}px ${family}`;
}

/** Draws a layout on a 2d context (any canvas): scale the context first. */
export function paintShareImage(context, layout) {
  for (const op of layout.ops) {
    if (op.type === "rect") {
      context.fillStyle = op.color;
      if (op.radius) {
        roundRect(context, op.x, op.y, op.w, op.h, op.radius);
        context.fill();
        if (op.stroke) {
          context.strokeStyle = op.stroke;
          context.lineWidth = 2;
          roundRect(context, op.x + 1, op.y + 1, op.w - 2, op.h - 2, op.radius);
          context.stroke();
        }
      } else context.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.type === "text") {
      context.font = op.font;
      context.fillStyle = op.color;
      context.textAlign = op.align;
      context.textBaseline = "alphabetic";
      context.fillText(op.text, op.x, op.y);
    }
  }
}

function roundRect(context, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}

/** "light" or "dark", as Foundry shows its interface (the body class, then the user's setting, then the browser). */
export function foundryColorScheme() {
  try {
    const classes = globalThis.document?.body?.classList;
    if (classes?.contains("theme-light")) return "light";
    if (classes?.contains("theme-dark")) return "dark";
    const configured = globalThis.game?.settings?.get?.("core", "uiConfig")?.colorScheme?.interface;
    if (configured === "light" || configured === "dark") return configured;
    if (globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches) return "light";
  } catch {
    // The default below.
  }
  return "dark";
}

function fontFamily() {
  const computed = globalThis.document?.body ? globalThis.getComputedStyle?.(globalThis.document.body)?.fontFamily : "";
  return `${computed ? `${computed}, ` : ""}Signika, "Segoe UI", sans-serif`;
}

/** The picture as a PNG blob. Needs a browser (canvas); the layout itself is tested apart. */
export async function renderShareImage(log, { statsOptions = {}, theme = foundryColorScheme() } = {}) {
  const model = shareImageModel(log, { statsOptions });
  const family = fontFamily();
  try {
    await Promise.all(["400", "500", "600", "700"].map((weight) => globalThis.document.fonts.load(`${weight} 24px ${family}`)));
  } catch {
    // A missing font only changes the look.
  }
  const canvas = globalThis.document.createElement("canvas");
  const probe = canvas.getContext("2d");
  const layout = layoutShareImage(model, { theme, family, measure: (value, font) => {
    probe.font = font;
    return probe.measureText(value).width;
  } });
  canvas.width = layout.width * IMAGE_SCALE;
  canvas.height = layout.height * IMAGE_SCALE;
  const context = canvas.getContext("2d");
  context.scale(IMAGE_SCALE, IMAGE_SCALE);
  paintShareImage(context, layout);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(`${MODULE_ID} | The canvas gave no picture`);
  return blob;
}

/** A file name for the picture: fight title and day, letters and digits only. */
export function shareImageFileName(log, now = new Date()) {
  const slug = String(log?.title ?? "fight").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "fight";
  return `${slug}-${now.toISOString().slice(0, 10)}.png`;
}
