'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const load = () => import('../scripts/download-chart.mjs');

function days(start, count, downloads = () => 1) {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    downloads: downloads(i),
  }));
}

test('toWeeks gom tu ngay cuoi, tuan dau co the thieu', async () => {
  const { toWeeks } = await load();
  const weeks = toWeeks(days('2026-10-01', 10, i => i));

  assert.deepStrictEqual(weeks, [
    { start: '2026-10-01', end: '2026-10-03', downloads: 0 + 1 + 2 },
    { start: '2026-10-04', end: '2026-10-10', downloads: 3 + 4 + 5 + 6 + 7 + 8 + 9 },
  ]);
  assert.deepStrictEqual(toWeeks([]), []);
});

test('niceStep cho buoc tron 1, 2, 5 x 10^n', async () => {
  const { niceStep } = await load();
  assert.strictEqual(niceStep(1100), 500);
  assert.strictEqual(niceStep(40), 10);
  assert.strictEqual(niceStep(7), 2);
  assert.strictEqual(niceStep(0), 1);
});

test('renderChart ve du cot, tong, vach release, ca khi tuan dau thieu ngay', async () => {
  const { toWeeks, renderChart, THEMES } = await load();
  const weeks = toWeeks(days('2026-08-05', 15, () => 10));
  const svg = renderChart(
    {
      weeks,
      releases: [
        { version: '0.2.0', date: '2026-08-05' },
        { version: '0.3.0', date: '2026-08-18' },
      ],
      updated: '2026-08-19',
    },
    THEMES.light,
  );

  assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Tuan dau chi co 1 ngay: khong ve cot, nhung van tinh vao tong.
  assert.strictEqual(svg.match(/<rect [^>]*rx="2"/g).length, 2);
  assert.match(svg, /150 total/);
  assert.match(svg, />v0\.2\.0</);
  assert.match(svg, />v0\.3\.0</);
});

test('renderChart khong co du lieu thi bao ro, va escape ky tu dac biet', async () => {
  const { renderChart, THEMES } = await load();
  const svg = renderChart({ weeks: [], releases: [], updated: '<x>' }, THEMES.dark);

  assert.match(svg, /No downloads recorded yet/);
  assert.ok(!svg.includes('<x>'));
});
