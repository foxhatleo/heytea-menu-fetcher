# heytea-menu-fetcher

一个小型 Node 脚本,把旧金山喜茶门店的菜单快照成 CSV,
并报告每次运行之间的差异。

[English docs / 英文文档](README.md)

## 运行

```bash
node boba.js
```

无需任何依赖,只使用 Node 标准库。

## 命令行选项

```
-h, --help       显示帮助
    --dry-run    抓取并比较差异,但不写文件、不做重命名
-q, --quiet      只输出差异和错误,屏蔽进度日志
-v, --verbose    打印更多细节(重复项、被跳过的商品等)
    --no-color   关闭 ANSI 颜色
    --color      即使不在 TTY 也强制启用 ANSI 颜色
```

## 输出

每次运行都会写一份新快照:

```
boba_latest_<YYYYMMDDhhmmss>.csv
```

写入新快照前,已有的 `boba_latest_*.csv` 会被重命名 —— 去掉
`_latest_` 这段,保证只有最新的一份带这个标记。历史快照看起来像:

```
boba_20260514160340.csv
boba_20260522110322.csv
boba_latest_20260611133433.csv   ← 最新的一份
```

差异比较的对象是磁盘上最近的快照(不论它带不带 `_latest_`),
所以滚动切换是无缝的。

## CSV 列

| 列名        | 说明                                                       |
| ----------- | ---------------------------------------------------------- |
| `Name`      | 英文商品名,经过 `NAME_REPLACEMENTS` 清洗                  |
| `中文名称`  | 中文名,经过 `CHINESE_NAME_OVERRIDES` 与 `_STRIPS`         |
| `Category`  | API 返回的分类名,去重后                                   |
| `Image URL` | 商品图片 URL                                               |

第二行是 `"Nothing", "", "", ""` 占位行,留作历史兼容 ——
它不会出现在差异输出中。

## 维护过滤规则

所有硬编码的过滤逻辑都集中在 `boba.js` 顶部的 `CONFIG` 区块。
每个小节都有自己的注释,说明它匹配什么、怎么修改:

| 小节                     | 应该放什么                                            |
| ------------------------ | ----------------------------------------------------- |
| `IGNORED_CATEGORIES`     | 要整类丢弃的分类名(子串匹配)                        |
| `NAME_REPLACEMENTS`      | 应用于英文名的有序 `[find, replace]` 替换对           |
| `CHINESE_NAME_OVERRIDES` | 人工的"英文 → 中文"映射                               |
| `CHINESE_NAME_STRIPS`    | 从所有中文名中剥掉的子串                              |
| `shouldSkipProduct`      | 单个商品的跳过规则(模式匹配)                        |

新增一款需要改名的喜茶季节限定,通常只要两步:

1. 如果英文名需要清洗,加一条 `NAME_REPLACEMENTS`。
2. 把清洗后的英文名映射到目标中文,加一条
   `CHINESE_NAME_OVERRIDES`。

用 `--dry-run -v` 可以预览结果而不动磁盘。

## 示例

正常运行:

```bash
node boba.js
```

预览,不写文件:

```bash
node boba.js --dry-run -v
```

安静模式,适合脚本调用:

```bash
node boba.js -q
```
