# dsh-scalpel

DeepSeek Harness 的**上下文手术刀**。只做两件事：

1. **同会话对比** —— 在同一个会话里，把两条 assistant 回答并排看，段落级对齐 + 词级高亮。
2. **同会话删除指定内容** —— 把指定的若干**轮**从之后每一次发给模型的请求里剔除（会话文件和界面不动）。

## 为什么删除只能这样删

会话是 append-only 事件日志，历史改不了。任何"删消息"最终都只能作用在**发给模型的副本**上：

- 本插件挂在宿主的 `agent/pre-step` 上，改写本轮 `messages` 后再放行；
- 规则按 **sessionId + 轮号区间**存在 `~/.dsh/scalpel-drop.json`；
- 每轮都会重新读规则文件，改规则不用重启；
- 审计写 `~/.dsh/scalpel-audit.jsonl`，能查每轮到底摘了几条、省了多少字符。

已知代价（不是 bug）：

- 界面和会话记录仍是原样，别人看会话还是能看到那段。
- 前缀一变，prompt cache 冷一次。
- 只按**整轮**切，不拆单条消息 —— 这样 `tool_use` / `tool_result` 永远成对，不会 400。

## 规则文件

```jsonc
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "dropTurns": [[5, 7]],   // 剔除第 5~7 轮（轮 = 一条用户消息开始的一段）
      "dryRun": false          // true 时只写审计，不改 messages
    }
  }
}
```

永远不剔除**当前正在回答的那一轮**，避免把模型逼到无话可接。

## 安装（本地开发）

```sh
# 1. 链接进 profile
mklink /J "C:\Users\4399\.dsh\profiles\desktop\node_modules\dsh-scalpel" "C:\Users\4399\.dsh\local-plugins\dsh-scalpel"

# 2. 把 "dsh-scalpel" 加进 profile package.json 的 dsh.profile.bundles

# 3. 重启 DSH
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半：pre-step 过滤、规则读写、审计、首轮探针 |
| `lib/compare-core.js` | 纯函数对比核心（分块 / LCS 对齐 / 词级 diff），宿主与浏览器共用 |
| `client.js` | 客户端半：动作行按钮、对比面板、选轮删除 |
| `cordis.patch.yml` | 挂载入口 |

`~/.dsh/scalpel-probe.json` 是首轮自动写出的探针，用来记录 pre-step 载荷里 sessionId 到底挂在哪个字段。