# dsh-scalpel

DeepSeek Harness 的**上下文手术刀**。只做两件事：

1. **同会话对比** —— 同一个会话里前后两次（最多三次）回答，并排看，段落级对齐 + 词级高亮。
2. **同会话剔除** —— 把指定的若干**轮**从之后每一次发给模型的请求里摘掉；会话文件、界面、别人的视角都不动。

1.0 里还带上了：

- **真实用量**：每一条回答的 token 总量、未缓存输入、缓存读取/写入、输出和**缓存命中率**，左右并排对照；
- **三路对比 / 行级视图 / 折叠相同段**：左中右三列、并排或逐行、相同段收成一行；
- **按预算选删**：给定 200K/500K/1M 和保留最近几轮，自动算出该删哪段、删完还剩多少 tok，每一轮自己报「约多少 tok」；
- **规则可视化**：面板里直接看当前生效的剔除区间、一键应用/撤销（走插件宿主接口，不用回终端）。

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-8b5cf6)

---

## 效果

![对比面板](docs/preview.png)

> 三路对比的离线渲染（同 `client.js` 的真实组件与 CSS）：VS 头、指标表（字数 / 结构 / token 用量 / 缓存命中）、按段卡片；工具条可切「并排 / 行级」、折叠相同段。

## 为什么要"剔除"而不是"删除"

会话是 append-only 的事件日志。历史一旦落盘就不可改，任何"删消息"在 DSH 里都只能作用在**发给模型的那份副本**上：

- 本插件挂在宿主的 `agent/pre-step`，在这一轮 `messages` 组装完成、发出去之前改写它；
- 规则按 `sessionId + 轮号区间` 存在 `~/.dsh/scalpel-drop.json`，每轮重读，改规则**不用重启**；
- 每轮摘了几条、省了多少字符，写进 `~/.dsh/scalpel-audit.jsonl`。

两个容易踩的定义：

- **轮**从一条真人提问开始。工具返回（`role: "user"` + `tool_result` 块）不另起一轮，否则轮号会和面板、CLI 差一位。
- 宿主给的是 `session-<uuid>`，CLI 和面板用的是裸 `<uuid>`。两边都做了归一化，所以规则写哪种都能命中；旧文件里带前缀的写法也不会失效。

代价（是设计选择，不是 bug）：

| 现象 | 原因 |
| --- | --- |
| 界面和会话记录仍是原样 | 只改请求副本，真相源不碰 |
| 前缀一变，prompt cache 冷一次 | 上下文前段被改写，缓存键必然变 |
| 只能按**整轮**切，不能拆单条消息 | 保证 `tool_use` / `tool_result` 永远成对，不会 400 |
| 永远不剔除当前正在回答的那一轮 | 否则模型无话可接 |

## 安装

```sh
dsh plugin --profile desktop add dsh-scalpel
# 把 dsh.profile.bundles 里加上 "dsh-scalpel"，然后完全退出 DSH 再启动
```

本地开发（仓库就在本机）：

```sh
# 1) 把仓库链进 profile 的 node_modules
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-scalpel" "F:\centos\dsh-scalpel"

# 2) profile 的 package.json：dependencies 加 "dsh-scalpel": "link:../../local-plugins/dsh-scalpel"
#    并把 "dsh-scalpel" 写进 dsh.profile.bundles

# 3) 完全退出 DSH 再启动（bundle 是开机捕获的，刷新页面不生效）
```

> `~/.dsh/local-plugins/<name>/` **不会被自动扫描**，文件夹存在 ≠ 加载。必须走 profile 的依赖 + bundles 清单。

## 用法：对比

三个入口，同一套对齐算法：

| 入口 | 位置 | 适合 |
| --- | --- | --- |
| 顶部 **对比** tab | 会话视图切换栏 | 长时间并排看 |
| 每条回答的 **⚖ 对比** | assistant 消息动作行 | 从某条回答直接开面板 |
| `scalpel compare` | 终端 | 脚本、分享、`code --diff` |

面板里：左边选一条回答、右边选一条（还能加第三条），`⇄` 交换，`仅看差异` 关掉相同段。统计行给的是 `总段数 · 相同 · 改动 · 单侧`，下面按每条回答列 `用量 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 缓存命中`，VS 头也带一行 `X tok · 缓存命中 Y%`。

- **自动配对**：同一个问题问了两遍以上，下拉里直接有形如 `#3 × #9 · 那句问题` 的选项，点一下就把两次回答摆到左右；没有重复提问时默认选最近两条。
- **三路对比**：第三个选择器选一条，变成左/中/右三列，指标也变三列；以左列为轴对齐，中间列独有的段落标「仅中」。
- **并排 / 行级**：行级视图按侧竖排，带左/中/右色标；`折叠相同段` 把相同段落收成一行虚线摘要，点开看原文。
- **搜索**：输入关键词只留命中的段，命中处在行内高亮，统计行同时报 `命中 N 段`。
- **复制 Markdown**：把选中的两/三条回答 + 统计导成 md，粘到 issue / 文档 / 另一台机器继续 diff。

命令行：

```sh
scalpel sessions --limit 5                 # 最近的会话
scalpel turns latest                        # 这个会话有几轮
scalpel compare latest --a 1 --b 2          # 第 1 轮 vs 第 2 轮
scalpel compare latest --a 1 --b 2 --json   # 结构化输出，给别的工具吃
```

`<session>` 可以是**会话 id 前缀**、**文件路径**，或 `latest`。

## 用法：剔除

面板里也能做：顶部切到 **删除范围**，回合表里点两下行选一个区间，每一行自己报 `N 字 · 约 X tok`，头部报当前总量。选中后立刻显示「少多少字、省多少 tok、占全会话几成」。

- **按预算选删**：选目标 `200K / 500K / 1M` 和「保留最近几轮」，点一下自动算出该删 `#1–#K`，并预览删完还剩多少 tok；每轮 token 优先用相邻两轮 prompt 的实测差值，没有用量记录的轮按字数折算。
- **直接应用 / 撤销**：面板里的「已生效」区列出当前规则，「应用当前区间」写入规则、每条规则带 `×` 撤销、也可以「全部撤销」——不用回终端（宿主半边提供 `/dsh-scalpel/api/*` 本地接口）。命令行依旧可用。

```sh
scalpel drop latest --from 5 --to 7 --dry   # 只打印将写入的规则，不落盘
scalpel drop latest --from 5 --to 7         # 真摘
scalpel undrop latest                       # 全撤
scalpel rules                               # 当前规则
scalpel audit --limit 20                    # 每轮摘了几条
```

规则文件长这样：

```jsonc
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "dropTurns": [[5, 7]],   // 剔除第 5~7 轮；轮 = 一条用户消息开始的一段
      "dryRun": false          // true 时只写审计，不动 messages
    }
  }
}
```

## CLI 全部命令

```
scalpel sessions [--limit N]
scalpel turns <session|latest> [--json]
scalpel compare <session|latest> --a N --b M [--json]
scalpel drop <session|latest> --from N [--to M] [--dry]
scalpel undrop <session|latest> [--all]
scalpel rules
scalpel audit [--limit N]
scalpel doctor          # 装了但没生效时先用它
scalpel --version | --help
```

会话数据来自 `~/.dsh/sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd`（多帧 zstd，按 magic `28 B5 2F FD` 切帧解压，Node 22 内置 `zstdDecompressSync` 直接读，无第三方依赖）。

**大会话怎么读的**：逐帧解压、逐行解析，读完即弃；只留 12 类事件（`turn/start` `turn/end` `step/start` `step/end` `user/message` `assistant/message` `tool/call` `tool/result` `session` `session/title` `model/selection` `request/context`），工具入参截到 400 字、工具返回只留 callId、流式增量与每轮重复的完整工具表直接丢掉。本机实测：14.7 MB 的会话解出来峰值内存 ~101 MB、1 秒（不瘦身会是几百 MB，一次多读几个就 OOM）。

## 装了但没生效？

```
scalpel doctor
```

一次列出：Node 有没有 zstd、`exports["./client"]` 在不在、`dsh.client` 的 `platform/immediately` 对不对、`dsh.bundle.patch` 指的文件在不在、宿主半能不能 import、profile 里**依赖**和 **`dsh.profile.bundles`** 两处都写了没、`node_modules/dsh-scalpel` 的 realpath 是不是这一份、规则文件能不能解析、审计日志可写、探针多久没更新（探针是宿主半第一次跑 pre-step 时写的，没写说明它没被加载）。全部只读，有 fail 时退出码 1。

两个最常见的坑它直接点出来：**只加了依赖没加 `dsh.profile.bundles`**（宿主不加载，不报错）和 **bundle 是开机捕获的**（改完只刷新页面没用，探针时间戳会暴露这一点）。

## 什么时候**别**用它

- 想让模型"以后再也不提 B" —— 剔除只是让它看不见，你自己的会话里 B 还在。要彻底干净，请开新会话 + 交接稿。
- 想物理删除某段历史 —— 别直接改 `session.v4.jsonl.zstd`，会破坏 replay。真要删就整会话归档。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：pre-step 过滤、规则读写、审计、首轮探针 |
| `lib/compare-core.js` | 纯函数对比核心（分块 / LCS 对齐 / 词级 diff），宿主与浏览器共用 |
| `lib/session.js` | 会话文件解码与轮次提取 |
| `client.js` | 客户端半：对比 tab、⚖ 按钮、对比面板（对比 / 删除范围两种模式、自动配对、搜索、复制 Markdown） |
| `bin/scalpel.mjs` | CLI |
| `cordis.patch.yml` | 挂载入口 |

## 开发

无构建步骤：纯 ESM，`client.js` 是手写 bundle（不走 tsdown/tsc，`window.__ModuleLoader__` 包装）。

```sh
node --check client.js
node --check bin/scalpel.mjs
node bin/scalpel.mjs rules
npm test        # 宿主半：轮切分、区间钳制、dryRun、审计，用临时 HOME 跑真实 lib/index.js
```

`test/host.test.mjs` 会 `mkdtemp` 一个假 HOME、动态 `import` `lib/index.js`，再直接喂假的 `agent/pre-step` 事件，所以不用装 DSH 也能验行为。客户端半另有离线渲染检查：把 `client.js` 塞进桩化的 `window.__ModuleLoader__` + React hooks 里执行一遍，任何未定义变量都会在这里炸出来，不会跑到界面上变成空白页。

## Roadmap

v1 之前列的：

- ~~自动配对：同一问题问了两遍，自动把两次回答配成一对~~ ✓
- 话题分段：长会话按话题切开，可整段屏蔽
- ~~面板内的 dry-run 预览与一键撤销~~ ✓（预算选删 + 直接应用/撤销规则；命令仍可复制）
- `/compare` `/drop` 两个会话内命令（现在要回终端；面板只给命令文本）

从 [AgentActa](https://github.com/elegant01/agent-acta) 借来的（它是同类日志面板，这两条已经被证明有用）：

- ~~对比面板的指标行：token / cache 读取~~ ✓（用量、缓存读写、命中率已上）；耗时 / 模型 / 工具次数待做
- ~~上下文占用与删除报价~~ ✓（按预算自动选删；`request/context.data.contextWindow` 还没接）
- 单轮导出：把"将被摘掉的轮次"原文 + 解析结果 + 版本指纹导成 JSON，删除前留证据
- 全文搜索定位：不知道 B 是第几轮时，借 AgentActa 的索引（`127.0.0.1:14570/api/search`）找，没跑就退回按轮次序号

有意不搬的（都在它的 README 里）：历史归档冻结（DSH 的 session 文件本身就是真相源，再存一份是明文重复）、32 家 agent 解析器、慢轮排行与工具失败画像（那是日志分析，不是动上下文；本机已装 AgentActa 当 DSH 插件，重复建设）、SSE 流式双列对比（两边状态一乱就不可信）。子会话拓扑也先不做——本机 39 个会话头里只有 `delegationDepth`，全是 0，没有父链字段可读。

## License

MIT