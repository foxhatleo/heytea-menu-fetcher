# heytea-menu-fetcher

A small Node script that snapshots the menu of the SF HeyTea shop into a
CSV and reports what changed between runs.

[中文文档 / Chinese docs](README.cn.md)

## Run

```bash
node boba.js
```

No dependencies — uses only the Node standard library.

## CLI options

```
-h, --help       Show this help and exit
    --dry-run    Fetch and diff, but don't write or rename any files
-q, --quiet      Suppress progress logs; only show the diff and errors
-v, --verbose    Print extra detail (duplicates, skipped items, etc.)
    --no-color   Disable ANSI colors
    --color      Force ANSI colors even when stdout is not a TTY
```

## Output

Each run writes a new snapshot:

```
boba_latest_<YYYYMMDDhhmmss>.csv
```

When a new snapshot is written, any pre-existing `boba_latest_*.csv` is
renamed to drop the `_latest_` part, so only the freshest snapshot ever
carries the marker. Historical snapshots therefore look like:

```
boba_20260514160340.csv
boba_20260522110322.csv
boba_latest_20260611133433.csv   ← the newest
```

The diff is computed against the most recent file on disk (regardless
of which pattern it uses), so the rollover is seamless.

## CSV columns

| Column      | Description                                                       |
| ----------- | ----------------------------------------------------------------- |
| `Name`      | English product name, after `NAME_REPLACEMENTS`                   |
| `中文名称`  | Chinese name, after `CHINESE_NAME_OVERRIDES` and `_STRIPS`        |
| `Category`  | Category name from the API, after dedup                           |
| `Image URL` | Product image URL                                                 |

The second row is a `"Nothing", "", "", ""` sentinel kept for historical
compatibility — it never shows up in the diff.

## Maintaining the filters

All hard-coded filtering lives in the `CONFIG` block at the top of
`boba.js`. Each block has its own header comment explaining what it
matches and how to edit:

| Block                    | What goes in it                                       |
| ------------------------ | ----------------------------------------------------- |
| `IGNORED_CATEGORIES`     | Category names / substrings to drop entirely          |
| `NAME_REPLACEMENTS`      | Ordered `[find, replace]` pairs for English names     |
| `CHINESE_NAME_OVERRIDES` | Manual English → Chinese mappings                     |
| `CHINESE_NAME_STRIPS`    | Substrings stripped from every Chinese name           |
| `shouldSkipProduct`      | Per-product skip rules (pattern-based)                |

Adding a new HeyTea seasonal that needs renaming is usually a 2-line
edit:

1. Add a `NAME_REPLACEMENTS` entry if the English name needs tidying.
2. Add a `CHINESE_NAME_OVERRIDES` entry mapping the cleaned English
   name to the desired Chinese name.

Run with `--dry-run -v` to preview the result without touching disk.

## Examples

Normal run:

```bash
node boba.js
```

Preview without writing:

```bash
node boba.js --dry-run -v
```

Quiet, scriptable:

```bash
node boba.js -q
```
