// Ve bieu do luot tai npm theo tuan thanh SVG cho README, ban sang va ban toi.
//
// Chay boi .github/workflows/stats.yml: ket qua day len nhanh `stats`, README nhung
// anh tu raw.githubusercontent.com. Khong dung dependency nao, nen workflow khong
// can `npm ci` va khong keo goi la nao vao job co quyen ghi repo.
//
// Chay tay: node scripts/download-chart.mjs <thu-muc-ra>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PACKAGE = '@trickstarcandina/discordjs-selfbot';
const DAY = 86_400_000;
// API range cua npm chi tra toi da 18 thang moi lan goi.
const MAX_RANGE_DAYS = 540;

// Mau lay theo bang mau cua GitHub de anh hop voi trang README o ca hai che do.
export const THEMES = {
  light: {
    background: '#ffffff',
    border: '#d1d9e0',
    text: '#1f2328',
    muted: '#59636e',
    grid: '#eff2f5',
    bar: '#cb3837',
    release: '#5865f2',
  },
  dark: {
    background: '#0d1117',
    border: '#3d444d',
    text: '#f0f6fc',
    muted: '#9198a1',
    grid: '#21262d',
    bar: '#f85149',
    release: '#8b9cff',
  },
};

const WIDTH = 800;
const HEIGHT = 320;
const PLOT = { left: 56, right: 24, top: 76, bottom: 40 };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const compact = new Intl.NumberFormat('en', { notation: 'compact' });
const full = new Intl.NumberFormat('en');
const monthName = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' });

/**
 * Gom luot tai theo ngay thanh tung tuan, tinh nguoc tu ngay cuoi.
 * Tuan cuoi luon tron 7 ngay; tuan dau co the thieu.
 * @param {Array<{day: string, downloads: number}>} days Luot tai theo ngay, tang dan
 * @returns {Array<{start: string, end: string, downloads: number}>}
 */
export function toWeeks(days) {
  const weeks = [];
  for (let end = days.length; end > 0; end -= 7) {
    const chunk = days.slice(Math.max(0, end - 7), end);
    weeks.unshift({
      start: chunk[0].day,
      end: chunk.at(-1).day,
      downloads: chunk.reduce((sum, day) => sum + day.downloads, 0),
    });
  }
  return weeks;
}

/**
 * Buoc chia truc tung tron (1, 2, 5 x 10^n) de `divisions` buoc phu duoc `max`.
 * @param {number} max Gia tri lon nhat can ve
 * @param {number} [divisions=4] So khoang tren truc
 * @returns {number}
 */
export function niceStep(max, divisions = 4) {
  const raw = Math.max(max / divisions, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find(step => step * power >= raw) * power;
}

/**
 * @param {string} text Chuoi
 * @returns {string}
 */
function escape(text) {
  return String(text).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/**
 * @param {string} day Ngay dang YYYY-MM-DD
 * @returns {number}
 */
function time(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Ve bieu do thanh SVG.
 * @param {Object} stats Du lieu
 * @param {Array<{start: string, end: string, downloads: number}>} stats.weeks Luot tai theo tuan
 * @param {Array<{version: string, date: string}>} stats.releases Cac ban da publish
 * @param {string} stats.updated Ngay cua du lieu moi nhat
 * @param {Object} theme Mot gia tri trong THEMES
 * @returns {string}
 */
export function renderChart({ weeks: allWeeks, releases, updated }, theme) {
  const total = allWeeks.reduce((sum, week) => sum + week.downloads, 0);
  // Tuan dau thuong thieu ngay (goi publish giua tuan): cot thap le te trong nhu
  // luot tai giam. Bo cot do, nhung van tinh vao tong.
  const weeks =
    allWeeks.length > 1 && time(allWeeks[0].end) - time(allWeeks[0].start) < 6 * DAY ? allWeeks.slice(1) : allWeeks;
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const bottom = PLOT.top + plotHeight;
  const parts = [];

  parts.push(
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="6" fill="${theme.background}" stroke="${theme.border}"/>`,
    `<text x="${PLOT.left - 32}" y="32" font-size="16" font-weight="600" fill="${theme.text}">npm downloads per week</text>`,
    `<text x="${PLOT.left - 32}" y="54" font-size="12" fill="${theme.muted}">${escape(
      `${full.format(total)} total · ${PACKAGE} · updated ${updated}`,
    )}</text>`,
  );

  if (!weeks.length) {
    parts.push(
      `<text x="${WIDTH / 2}" y="${PLOT.top + plotHeight / 2}" font-size="13" text-anchor="middle" fill="${
        theme.muted
      }">No downloads recorded yet</text>`,
    );
    return wrap(parts);
  }

  // Truc tung va luoi ngang.
  const max = Math.max(...weeks.map(week => week.downloads), 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = value => bottom - (value / top) * plotHeight;
  for (let value = 0; value <= top; value += step) {
    parts.push(
      `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${y(value)}" y2="${y(value)}" stroke="${theme.grid}"/>`,
      `<text x="${PLOT.left - 8}" y="${y(value) + 4}" font-size="11" text-anchor="end" fill="${
        theme.muted
      }">${compact.format(value)}</text>`,
    );
  }

  // Truc hoanh theo thoi gian, de vach release roi dung ngay chu khong dung cot.
  const t0 = time(weeks[0].start);
  const t1 = time(weeks.at(-1).end) + DAY;
  const x = t => PLOT.left + ((t - t0) / (t1 - t0)) * plotWidth;

  for (const week of weeks) {
    const left = x(time(week.start));
    const width = x(time(week.end) + DAY) - left;
    const gap = Math.min(2, width * 0.15);
    parts.push(
      `<rect x="${(left + gap).toFixed(1)}" y="${y(week.downloads).toFixed(1)}" width="${Math.max(
        width - gap * 2,
        1,
      ).toFixed(1)}" height="${(bottom - y(week.downloads)).toFixed(1)}" rx="2" fill="${theme.bar}">` +
        `<title>${escape(`${week.start} – ${week.end}: ${full.format(week.downloads)}`)}</title></rect>`,
    );
  }

  // Nhan thang, bo bot neu qua sat nhau.
  let lastLabel = -Infinity;
  const first = new Date(t0);
  for (
    let month = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
    month < t1;
    month = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1)
  ) {
    const at = x(month);
    if (at - lastLabel < 48) continue;
    lastLabel = at;
    const date = new Date(month);
    const label =
      date.getUTCMonth() === 0 ? `${monthName.format(date)} ${date.getUTCFullYear()}` : monthName.format(date);
    parts.push(
      `<line x1="${at}" x2="${at}" y1="${bottom}" y2="${bottom + 4}" stroke="${theme.muted}"/>`,
      `<text x="${at}" y="${bottom + 18}" font-size="11" text-anchor="middle" fill="${theme.muted}">${label}</text>`,
    );
  }
  parts.push(
    `<line x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${bottom}" y2="${bottom}" stroke="${theme.border}"/>`,
  );

  // Vach release. Nhan xep hai hang de hai ban sat ngay nhau khong de chu len nhau.
  const rows = [-Infinity, -Infinity];
  for (const release of releases) {
    const date = time(release.date);
    if (date < time(allWeeks[0].start) || date >= t1) continue;
    // Ban ra trong tuan dau da bi bo thi dinh vao mep trai.
    const at = Math.max(x(date), PLOT.left);
    parts.push(
      `<line x1="${at}" x2="${at}" y1="${PLOT.top - 6}" y2="${bottom}" stroke="${theme.release}" stroke-dasharray="3 3"/>`,
    );
    const row = rows.findIndex(last => at - last > 56);
    if (row === -1) continue;
    rows[row] = at;
    // Sat mep phai thi dat nhan ben trai vach de khong bi cat.
    const left = at > WIDTH - PLOT.right - 48;
    parts.push(
      `<text x="${left ? at - 4 : at + 4}" y="${PLOT.top - 6 + row * 13}" font-size="11" font-weight="600" ` +
        `text-anchor="${left ? 'end' : 'start'}" fill="${theme.release}">${escape(`v${release.version}`)}</text>`,
    );
  }

  return wrap(parts);
}

/**
 * @param {string[]} parts Cac phan tu SVG
 * @returns {string}
 */
function wrap(parts) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `font-family="${FONT}" role="img" aria-label="npm downloads per week">\n${parts.join('\n')}\n</svg>\n`
  );
}

/**
 * @param {string} url Dia chi
 * @returns {Promise<Object>}
 */
async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Lay luot tai va ngay publish tung ban tu npm.
 * @param {string} [pkg=PACKAGE] Ten goi
 * @param {Date} [now=new Date()] Thoi diem hien tai
 * @returns {Promise<Object>} Du lieu cho renderChart
 */
export async function fetchStats(pkg = PACKAGE, now = new Date()) {
  const registry = await getJson(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`);
  // Hom nay chua het ngay, so lieu chua du.
  const end = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
  const earliest = new Date(time(end) - MAX_RANGE_DAYS * DAY).toISOString().slice(0, 10);
  const created = registry.time.created.slice(0, 10);
  const start = created > earliest ? created : earliest;

  const { downloads } = await getJson(`https://api.npmjs.org/downloads/range/${start}:${end}/${pkg}`);
  const releases = Object.keys(registry.versions)
    .filter(version => registry.time[version])
    .map(version => ({ version, date: registry.time[version].slice(0, 10) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { weeks: toWeeks(downloads), releases, updated: downloads.at(-1)?.day ?? end };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] ?? 'stats';
  mkdirSync(out, { recursive: true });
  const stats = await fetchStats();
  for (const [name, theme] of Object.entries(THEMES)) {
    writeFileSync(join(out, `downloads-${name}.svg`), renderChart(stats, theme));
  }
  const total = stats.weeks.reduce((sum, week) => sum + week.downloads, 0);
  console.log(`${PACKAGE}: ${stats.weeks.length} tuan, ${total} luot tai, ghi vao ${out}/`);
}
