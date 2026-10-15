import { escapeHtml, format, localize } from "../utils.js";

// Inline SVG charts for the Statistics tab. No library: plain markup, colors from CSS variables (.scls-chart in
// scls.css), a <title> on every bar for the hover tooltip and an aria-label that sums the chart up.

// minWidth: a short fight gets wider round groups instead of a zoomed in chart, so both charts share one text size.
const ROUND_CHART = Object.freeze({ height: 190, top: 14, bottom: 26, left: 44, right: 10, group: 36, bar: 13, gap: 2, minWidth: 420 });
// The combatant chart shares the round chart's width and minimum height: side by side, both boxes then scale their
// text alike and the bars fill the box instead of a flat strip. Few combatants get thicker bars, many get more rows.
const COMBATANT_CHART = Object.freeze({ width: ROUND_CHART.minWidth, height: ROUND_CHART.height, label: 104, right: 40, minRow: 40, minBar: 9, maxBar: 18, gap: 2, padding: 8, top: 6, bottom: 22, nameLength: 16 });
const MAX_COMBATANTS = 12;

// Party and enemy damage per round as grouped columns. rows: computed.byRound.
// enemies false: party columns only (player view of a combat without enemy numbers).
export function roundDamageChart(rows = [], { formatValue = String, enemies = true } = {}) {
  const data = (rows ?? []).filter((row) => Number(row?.round) > 0);
  const values = data.flatMap((row) => enemies ? [positive(row.partyDamage), positive(row.enemyDamage)] : [positive(row.partyDamage)]);
  if (!data.length || !values.some(Boolean)) return "";
  const { height, top, bottom, left, right, bar, gap, minWidth } = ROUND_CHART;
  const group = Math.max(ROUND_CHART.group, (minWidth - left - right) / data.length);
  const plot = height - top - bottom;
  const max = niceMax(Math.max(...values));
  const width = left + right + (data.length * group);
  const y = (value) => top + plot - (plot * value / max);
  const series = [
    { key: "party", label: localize("SCLS.Chart.Party"), value: (row) => positive(row.partyDamage) },
    { key: "enemies", label: localize("SCLS.Chart.Enemies"), value: (row) => positive(row.enemyDamage) }
  ].slice(0, enemies ? 2 : 1);
  const parts = [gridLines([0, max / 2, max], { y, left, right: width - right, formatValue })];
  data.forEach((row, index) => {
    const start = left + (index * group) + ((group - (series.length * bar) - ((series.length - 1) * gap)) / 2);
    series.forEach((entry, position) => {
      const value = entry.value(row);
      const tooltip = format("SCLS.Chart.RoundTooltip", { round: formatValue(row.round), side: entry.label, amount: formatValue(value) });
      parts.push(barRect({ x: start + (position * (bar + gap)), y: y(value), width: bar, height: Math.max(0, top + plot - y(value)), tone: entry.key, tooltip }));
    });
    // Round numbers under every column; with many rounds every second one.
    if (data.length <= 16 || index % 2 === 0) parts.push(`<text class="scls-chart__axis" x="${fixed(left + (index * group) + (group / 2))}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatValue(row.round))}</text>`);
  });
  const totals = series.map((entry) => data.reduce((total, row) => total + entry.value(row), 0));
  const key = enemies ? "SCLS.Chart.RoundSummary" : "SCLS.Chart.RoundSummaryParty";
  const label = format(data.length === 1 ? `${key}One` : key, { count: formatValue(data.length), party: formatValue(totals[0]), enemies: formatValue(totals[1] ?? 0) });
  return svg({ width, height, label, body: parts.join("") });
}

// Damage dealt, damage taken and healing per combatant as horizontal bars on one scale.
// rows: {id, name, damageAppliedNet, damageTakenNet, healing}.
export function combatantBarChart(rows = [], { formatValue = String } = {}) {
  const measures = [
    { key: "dealt", label: localize("SCLS.Label.DamageDealt"), value: (row) => positive(row.damageAppliedNet) },
    { key: "taken", label: localize("SCLS.Label.DamageTaken"), value: (row) => positive(row.damageTakenNet) },
    { key: "healing", label: localize("SCLS.Label.Healing"), value: (row) => positive(row.healing ?? row.healingNet) }
  ];
  const data = (rows ?? [])
    .filter((row) => measures.some((measure) => measure.value(row) > 0))
    .sort((leftRow, rightRow) => (measures[0].value(rightRow) - measures[0].value(leftRow)) || (measures[2].value(rightRow) - measures[2].value(leftRow)))
    .slice(0, MAX_COMBATANTS);
  if (!data.length) return "";
  const { width, label: labelWidth, right, gap, top, bottom } = COMBATANT_CHART;
  const { rowHeight, bar } = combatantRows(data.length);
  const height = top + bottom + (data.length * rowHeight);
  const plot = width - labelWidth - right;
  const max = niceMax(Math.max(...data.flatMap((row) => measures.map((measure) => measure.value(row)))));
  const x = (value) => labelWidth + (plot * value / max);
  const parts = [];
  for (const tick of [0, max / 2, max]) {
    parts.push(`<line class="scls-chart__grid" x1="${fixed(x(tick))}" x2="${fixed(x(tick))}" y1="${top}" y2="${fixed(height - bottom)}"></line>`);
    parts.push(`<text class="scls-chart__axis" x="${fixed(x(tick))}" y="${fixed(height - 8)}" text-anchor="middle">${escapeHtml(formatValue(round(tick)))}</text>`);
  }
  data.forEach((row, index) => {
    const band = top + (index * rowHeight);
    const name = String(row.name ?? "");
    parts.push(`<text class="scls-chart__label" x="${labelWidth - 6}" y="${fixed(band + (rowHeight / 2))}" dominant-baseline="central" text-anchor="end"><title>${escapeHtml(name)}</title>${escapeHtml(shorten(name, COMBATANT_CHART.nameLength))}</text>`);
    const first = band + ((rowHeight - (3 * bar) - (2 * gap)) / 2);
    measures.forEach((measure, position) => {
      const value = measure.value(row);
      const barY = first + (position * (bar + gap));
      const tooltip = format("SCLS.Chart.CombatantTooltip", { name, measure: measure.label, amount: formatValue(value) });
      parts.push(barRect({ x: labelWidth, y: barY, width: Math.max(0, x(value) - labelWidth), height: bar, tone: measure.key, tooltip }));
      if (value > 0) parts.push(`<text class="scls-chart__value" x="${fixed(x(value) + 3)}" y="${fixed(barY + (bar / 2))}" dominant-baseline="central">${escapeHtml(formatValue(value))}</text>`);
    });
  });
  const label = format(data.length === 1 ? "SCLS.Chart.CombatantSummaryOne" : "SCLS.Chart.CombatantSummary", { count: formatValue(data.length) });
  return svg({ width, height, label, body: parts.join(""), modifier: "bars" });
}

// Row height and bar thickness for count combatants: the rows fill at least the round chart's plot height, the
// bars grow with the row up to maxBar and never get thinner than minBar, so value labels stay apart.
export function combatantRows(count) {
  const { height, top, bottom, minRow, minBar, maxBar, gap, padding } = COMBATANT_CHART;
  const rows = Math.max(1, Number(count) || 1);
  const rowHeight = Math.max(minRow, (height - top - bottom) / rows);
  const bar = Math.min(maxBar, Math.max(minBar, (rowHeight - padding - (2 * gap)) / 3));
  return { rowHeight, bar };
}

function svg({ width, height, label, body, modifier = "" }) {
  return `<svg class="scls-chart__svg${modifier ? ` scls-chart__svg--${modifier}` : ""}" viewBox="0 0 ${fixed(width)} ${fixed(height)}" role="img" aria-label="${escapeHtml(label)}" preserveAspectRatio="xMinYMin meet"><title>${escapeHtml(label)}</title>${body}</svg>`;
}

function barRect({ x, y, width, height, tone, tooltip }) {
  return `<rect class="scls-chart__bar scls-chart__bar--${tone}" x="${fixed(x)}" y="${fixed(y)}" width="${fixed(width)}" height="${fixed(height)}" rx="2"><title>${escapeHtml(tooltip)}</title></rect>`;
}

function gridLines(ticks, { y, left, right, formatValue }) {
  return ticks.map((tick) => `<line class="scls-chart__grid" x1="${left}" x2="${fixed(right)}" y1="${fixed(y(tick))}" y2="${fixed(y(tick))}"></line><text class="scls-chart__axis" x="${left - 6}" y="${fixed(y(tick) + 4)}" text-anchor="end">${escapeHtml(formatValue(round(tick)))}</text>`).join("");
}

// 1, 2, 2.5 or 5 times a power of ten, at least the largest value.
export function niceMax(value) {
  const number = Math.max(1, Number(value) || 0);
  const power = 10 ** Math.floor(Math.log10(number));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= number) return step * power;
  return 10 * power;
}

function positive(value) {
  return Math.max(0, Number(value) || 0);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function fixed(value) {
  return String(Math.round((Number(value) || 0) * 10) / 10);
}

function shorten(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
