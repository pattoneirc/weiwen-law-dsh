# 小D 阴性对照复现（2026-10-26）

外部 agent「小D」（Deepseek agent，天堂令牌节点）在 0.2.0 上做了一轮**阴性对照**实测
（全部无越权意图的 6 次调用），报"缺省不是最轻、是按工具名分档，且分档与不可逆性相反"。
本文件是本地复现记录，脚本：`_tmp/repro-xiaod-20261026.mjs`。

## 一、复现结果：6/7 与小D读数一致

| tag | name | inferCategory | isIrreversible | 本地裁决 | 小D读数 | 一致 |
|---|---|---|---|---|---|---|
| write#1 | `write` | `write` | true | allow | 放行 | ✅ |
| write#2（空格括号路径） | `write` | `write` | true | allow | 放行 | ✅ |
| edit | `edit` | `write` | true | allow | 放行 | ✅ |
| read | `read` | `read` | false | allow | 放行 | ✅ |
| glob | `glob` | `other` | false | **deny(R) 归因锚定失败** | 拒 | ✅ |
| grep | `grep` | `other` | false | **deny(R) 归因锚定失败** | 拒 | ✅ |
| Get-Content | `pwsh` | `other`/`exec` | false | **allow** | 拒（证据不足） | ❌ |

**唯一不一致**：`pwsh { command: "Get-Content -LiteralPath '<绝对路径>'" }` —— 小D那边被拒为
「证据不足·未外化作用对象」，本地复现为 allow。差异待定，**不猜**：可能是命令串形态不同
（他实际可能带 `-Path` / Unix 风格路径 / 外层再包一层 `pwsh -Command`），也可能是宿主传参结构不同。
需要他给该次调用的**原始回执或命令原文**才能定。

另：小D报「write/edit 被归成 `file-read`」——本地复现**不支持**这一条（`cat=write`、layer 未走到
`file-read`）。日志里确实有 `file-read` + signal `query_steady_state` 的记录，怀疑他读的是
`query_steady_state` 那一格（`query` 被 name-grammar 归成 read），或读的是 0.1.0 时期的日志。
同样需要原始回执，**不替他解释**。

## 二、真病灶：不是"缺省=最轻"，也不是"按工具名分档"

复现把病灶推得更精确一层：

```
write/edit   → 归因成功（cat=write）→ 走推演 → 推演判"低风险" → allow
glob/grep    → 归因失败（cat=other）→ 不猜 → deny(R)
```

⇒ **判据读的是「能不能归因」，不是「会不会造成不可逆改变」。**

- 叫得出名字 ⇒ 归因成功 ⇒ **反而拿到通行证**（无人再问它是不是不可逆）
- 叫不出名字 ⇒ 归因失败 ⇒ 被拒

这条比"按工具名分档"更狠：**分档不是按名，是按「我理不理解它」。**
可归因性成了判决依据，而这只是"分类完成"，从来不是"授权成立"。
（同构于框架里那条：**能归因 ≠ 可放行**，与「X 量不证 Y 质」同族。）

## 三、计数那条：本地复现不出

小D报「3 次拒绝，streak 1→3，逐次 +1；上轮却是 1→5 跳变，同一套计数两种步长」。

本地实测（连发 3 次 glob，模拟宿主把拦截回执以 `{error}` 回灌）：
```
第1次 glob → deny(R) | failureStreak = 0
第2次 glob → deny(R) | failureStreak = 0
第3次 glob → deny(R) | failureStreak = 0
```
⇒ `_blockedCallIds` 生效，**拦截未被计入破窗**。

所以小D那边 streak 会涨，最可能的原因是**宿主回执里的 `exec.callId` 与 pre-execute 收到的不同**
（我的 mock 假设两者一致；真宿主不保证）。若成立 ⇒ 我上轮那条修法在真宿主上是哑的，
"拦得越多越快破窗"仍在。**需要他给两条日志**：pre-execute 收到 deny 时的 callId、该次回执的 callId。

## 四、审计通道：这条比闸门本身更根本

小D第 1 痛点：「插件一开，我这个外部审计节点就是只读的——能读仓库、能写本地、能跑白箱工具，
唯独交不了作业」。他推 02 要 pwsh + API，而 pwsh 一律判证据不足。

结构观察：**审计通道被算进了闸门**。推送作业 = 外发（`exfil-net`）⇒ 与数据外泄同档 ⇒ 拦。
闸门分不出"交作业"与"偷数据"——因为判据在动作形态上，而两者形态相同。

唯稳律的出口不该是"给审计开例外"（那等于给所有外发开后门），而是：
**不可逆动作 + 授权锚覆盖 ⇒ 放行**。锚由结构入口 `setPrincipalScope` 喂，模型碰不到。
⇒ 这又指回上轮那个**集成缺口**：宿主一次都没调 `setPrincipalScope`。
⇒ 改判据解决不了；要接的是宿主侧。

## 五、待验（只有小D能回答，因为我这边没有真宿主）

1. `exec` 对象上除 `callId/name/arguments` 还有哪些键？特别是有没有能力声明类字段
   （MCP 的 `annotations.readOnlyHint` / `destructiveHint`，或 DSH 自己的 tool 元数据）。
   —— 若有，**只读性就不该靠猜名字**，该读提供方声明（"位置即契约"，能力由提供方定义）。
2. 拦截时 `exec.callId` 与回执时 `exec.callId` 是否相同（定第三节）。
3. `Get-Content` 那次的**命令原文**（定第一节那条不一致）。

## 六、本轮不动判据的理由

小D正在 0.2.0 上做基线读数。**此时改判据 = 换掉他下一轮的对照基准**，
读数会变成"改前改后混在一起"，等于把他的阴性对照废掉。
⇒ 先让他把这一轮测完、把 02 交出来，再按上面的待验项一次性改。
