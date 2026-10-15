import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.game = { i18n: { lang: "en", localize: (key) => key }, settings: { get: () => undefined } };

const { combatantBarChart, combatantRows, niceMax, roundDamageChart } = await import("../scripts/apps/charts.js");

test("the round chart draws a party and an enemy column per round with tooltips and a summary", () => {
  const svg = roundDamageChart([
    { round: 1, partyDamage: 12, enemyDamage: 4 },
    { round: 2, partyDamage: 0, enemyDamage: 9 },
    { round: 3, partyDamage: 21.5, enemyDamage: 0 }
  ]);
  assert.match(svg, /^<svg class="scls-chart__svg" viewBox="0 0 \d+ 190" role="img" aria-label="SCLS\.Chart\.RoundSummary"/);
  assert.equal((svg.match(/<rect /g) ?? []).length, 6);
  assert.equal((svg.match(/scls-chart__bar--party/g) ?? []).length, 3);
  assert.equal((svg.match(/scls-chart__bar--enemies/g) ?? []).length, 3);
  assert.equal((svg.match(/<title>SCLS\.Chart\.RoundTooltip<\/title>/g) ?? []).length, 6);
  // Round labels and a scale up to a round number.
  assert.match(svg, />3<\/text>/);
  assert.match(svg, />25<\/text>/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test("no damage, no chart", () => {
  assert.equal(roundDamageChart([]), "");
  assert.equal(roundDamageChart([{ round: 1, partyDamage: 0, enemyDamage: 0 }]), "");
  assert.equal(combatantBarChart([{ id: "a", name: "A", damageAppliedNet: 0, damageTakenNet: 0, healing: 0 }]), "");
});

test("the combatant chart sorts by damage dealt, escapes names and keeps twelve rows", () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({ id: `c${index}`, name: `Fighter ${index}`, damageAppliedNet: index, damageTakenNet: 2, healing: index % 3 }));
  rows.push({ id: "evil", name: "<script>Boss</script> & Co", damageAppliedNet: 99, damageTakenNet: 0, healing: 0 });
  const svg = combatantBarChart(rows, { formatValue: (value) => `${value}` });
  const labels = Array.from(svg.matchAll(/class="scls-chart__label"[^>]*><title>([^<]*)<\/title>/g), (match) => match[1]);
  assert.equal(labels.length, 12);
  assert.equal(labels[0], "&lt;script&gt;Boss&lt;/script&gt; &amp; Co");
  assert.equal(labels[1], "Fighter 13");
  assert.doesNotMatch(svg, /<script>/);
  assert.equal((svg.match(/scls-chart__bar--dealt/g) ?? []).length, 12);
  assert.equal((svg.match(/scls-chart__bar--healing/g) ?? []).length, 12);
  assert.match(svg, /aria-label="SCLS\.Chart\.CombatantSummary"/);
});

test("the scale ends on a readable number", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(13), 20);
  assert.equal(niceMax(21.5), 25);
  assert.equal(niceMax(42), 50);
  assert.equal(niceMax(120), 200);
});

test("a short fight keeps the round chart as wide as the combatant chart instead of zooming in", () => {
  const svg = roundDamageChart([{ round: 1, partyDamage: 5, enemyDamage: 3 }]);
  const width = Number(svg.match(/viewBox="0 0 ([\d.]+) 190"/)[1]);
  assert.ok(width >= 420, `width ${width}`);
  assert.match(svg, /aria-label="SCLS\.Chart\.RoundSummaryOne"/);
  // Many rounds still grow the chart.
  const long = roundDamageChart(Array.from({ length: 30 }, (_, index) => ({ round: index + 1, partyDamage: index, enemyDamage: 1 })));
  assert.ok(Number(long.match(/viewBox="0 0 ([\d.]+) 190"/)[1]) > 1000);
  assert.match(combatantBarChart([{ id: "a", name: "A", damageAppliedNet: 3 }]), /aria-label="SCLS\.Chart\.CombatantSummaryOne"/);
});

test("the combatant chart fills a box as large as the round chart's, for one or many combatants", () => {
  const viewBox = (svg) => svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  const [roundWidth, roundHeight] = viewBox(roundDamageChart([{ round: 1, partyDamage: 5, enemyDamage: 3 }]));
  const rows = (count) => Array.from({ length: count }, (_, index) => ({ id: `c${index}`, name: `Fighter ${index}`, damageAppliedNet: 10 + index, damageTakenNet: 4, healing: 2 }));
  for (const count of [1, 2, 4]) {
    const svg = combatantBarChart(rows(count));
    assert.match(svg, /^<svg class="scls-chart__svg scls-chart__svg--bars"/);
    assert.deepEqual(viewBox(svg), [roundWidth, roundHeight], `${count} combatants`);
  }
  // Few combatants get thick bars, many get rows of their own and a taller chart.
  assert.ok(combatantRows(1).bar > combatantRows(6).bar);
  const many = viewBox(combatantBarChart(rows(12)));
  assert.equal(many[0], roundWidth);
  assert.ok(many[1] > roundHeight);
  // Value labels (10 units) never overlap: every bar plus gap is at least that high.
  for (const count of [1, 3, 6, 12, 40]) {
    const { rowHeight, bar } = combatantRows(count);
    assert.ok(bar + 2 >= 10, `${count}: bar ${bar}`);
    assert.ok((3 * bar) + 4 <= rowHeight, `${count}: bars fit the row`);
  }
});
