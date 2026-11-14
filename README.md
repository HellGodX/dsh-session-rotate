# dsh-session-rotate

上下文自动轮换插件：**到阈值先备份并写交接 → 新建会话迁移 → 归档旧会话**，把「一条会话吃到撑死」这件事从根上掐掉。

## 为什么需要

DSH 的会话是一条只增不减的事件日志，模型每走一步都会把前面的上下文重发一遍。billion-context 能折叠*已经聊过的部分*，但日志一旦长到接近窗口上限（今天那条约 175 万 tokens），连压缩请求自己都会超窗 —— 于是 `/compact` 报 "Compaction could not produce a useful summary"，会话彻底卡死，只能弃用。

唯一稳妥的办法：在撑爆之前把上下文搬到新会话，旧会话原样封存。

## 它做什么

每个 `intervalMs` 扫一遍 `~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd`：

| 阶段 | 触发 | 动作 |
|---|---|---|
| 提醒 | `warnTokens` | 只记一条 audit 日志 |
| 轮换 | `rotateTokens` 且会话已安静 `activeGraceMs` | 写交接 → 整目录备份 → 建新会话 → 塞交接消息 → 归档旧会话 |

「安静」这一条很关键：正在对话的会话文件一直在被写，插件不会去动它。所以实际行为是——**你停手 10 分钟后，超标的会话才会被换掉**，不打断正在进行的工作。

## 配置（`cordis.patch.yml` 里改）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `intervalMs` | `60000` | 扫描间隔 |
| `warnTokens` | `200000` | 提醒阈值 |
| `rotateTokens` | `350000` | 轮换阈值（窗口 1048576，预留输出 256000，实际可用约 790000，350000 留足了安全余量） |
| `activeGraceMs` | `600000` | 多久没写才算「安静」 |
| `tokensPerByte` | `0.112` | zstd 日志字节 → token 的换算系数（用真实会话标定：15,598,487 字节 ≈ 1,746,361 tokens） |
| `autoRotate` | `true` | `false` 时只写交接 + 备份，不动会话 |
| `dryRun` | `false` | 只算不落盘 |
| `exclude` | `[]` | 永不轮换的 sessionId |

## 产出物

```
~/.dsh/session-rotate/
├── audit.log                     # 每次动作一行
├── state.json                    # 已轮换 / 已提醒
├── handoffs/<sid>-<ts>.md        # 交接文件（写给新会话看的）
└── backups/<sid>-<ts>/           # 旧会话整目录副本（原样，可直接 bili export）
```

旧会话用 `workspaceController.archiveSession({ sessionId, stopActivity: true })` 归档 —— 这是 DSH 官方的「隐藏会话」通道，`ArchivedSessionGate` 会拒绝它再起新轮次，等于彻底停用，但记录还在。

## 依赖的 Host 服务

- `ctx.sessionController.agents.createSession({ cwd, agentPreset })` → `{ agent }`
- `ctx.sessionController.prompt({ sessionId, mode, requestId, clientTimeZone, content })`
- `ctx.workspaceController.archiveSession({ sessionId, stopActivity })`

三者都是 DSH 公开 RPC（`session/create`、`session/prompt`、`workspace/archiveSession`）背后的同一个服务方法，插件在 Host 进程内直接调用，不走网络。

## 自测

```powershell
& I:\node\node.exe test\run.mjs   # 假 ctx + 临时目录，跑完整轮换链路
```

## 已知边界

- token 数是按日志字节估算的，和真实 usage 有±1% 误差，用来卡阈值足够。
- 归档后侧栏不显示该会话；要找回记录读 `backups/`，或在 DSH 里取消归档。
- 交接文件里「旧会话都聊了什么」这一节目前是空模板 —— 插件不读对话内容（读全文又得把大上下文塞回来），这节要靠你在新会话里补，或者让新会话自己去看备份。
