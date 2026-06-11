#!/usr/bin/env node
//
// boba.js — fetch the HeyTea menu and track changes over time.
// boba.js —— 抓取喜茶菜单,追踪每次变化。
//
// Each run / 每次运行:
//   1. Fetches the live menu from the HeyTea API.
//      从喜茶 API 拉取实时菜单。
//   2. Normalizes & filters items per the CONFIG section.
//      按下方 CONFIG 区块的规则做清洗和过滤。
//   3. Diffs against the most recent snapshot on disk.
//      与磁盘上最近的快照做差异比较。
//   4. Writes a new snapshot as ./boba_latest_<YYYYMMDDhhmmss>.csv
//      写入新快照 ./boba_latest_<YYYYMMDDhhmmss>.csv
//   5. Renames any prior boba_latest_*.csv to drop "_latest_",
//      so only the newest snapshot ever wears that marker.
//      将旧的 boba_latest_*.csv 重命名,去掉 "_latest_",
//      保证只有最新的一份带这个标记。
//
// Run `node boba.js --help` for CLI options.
// 运行 `node boba.js --help` 查看命令行选项。
//

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

// ============================================================================
// CLI / 命令行参数
// ============================================================================

const HELP_TEXT = `boba.js — fetch the HeyTea menu and track changes over time.

USAGE
  node boba.js [options]

OPTIONS
  -h, --help       Show this help and exit
      --dry-run    Fetch and diff, but don't write or rename any files
  -q, --quiet      Suppress progress logs; only show the diff and errors
  -v, --verbose    Print extra detail (duplicates, skipped items, etc.)
      --no-color   Disable ANSI colors
      --color      Force ANSI colors even when stdout is not a TTY

OUTPUT
  Writes the new snapshot to:
      ./boba_latest_<YYYYMMDDhhmmss>.csv
  Any pre-existing boba_latest_*.csv is renamed to drop the "_latest_" so
  that only one file at a time carries that marker.

EXAMPLES
  node boba.js                 # normal run
  node boba.js --dry-run -v    # preview changes without writing
  node boba.js -q              # quiet, scriptable output
`;

// Parse process.argv into a FLAGS object. Unknown args exit with code 2.
// 把 process.argv 解析为 FLAGS 对象。未知参数会以退出码 2 终止。
function parseArgs(argv) {
  const flags = {
    dryRun: false,
    quiet: false,
    verbose: false,
    // null = auto-detect from TTY / null 表示按 TTY 自动判断
    color: null,
    help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '-h': case '--help':    flags.help = true; break;
      case '--dry-run':            flags.dryRun = true; break;
      case '-q': case '--quiet':   flags.quiet = true; break;
      case '-v': case '--verbose': flags.verbose = true; break;
      case '--no-color':           flags.color = false; break;
      case '--color':              flags.color = true; break;
      default:
        process.stderr.write(
          `boba.js: unknown argument "${arg}"\n` +
          `Run with --help for usage.\n`,
        );
        process.exit(2);
    }
  }
  return flags;
}

const FLAGS = parseArgs(process.argv.slice(2));

if (FLAGS.help) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

// ============================================================================
// LOGGER (colors + log levels) / 日志(带颜色与级别)
// ============================================================================

const USE_COLOR =
  FLAGS.color ?? (process.stdout.isTTY && !process.env.NO_COLOR);

const C = {
  reset:  USE_COLOR ? '\x1b[0m'  : '',
  bold:   USE_COLOR ? '\x1b[1m'  : '',
  dim:    USE_COLOR ? '\x1b[2m'  : '',
  red:    USE_COLOR ? '\x1b[31m' : '',
  green:  USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan:   USE_COLOR ? '\x1b[36m' : '',
  gray:   USE_COLOR ? '\x1b[90m' : '',
};

const paint = (color, text) => `${C[color]}${text}${C.reset}`;

const log = {
  info: (msg) => {
    if (FLAGS.quiet) return;
    process.stdout.write(`${paint('cyan', '›')} ${msg}\n`);
  },
  ok: (msg) => {
    if (FLAGS.quiet) return;
    process.stdout.write(`${paint('green', '✓')} ${msg}\n`);
  },
  warn:  (msg) => process.stderr.write(`${paint('yellow', '⚠')} ${msg}\n`),
  error: (msg) => process.stderr.write(`${paint('red',    '✗')} ${msg}\n`),
  hint:  (msg) => process.stderr.write(`  ${paint('gray', msg)}\n`),
  verbose: (msg) => {
    if (!FLAGS.verbose) return;
    process.stdout.write(`  ${paint('gray', `· ${msg}`)}\n`);
  },
  blank: () => {
    if (!FLAGS.quiet) process.stdout.write('\n');
  },
  // diff output is always shown / 差异内容始终输出
  diff: (msg) => process.stdout.write(`${msg}\n`),
};

// ============================================================================
// CONFIG / 配置
// ============================================================================
//
// Everything that changes when HeyTea shuffles their menu lives here.
// Each block explains what it filters and why; tweak the lists rather
// than the code below.
//
// 喜茶菜单调整时需要改的内容都集中在本区块。每个小节都说明了
// 它过滤了什么以及为什么。改行为时直接编辑下面的列表 / 映射,
// 一般不必动后面的代码。
//

// The live menu API for the SF HeyTea shop (shopId=1000092).
// `menuType=0` and `isTakeaway=0` request the dine-in, full-menu view.
// 旧金山喜茶门店 (shopId=1000092) 的菜单接口。
// menuType=0、isTakeaway=0 表示堂食 + 完整菜单视图。
const API_URL =
  'https://app-us.heytea-co.com/api/service-menu/grayapi/app/shop/categories' +
  '?shopId=1000092&menuType=0&isTakeaway=0';

// Where snapshots are written and where prior snapshots are read from.
// 写入新快照、读取旧快照的目录。
const OUTPUT_DIR = '.';

// Filename patterns. 14 digits = YYYYMMDDhhmmss in America/Los_Angeles.
// Lexicographic sort = chronological sort.
// 文件名匹配。14 位数字 = America/Los_Angeles 时区下的
// YYYYMMDDhhmmss;按字典序排序就是按时间先后排序。
const LATEST_RE  = /^boba_latest_(\d{14})\.csv$/;
const ARCHIVE_RE = /^boba_(\d{14})\.csv$/;

// ----------------------------------------------------------------------------
// IGNORED_CATEGORIES — categories whose products we drop entirely.
// IGNORED_CATEGORIES —— 整类丢弃的分类(连带分类下所有商品)。
// ----------------------------------------------------------------------------
// Matched as a SUBSTRING against the trimmed API category name. So
// listing "Test" filters anything *containing* the word "Test".
//
// 用 SUBSTRING (子串) 与去空格后的分类名做匹配。例如把 "Test"
// 列进去,任何 *含* "Test" 的分类都会被过滤。
//
// To stop ignoring a category, delete its line. To add one, append a
// new line with a short comment explaining what it is.
// 想保留某个分类就删掉对应行;新增时请加一行简短注释说明它是什么。
const IGNORED_CATEGORIES = [
  // promo / one-off campaign items / 一次性活动促销商品
  'Activity products',
  // marketing rotation; dupes of real items / 营销轮播,与菜单重复
  'Hot Picks',
  // marketing rotation / 营销轮播
  'Staff Picks',
  // internal / pilot items / 内部 / 试点商品
  'Special projects',
  // toppings & add-ons, not drinks / 配料 / 加料,不是饮品
  'Extra',
  // "Super Plant Tea", CN-only seasonal line / 中文区季节限定
  '超级植物茶',
  // "Special Project Takeaway", delivery-only / 仅外卖的特殊项目
  '特殊项目外卖',
  // API-side test marker / API 端的测试标记
  '(T)',
  // test items / 测试商品
  'Test',
];

// ----------------------------------------------------------------------------
// NAME_REPLACEMENTS — tidy-ups applied to every English product name.
// NAME_REPLACEMENTS —— 对每个英文商品名做的清洗替换。
// ----------------------------------------------------------------------------
// Order-sensitive list of [find, replace] pairs. After they run, double
// spaces collapse and the name is trimmed.
// 顺序敏感的 [from, to] 替换对。全部跑完后会合并双空格、去掉首尾空白。
//
// Examples / 示例:
//   [' (Original)',  '']           "Foo Latte (Original)" → "Foo Latte"
//   [' Tea Latte',   ' Latte']     "Jasmine Tea Latte"    → "Jasmine Latte"
//   ['Jasmine Latte','Jasmine Milk Tea']   standardize that rename / 统一命名
const NAME_REPLACEMENTS = [
  [' (Original)',   ''],
  [' Tea Latte',    ' Latte'],
  ['Jasmine Latte', 'Jasmine Milk Tea'],
];

// ----------------------------------------------------------------------------
// CHINESE_NAME_OVERRIDES — English name → Chinese name for the 中文名称 col.
// CHINESE_NAME_OVERRIDES —— 英文名 → 中文名 的人工映射。
// ----------------------------------------------------------------------------
// We override the API's SKU name when:
//   (a) the API's Chinese name is missing or wrong,
//   (b) it carries marketing suffixes we strip elsewhere, or
//   (c) NAME_REPLACEMENTS collapsed two SKUs onto one English name and
//       we want a specific Chinese pairing.
//
// 在以下情况会覆盖 API 给出的中文 SKU 名:
//   (a) API 没有中文名或中文名不对,
//   (b) API 名中带营销后缀(例如 "(首创)"),
//   (c) NAME_REPLACEMENTS 把多个 SKU 合并到同一个英文名,
//       需要明确指定中文对应。
//
// Keys must match the English name AFTER NAME_REPLACEMENTS has run.
// Delete a row to fall back to the API's Chinese name.
// 键名必须是 NAME_REPLACEMENTS 处理之后的英文名。
// 删掉某一行就会回退到 API 自带的中文名。
const CHINESE_NAME_OVERRIDES = {
  'Fluffy Cloud Yumberry':              '厚芝芝多肉杨梅',
  'Fluffy Cloud Mango':                 '厚芝芝芒芒',
  'Fluffy Cloud Crisp Grape':           '厚芝芝多肉葡萄',
  'Fluffy Cloud Strawberry':            '厚芝芝莓莓',
  'Supreme Brown Sugar Bobo Milk Tea':  '烤黑糖波波真乳茶',
  'Supreme Brown Sugar Bobo Milk':      '烤黑糖波波牛乳',
  'Red Blossom Milk Tea':               '嫣红牛乳茶',
  'Mango Grapefruit Boom':              '轻芒芒甘露',
  'Coconut Mango Boom':                 '椰椰芒芒',
  'Cloud Crisp Grape':                  '轻芝多肉葡萄',
  'Crisp Grape Boom':                   '多肉葡萄',
  'Cloud Yumberry':                     '轻芝杨梅',
  'Yumberry Boom':                      '多肉杨梅',
  'Cloud Mulberry Strawberry':          '轻芝莓桑',
  'Mulberry Strawberry Boom':           '酷黑莓桑',
  'Mulberry Boom':                      '多肉黑桑',
  'Cloud Green Grape':                  '轻芝多肉青提',
  'Green Grape Boom':                   '多肉青提',
  'Cloud Mango':                        '轻芝芒芒',
  'Strawberry Boom':                    '多肉莓莓',
  'Passion Fruit Blast':                '超清爽百香绿',
  'Grapefruit Boom':                    '满杯红柚',
  'Cloud Coconut Blue':                 '抹云椰蓝',
  'Cloud Jasmine Tea':                  '芝芝绿妍茶后',
  'Jasmine Tea':                        '纯绿妍茶后',
  'Supreme Matcha Latte':               '千目抹茶',
  'Matcha Jasmine Latte':               '千目抹茉',
  'Cloud Matcha Latte':                 '芝芝抹茶',
  'Jasmine Milk Tea':                   '小奶茉',
  'Matcha Cloud Jasmine Latte':         '抹云小奶茉',
};

// ----------------------------------------------------------------------------
// CHINESE_NAME_STRIPS — substrings stripped from any Chinese name.
// CHINESE_NAME_STRIPS —— 任何中文名都会被剥掉的子串。
// ----------------------------------------------------------------------------
// Applied after the override lookup, to both API names and overrides.
// Right now it's just the "(首创)" marketing tag.
// 在 override 查找之后执行,既作用于 API 名也作用于 override 名。
// 目前只剥 "(首创)" 这个营销标签。
const CHINESE_NAME_STRIPS = ['(首创)'];

// ----------------------------------------------------------------------------
// shouldSkipProduct — drop individual products regardless of category.
// shouldSkipProduct —— 不分类别,单独丢弃的商品规则。
// ----------------------------------------------------------------------------
// A function rather than a list because the rules are pattern-based:
//   - "(Large Cup)" entries are size-variant duplicates of the real SKU.
//   - Names ending in "Set" are bundle / combo SKUs we don't track.
//
// 用函数而非列表,因为规则是模式匹配:
//   - 含 "(Large Cup)" 的是大杯版,会与正常 SKU 重复。
//   - 以 "Set" 结尾的是套餐 / 组合,不在追踪范围。
function shouldSkipProduct(name) {
  return name.includes('(Large Cup)') || name.endsWith('Set');
}

// ============================================================================
// HTTP / 网络请求
// ============================================================================

// GET `url` and return the parsed JSON body. Rejects on non-2xx status
// codes or unparseable responses.
// GET `url` 并返回解析后的 JSON。非 2xx 状态码或无法解析的响应
// 都会以 reject 抛出。
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      },
    };

    https.get(url, options, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Could not parse JSON response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ============================================================================
// CSV / CSV 读写
// ============================================================================

function escapeCSV(value) {
  if (typeof value !== 'string') return '';
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCSV(rows) {
  return rows.map((row) => row.map(escapeCSV).join(',')).join('\n');
}

// Tiny RFC-4180-ish CSV parser. Sufficient for our own output, not for
// arbitrary CSV input.
// 极简 CSV 解析器(近似 RFC 4180),够解析自己产出的文件,
// 不要拿去吃任意 CSV。
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    const cols = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    cols.push(current);
    rows.push(cols);
  }

  return rows;
}

// ============================================================================
// FILENAMES & TIMESTAMPS / 文件名与时间戳
// ============================================================================

// Current SF wall-clock time as YYYYMMDDhhmmss.
// 当前旧金山墙上时间,格式 YYYYMMDDhhmmss。
function sfTimestamp() {
  const sf = new Date(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
    }),
  );
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${sf.getFullYear()}${p(sf.getMonth() + 1)}${p(sf.getDate())}` +
    `${p(sf.getHours())}${p(sf.getMinutes())}${p(sf.getSeconds())}`
  );
}

// Human-readable label for a 14-digit timestamp, e.g. "2026-05-22 11:03 PT".
// 把 14 位时间戳格式化成易读样式,例如 "2026-05-22 11:03 PT"。
function formatTimestamp(ts) {
  if (!/^\d{14}$/.test(ts)) return ts;
  return (
    `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ` +
    `${ts.slice(8, 10)}:${ts.slice(10, 12)} PT`
  );
}

// Return { path, name, ts } for the most recent snapshot on disk, or null.
// Considers BOTH boba_latest_*.csv (the current marker) and the legacy
// boba_*.csv files, so the diff still works during/after the rollover.
// 返回磁盘上最新一个快照的 { path, name, ts },没有则返回 null。
// 同时考虑 boba_latest_*.csv(当前格式)与历史 boba_*.csv 文件,
// 在切换文件名规则前后,diff 都不会断。
function findPreviousSnapshot() {
  let files;
  try {
    files = fs.readdirSync(OUTPUT_DIR);
  } catch (e) {
    throw new Error(
      `Could not read directory "${OUTPUT_DIR}": ${e.message}`,
    );
  }

  const candidates = [];
  for (const f of files) {
    const m = f.match(LATEST_RE) || f.match(ARCHIVE_RE);
    if (m) candidates.push({ name: f, ts: m[1] });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.ts.localeCompare(b.ts));
  const newest = candidates[candidates.length - 1];
  return {
    path: path.join(OUTPUT_DIR, newest.name),
    name: newest.name,
    ts: newest.ts,
  };
}

// Rename any existing boba_latest_*.csv to drop the "_latest_" so only
// the file we are about to write carries that marker. Returns the list
// of renames performed.
// 把已有的 boba_latest_*.csv 重命名,去掉 "_latest_",保证只有
// 即将写入的新文件带这个标记。返回所做的重命名记录。
function archivePreviousLatest() {
  const files = fs.readdirSync(OUTPUT_DIR);
  const renames = [];
  for (const f of files) {
    if (!LATEST_RE.test(f)) continue;
    const archived = f.replace('boba_latest_', 'boba_');
    const src = path.join(OUTPUT_DIR, f);
    const dst = path.join(OUTPUT_DIR, archived);
    if (fs.existsSync(dst)) {
      log.warn(
        `Cannot archive ${f}: ${archived} already exists. ` +
        `Leaving as-is.`,
      );
      continue;
    }
    fs.renameSync(src, dst);
    renames.push({ from: f, to: archived });
  }
  return renames;
}

// ============================================================================
// DATA TRANSFORMATION / 数据清洗与结构化
// ============================================================================

function normalizeCategory(name) {
  return name.replace(/\s*\/\s*/g, ' / ');
}

function shouldSkipCategory(name) {
  return IGNORED_CATEGORIES.some((ignored) => name.includes(ignored));
}

function normalizeProductName(raw) {
  let name = raw;
  for (const [from, to] of NAME_REPLACEMENTS) {
    name = name.replaceAll(from, to);
  }
  return name.replaceAll('  ', ' ').trim();
}

function chineseName(englishName, product) {
  let raw =
    CHINESE_NAME_OVERRIDES[englishName] ||
    product.skus?.[0]?.name ||
    '';
  for (const strip of CHINESE_NAME_STRIPS) {
    raw = raw.replaceAll(strip, '');
  }
  return raw.trim();
}

function deduplicateCategories(raw) {
  const seen = new Map();
  for (const cat of raw) {
    const name = normalizeCategory((cat.name || '').trim());
    if (!seen.has(name)) seen.set(name, { ...cat, name });
  }
  return [...seen.values()];
}

function extractItems(apiData) {
  const rawCategories = apiData?.data?.categories || [];
  if (rawCategories.length === 0) {
    log.warn('API returned 0 categories — the shape may have changed.');
  }

  const categories = deduplicateCategories(rawCategories);
  const items = [];
  const seenNames = new Map();
  let skippedCategories = 0;
  let skippedProducts = 0;

  for (const category of categories) {
    if (shouldSkipCategory(category.name)) {
      skippedCategories++;
      log.verbose(`skip category: ${category.name}`);
      continue;
    }

    for (const product of category.products || []) {
      const name = normalizeProductName(product.name || '');
      if (shouldSkipProduct(name)) {
        skippedProducts++;
        log.verbose(`skip product: ${name}`);
        continue;
      }

      if (seenNames.has(name)) {
        log.warn(
          `Duplicate item "${name}" in "${category.name}" ` +
          `(also in "${seenNames.get(name)}")`,
        );
      } else {
        seenNames.set(name, category.name);
      }

      items.push({
        name,
        zhName: chineseName(name, product),
        category: category.name,
        imageUrl: product.list_image?.url || '',
      });
    }
  }

  const catWord  = skippedCategories === 1 ? 'y' : 'ies';
  const prodWord = skippedProducts === 1 ? '' : 's';
  log.verbose(
    `kept ${items.length} items; ` +
    `skipped ${skippedCategories} categor${catWord} and ` +
    `${skippedProducts} product${prodWord}`,
  );
  return items;
}

function itemsToRows(items) {
  const header  = ['Name', '中文名称', 'Category', 'Image URL'];
  const nothing = ['Nothing', '', '', ''];
  const dataRows = items.map(
    (i) => [i.name, i.zhName, i.category, i.imageUrl],
  );
  return [header, nothing, ...dataRows];
}

// ============================================================================
// DIFF / 差异比较
// ============================================================================

function buildItemMap(rows) {
  const map = new Map();
  // Skip header (row 0). Row 1 is the "Nothing" sentinel — harmless to
  // include since both sides have it and it never reports as changed.
  // 跳过表头(第 0 行)。第 1 行是 "Nothing" 占位,两边都有,
  // 不会被误判为变化。
  for (let i = 1; i < rows.length; i++) {
    const [name, , category] = rows[i];
    if (name !== undefined) map.set(name, category || '');
  }
  return map;
}

function computeDiff(oldRows, newRows) {
  const oldItems = buildItemMap(oldRows);
  const newItems = buildItemMap(newRows);

  const added = [];
  const removed = [];
  const moved = [];

  for (const [name, cat] of newItems) {
    if (!oldItems.has(name)) {
      added.push({ name, category: cat });
    } else if (oldItems.get(name) !== cat) {
      moved.push({ name, from: oldItems.get(name), to: cat });
    }
  }
  for (const [name] of oldItems) {
    if (!newItems.has(name)) removed.push(name);
  }

  const oldCats = new Set([...oldItems.values()].filter(Boolean));
  const newCats = new Set([...newItems.values()].filter(Boolean));

  return {
    added,
    removed,
    moved,
    addedCategories:   [...newCats].filter((c) => !oldCats.has(c)),
    removedCategories: [...oldCats].filter((c) => !newCats.has(c)),
  };
}

// "1 category" vs "2 categories" / 单复数辅助函数
function plural(n, one, many) {
  return n === 1 ? one : many;
}

function printDiff(previous, diff) {
  const { added, removed, moved, addedCategories, removedCategories } = diff;
  const tsLabel = previous.ts
    ? ` (${formatTimestamp(previous.ts)})`
    : '';

  const hasChanges =
    added.length || removed.length || moved.length ||
    addedCategories.length || removedCategories.length;

  log.diff('');
  if (!hasChanges) {
    log.diff(
      `${paint('green', '📋')} No changes since ` +
      `${paint('bold', previous.name)}${paint('gray', tsLabel)}.`,
    );
    return;
  }

  log.diff(
    `${paint('bold', '📋 Changes since')} ` +
    `${paint('bold', previous.name)}${paint('gray', tsLabel)}:\n`,
  );

  // Build a one-line summary like "+3 added  -1 removed  ~2 moved".
  // 构造一行汇总,例如 "+3 added  -1 removed  ~2 moved"。
  const summary = [];
  if (added.length) {
    summary.push(paint('green', `+${added.length} added`));
  }
  if (removed.length) {
    summary.push(paint('red', `-${removed.length} removed`));
  }
  if (moved.length) {
    summary.push(paint('yellow', `~${moved.length} moved`));
  }
  if (addedCategories.length) {
    const w = plural(addedCategories.length, 'category', 'categories');
    summary.push(paint('green', `+${addedCategories.length} new ${w}`));
  }
  if (removedCategories.length) {
    const w = plural(removedCategories.length, 'category', 'categories');
    summary.push(
      paint('red', `-${removedCategories.length} dropped ${w}`),
    );
  }
  log.diff(`  ${summary.join('   ')}\n`);

  if (addedCategories.length) {
    log.diff(`  ${paint('bold', 'New categories:')}`);
    for (const c of addedCategories) {
      log.diff(`    ${paint('green', '+')} ${c}`);
    }
    log.diff('');
  }
  if (removedCategories.length) {
    log.diff(`  ${paint('bold', 'Dropped categories:')}`);
    for (const c of removedCategories) {
      log.diff(`    ${paint('red', '-')} ${c}`);
    }
    log.diff('');
  }
  if (added.length) {
    log.diff(`  ${paint('bold', 'Added:')}`);
    for (const i of added) {
      log.diff(
        `    ${paint('green', '+')} ${i.name} ` +
        paint('gray', `[${i.category}]`),
      );
    }
    log.diff('');
  }
  if (removed.length) {
    log.diff(`  ${paint('bold', 'Removed:')}`);
    for (const n of removed) {
      log.diff(`    ${paint('red', '-')} ${n}`);
    }
    log.diff('');
  }
  if (moved.length) {
    log.diff(`  ${paint('bold', 'Moved:')}`);
    for (const i of moved) {
      log.diff(
        `    ${paint('yellow', '~')} ${i.name}: ` +
        paint('gray', `"${i.from}" → "${i.to}"`),
      );
    }
    log.diff('');
  }
}

// ============================================================================
// MAIN / 主流程
// ============================================================================

async function main() {
  log.info(
    `Fetching menu from ${paint('dim', new URL(API_URL).hostname)}…`,
  );
  const apiData = await fetchJSON(API_URL);

  const items = extractItems(apiData);
  log.ok(`Extracted ${paint('bold', String(items.length))} items.`);

  const rows = itemsToRows(items);

  const previous = findPreviousSnapshot();
  if (previous) {
    log.info(`Comparing with ${paint('bold', previous.name)}…`);
    let oldRows;
    try {
      oldRows = parseCSV(previous.path);
    } catch (e) {
      throw new Error(
        `Could not read previous snapshot ${previous.path}: ${e.message}`,
      );
    }
    printDiff(previous, computeDiff(oldRows, rows));
  } else {
    log.info('No previous snapshot found — this will be the first.');
  }

  const outputName = `boba_latest_${sfTimestamp()}.csv`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  if (FLAGS.dryRun) {
    log.blank();
    log.info(paint('dim',
      `Dry run — would write ${outputName} ` +
      `and archive any prior boba_latest_*.csv.`,
    ));
    return;
  }

  const archived = archivePreviousLatest();
  for (const r of archived) {
    log.ok(`Archived ${paint('dim', r.from)} → ${paint('dim', r.to)}`);
  }

  try {
    fs.writeFileSync(outputPath, rowsToCSV(rows), 'utf8');
  } catch (e) {
    throw new Error(`Could not write ${outputPath}: ${e.message}`);
  }

  log.ok(`Saved snapshot to ${paint('bold', outputPath)}.`);
}

// ============================================================================
// ENTRY / 入口
// ============================================================================

main().catch((err) => {
  log.error(err.message || String(err));

  // Friendly hints for common failure modes / 常见错误的友好提示
  const m = (err && err.message) || '';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|EAI_AGAIN/i.test(m)) {
    log.hint(
      'Network problem — check your connection or the HeyTea host.',
    );
  } else if (/HTTP \d{3}/i.test(m)) {
    log.hint(
      'API error status. Endpoint or shopId may have moved.',
    );
  } else if (/parse JSON/i.test(m)) {
    log.hint(
      'Non-JSON response — the endpoint shape may have changed.',
    );
  } else if (/EACCES|EPERM/i.test(m)) {
    log.hint(
      'Permission denied — check the output directory is writable.',
    );
  } else if (/ENOSPC/i.test(m)) {
    log.hint('Disk is full — free some space and try again.');
  }

  process.exit(1);
});
