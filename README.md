# dsh-session-rotate

上下文自动轮换插件：**精确读数 → 写交接（自动摘录）→ 整目录备份 → 新建会话迁移 → 归档旧会话**，把「一条会话吃到撑死」这件事从根上掐掉。

> **这个分支 = pro 版（0.4.0）**
> 比基础版多一个右下角的「水位 N%」胶囊：本机只读路由 `GET /api/session-rotate`，30 秒问一次，不走模型、不计 token。
> 轮换逻辑与 [`master`](../../tree/master)（基础版 0.3.1）**完全相同**；日常只装基础版，想要界面时切到这个分支装。

## 为什么需要

DSH 的会话是一条只增不减的事件日志，模型每走一步都会把前面的上下文重发一遍。billion-context 能折叠*已经聊过的部分*，但日志一旦长到接近窗口上限（今天那条约 175 万 tokens），连压缩请求自己都会超窗 —— 于是 `/compact` 报 "Compaction could not produce a useful summary"，会话彻底卡死，只能弃用。

唯一稳妥的办法：在撑爆之前把上下文搬到新会话，旧会话原样封存。

## 它做什么

每个 `intervalMs` 扫一遍 `~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd`：

| 阶段 | 触发 | 动作 |
|---|---|---|
| 粗估 | 每个会话 | 日志字节 × `tokensPerByte`（便宜，先挡一道） |
| 精确读数 | 日志 > `accurateScanMinBytes` | 解压全文，取最后一次 `usage.totalTokens`（当前水位）和最大值（历史峰值） |
| 提醒 | `warnTokens` | 只记一条 audit 日志 |
| 轮换 | 当前水位 ≥ `rotateTokens` **或** 历史峰值 ≥ `peakRotateTokens`，且会话已安静 `activeGraceMs` | 写交接 → 整目录备份 → 建新会话 → 塞交接消息 → 归档旧会话 |

两条判据为什么要并存：压缩成功的会话「当前水位」会掉下去，但它的**峰值**说明它已经压到极限、一次没压好就死锁——这种会话也该换掉。今天那条坏会话就是峰值 933K、当前 225K，看着没事，实际随时会死。

「安静」这一条同样关键：正在对话的会话文件一直在被写，插件不会去动它。实际行为是——**你停手 10 分钟后，超标的会话才会被换掉**，不打断正在进行的工作。

## 角落里的水位（0.3.0）

右下角一个很小的胶囊，显示 **水位 61%** —— 当前水位 / `rotateTokens`。点一下立刻刷新，鼠标停上去看细节（最近多少、峰值多少、门槛多少、换车还剩多少）。

- 读数走本机只读路由 `GET /api/session-rotate`（只允许 127.0.0.1，只允许 GET），每 30 秒问一次，不走模型、不计 token。
- 日志正在写、解压还没收尾时，数字前面会带一个 `≈`：那是按字节粗估的，等它安静下来就变准。
- 没有 `webServer` 的环境（SDK、离线测试）会自动跳过路由注册，不影响轮换本身。

## 交接文件长什么样

插件会解压日志，摘出这几节写进 `handoffs/<sid>-<ts>.md`：

- **用户最近说过什么**（最近 5 条，自动过滤运行时注入的噪声行）
- **助手最后说的话**
- **最近动过的文件**（从工具参数里抽路径，去重）
- **最近跑过的命令/工具**（工具名 + 描述/命令首行）

它是**机械摘录，不是模型总结**，所以交接文件的第三节明写了「动手前先跟用户确认」。这份东西的价值是让新会话在 30 秒内知道「刚在干什么、碰过哪些文件」，而不是替它编一份履历。

## 轮换前先试小切（precut）

装了 Live-Compact / billion-context 这类压缩器之后，可以打开 precut：

```yaml
precut:
  enabled: true
  service: liveCompact     # ctx 上的服务名
  method: compact          # 服务上的方法名
  timeoutMs: 90000
  acceptRatio: 0.85
```

触发轮换时先调它一次小切，然后重新读数；水位回落到 `rotateTokens × acceptRatio` 以下就**不轮换**，只记一笔「小切生效」。这样「换车」只留给真正压不动的场景。

服务名/方法名写错不会出事：找不到就记一行日志、跳过小切，继续正常轮换。

## 配置（`cordis.patch.yml` 里改）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `intervalMs` | `60000` | 扫描间隔 |
| `warnTokens` | `200000` | 提醒阈值 |
| `rotateTokens` | `350000` | 当前水位阈值（窗口 1048576，预留输出 256000，实际可用约 790000，350000 留足余量） |
| `peakRotateTokens` | `525000` | 历史峰值阈值：到过这里说明压缩已到极限 |
| `activeGraceMs` | `600000` | 多久没写才算「安静」 |
| `promptTimeoutMs` | `30000` | 投递开局消息用 `AbortSignal.timeout(ms)`；`prompt(request, signal)` 的 signal 必填，0.2.0 漏传会 `Cannot read properties of undefined (reading 'throwIfAborted')` |
| `tokensPerByte` | `0.112` | 字节 → token 的兜底系数（只有拿不到 usage 时才用；真实数据标定 15,598,487 字节 ≈ 1,746,361 tokens） |
| `accurateScanMinBytes` | `1500000` | 超过这个大小才解压全文做精确读数 |
| `autoRotate` | `true` | `false` 时只写交接 + 备份，不动会话 |
| `dryRun` | `false` | 只算不落盘 |
| `exclude` | `[]` | 永不轮换的 sessionId |
| `handoff` | `{messages:5, files:10, commands:5, chars:240}` | 交接文件摘录条数与截断长度 |

## 产出物

```
~/.dsh/session-rotate/
├── audit.log                     # 每次动作一行
├── state.json                    # 已轮换 / 已提醒（含最近水位与峰值）
├── handoffs/<sid>-<ts>.md        # 交接文件（写给新会话看的）
└── backups/<sid>-<ts>/           # 旧会话整目录副本（原样，可直接 bili export）
```

旧会话用 `workspaceController.archiveSession({ sessionId, stopActivity: true })` 归档 —— DSH 官方的「隐藏会话」通道，`ArchivedSessionGate` 会拒绝它再起新轮次，等于彻底停用，但记录还在。

## 依赖的 Host 服务

- `ctx.sessionController.agents.createSession({ cwd, agentPreset })` → `{ agent }`
- `ctx.sessionController.prompt({ sessionId, mode, requestId, clientTimeZone, content })`
- `ctx.workspaceController.archiveSession({ sessionId, stopActivity })`

三者都是 DSH 公开 RPC（`session/create`、`session/prompt`、`workspace/archiveSession`）背后的同一个服务方法，插件在 Host 进程内直接调用，不走网络。

## 自测

```powershell
& I:\node\node.exe test\run.mjs
```

四个场景、30 条断言，前两个用真实会话日志（15.6MB / 1.7M tokens）跑：

1. 完整轮换：建会话 / 投递 / 归档 / 交接文件含真实摘录 / 原日志不被删。
2. precut 小切后水位回落 → 不该开新会话。
3. 水位路由：注册路径、`current` 指向那个会话、读到真实 `totalTokens`、POST 405、外网 IP 403。
4. 多 frame 的 zstd 日志：两帧拼起来的 buffer 必须两帧都读到（Electron 的 Node 只解第一帧）。

## 已知边界

- **会话日志是多 frame 的 zstd**：Node 26 的 `zstdDecompressSync` 会一次读完所有 frame，但 DSH 桌面端跑的是 Electron 里的 Node 24.21，它**只解第一帧、静默返回几百字节、不报错**。所以这里自己按 magic（`28 B5 2F FD`）切帧逐帧解 —— 0.2.x 的「精确读数」在真机上从来没生效过，一直退回字节粗估。
- 精确读数要整份解压（12MB 文本约 260ms），所以只在超过 `accurateScanMinBytes` 时做，并按 `size+mtime` 缓存；会话一变就重新扫。
- 归档后侧栏不显示该会话；要找回记录读 `backups/`，或在 DSH 里取消归档。
- 交接摘录靠正则抓路径/命令，不是语义理解：可能漏、也可能把无关路径带进来。它只负责「提示」，不负责「结论」。
- 只处理普通会话目录，不碰 subagent 子会话（它们跟着父会话一起被备份）。
