*[English](README.en.md) | 中文*

# @agents-uni/chat

> Agent 群聊服务 — 基于 OpenClaw 的多 Agent 对话界面

## 什么是 agents-uni/chat？

`@agents-uni/chat` 为 agent universe 提供一个本地群聊 Web 服务。用户可以在浏览器中和所有 agent 进行群聊对话，agent 之间也可以互相引用、讨论、协作。

底层基于 OpenClaw 的文件协议（TASK.md / SUBMISSION.md），是对 OpenClaw 的群聊封装。

## 特性

- **群聊界面** — 暗色主题 Web UI，实时展示 agent 回复
- **上下文管理** — 滑动窗口机制，为每个 agent 构建个性化上下文
- **顺序执行** — 一次一条消息，等待所有 agent 回复后再发下一条
- **关系进化** — 从对话中自动推断关系事件（赞同/分歧/协作/共识）
- **SSE 实时推送** — agent 回复即刻推送到浏览器
- **Debug 模式** — `--debug` 开启完整调度日志，终端 + SSE 同步输出
- **OpenClaw 兼容** — 底层使用 TASK.md/SUBMISSION.md 文件协议

## 快速开始

### 前置条件

1. **安装并配置 OpenClaw** — agent 的实际运行依赖 OpenClaw 运行时
2. **部署 Universe** — 通过 `bridge import` 导入 agent 并执行 `deploy`，确保 `~/.openclaw/workspace-{agentId}/SOUL.md` 已生成
3. **启动 OpenClaw Gateway** — 运行 `openclaw` 启动 gateway，chat 服务会通过 `openclaw agent` CLI 触发 agent 执行

```bash
# 1. 导入 agent（如果还没导入）
uni bridge import ./agency-agents

# 2. 部署到 OpenClaw
uni deploy universe.yaml

# 3. 启动 OpenClaw gateway（保持运行）
openclaw
```

> **重要**: 如果 OpenClaw gateway 没有运行，chat 服务仍能启动，但所有 agent 都会超时无响应。

### 安装

```bash
npm install @agents-uni/chat
```

### 启动

```bash
# 在包含 universe.yaml 的目录下
npx agents-chat serve

# 或指定配置文件
npx agents-chat serve --spec path/to/universe.yaml --port 3000
```

浏览器打开 `http://localhost:3000` 即可开始群聊。

### CLI 选项

```
agents-chat serve [options]

Options:
  -s, --spec <path>           universe.yaml 路径（默认自动检测）
  -p, --port <number>         端口号（默认 3000）
  --openclaw-dir <path>       OpenClaw workspace 目录
  --context-window <number>   上下文窗口大小（默认 20 条消息）
  --timeout <number>          Agent 回复超时秒数（默认 120）
  --debug                     开启 debug 日志（默认关闭）
```

## 架构

```
┌─────────────────────────────────────────────────┐
│                Browser (Chat UI)                 │
│         HTML/CSS/JS · SSE Real-time              │
└────────────────────┬────────────────────────────┘
                     │ HTTP + SSE
┌────────────────────┴────────────────────────────┐
│              Hono Server (localhost)              │
│  POST /api/message  GET /api/events  GET /api/*  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│                 ChatEngine                        │
│                                                   │
│  ContextManager    ChatDispatcher    RelTracker   │
│  (滑动窗口)        (TASK.md 适配)    (事件推断)   │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────┐
│            OpenClaw File Protocol                 │
│                                                   │
│  TASK.md ──→ openclaw agent ──→ SUBMISSION.md    │
│              (CLI 触发)                            │
│  @agents-uni/core    @agents-uni/rel              │
│  (Universe 解析)     (关系进化引擎)                │
└──────────────────────────────────────────────────┘
```

## 核心机制

### 消息流

1. 用户在 UI 发送消息
2. ChatEngine 将状态设为 `processing`（前端输入框禁用）
3. ContextManager 为每个 agent 构建个性化 TASK.md（包含身份、关系、聊天历史）
4. ChatDispatcher 将 TASK.md 写入各 agent 的 OpenClaw workspace
5. 通过 `openclaw agent --agent {id}` 触发每个 agent 处理任务
6. 轮询 SUBMISSION.md，收集 agent 回复
7. RelationshipTracker 从回复中推断关系事件
7. 事件喂入 EvolutionEngine 进行关系进化
8. 状态回到 `idle`，用户可发送下一条消息

### 上下文窗口

每个 agent 收到的 TASK.md 包含：

- **身份信息** — 角色、性格特征、约束
- **参与者列表** — 群聊中的所有人
- **关系摘要** — 与其他 agent 的多维关系
- **聊天历史** — 最近 N 条消息（滑动窗口）
- **当前消息** — 用户刚发的内容

### 关系推断

从 agent 回复中检测以下模式：

| 模式 | 事件类型 | 维度影响 |
|------|---------|---------|
| 提及其他 agent + 赞同语 | `chat.agreement` | trust +0.05, affinity +0.03 |
| 提及其他 agent + 反对语 | `chat.disagreement` | rivalry +0.03, respect +0.01 |
| 引用/扩展其他 agent 的观点 | `chat.collaboration` | trust +0.03, synergy +0.05 |
| 多数 agent 表达共识 | `chat.consensus` | trust +0.02, synergy +0.02 |

### 关系驱动路由

`selectRespondents()` 现在在关键词匹配基础上叠加关系评分：

- 最近回复 agent 的盟友（trust > 0.3）：+1 分
- 最近回复 agent 的对手（rivalry > 0.3）：+0.5 分
- 高 influence agent：+influence×2 分
- 无关系时行为不变，完全向后兼容

### 图谱可视化

侧边栏新增 List/Graph 切换，Graph 模式使用 vis-network 渲染关系图谱：

- 节点大小=influence，颜色=cluster
- 边颜色=valence，粗细=strength
- 关系变化时自动刷新 + 聊天流中显示通知

### 事件时间线

新增 `GET /api/relations/timeline` 返回最近 50 条关系变化事件。

## API

### HTTP 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 当前会话状态 |
| GET | `/api/config` | Universe 配置 |
| GET | `/api/relations` | 关系图数据 |
| GET | `/api/relations/timeline` | 最近 50 条关系变化事件 |
| GET | `/api/events` | SSE 实时事件流 |
| POST | `/api/message` | 发送用户消息 |

### 编程接口

```typescript
import { ChatEngine } from '@agents-uni/chat';

const engine = new ChatEngine({
  specPath: './universe.yaml',
  contextWindowSize: 20,
  responseTimeoutMs: 120_000,
});

engine.onEvent({
  onMessage: (msg) => console.log(`[${msg.agentName}] ${msg.content}`),
  onStatusChange: (status) => console.log(`Status: ${status}`),
  onRelationshipChange: (changes) => console.log('Relations evolved:', changes),
});

const responses = await engine.processMessage('大家对这个方案怎么看？');
```

## 依赖

- `@agents-uni/core` — Universe 解析、TaskDispatcher、WorkspaceIO
- `@agents-uni/rel` — 多维关系引擎、EvolutionEngine
- `hono` — HTTP 服务器
- `commander` — CLI

## Debug 模式

启动时加上 `--debug` 即可开启详细调度日志：

```bash
npx agents-chat serve --debug --spec universe.yaml
```

终端会输出带颜色的调度全流程日志：

```
[DEBUG][Engine] processMessage: content="@Alice what do you think?"
[DEBUG][Engine] parseMentions: found=["alice"]
[DEBUG][Engine] routing: targeted=true, agents=["alice"]
[DEBUG][Dispatcher] writeTask: contentLength=1234 (alice)
[DEBUG][Dispatcher] clearSubmission: (alice)
[DEBUG][Dispatcher] poll: waiting=["alice"], elapsed=0ms
[DEBUG][Dispatcher] poll: waiting=["alice"], elapsed=2000ms
[DEBUG][Dispatcher] responseReceived: length=256 (alice)
[DEBUG][Tracker] sentiment: from="alice" → to="dana", type="chat.agreement"
[DEBUG][Engine] relationshipChanges: count=1
```

同时，debug 日志也会通过 SSE 推送到前端（事件类型 `debug_log`），便于在浏览器控制台中调试。

编程接口中也可以开启：

```typescript
const engine = new ChatEngine({
  specPath: './universe.yaml',
  debug: true,
});

// 监听 debug 日志
engine.getLogger().onLog((entry) => {
  console.log(entry.source, entry.action, entry.detail);
});
```

## 设计理念

- **OpenClaw 优先** — 不绕过文件协议，而是封装它
- **顺序简化** — MVP 阶段一次一条消息，未来可迭代为并发
- **关系驱动** — 每轮对话都产生关系信号，agent 间的关系随对话演进
- **最小依赖** — 前端纯 HTML/CSS/JS，无构建步骤

## License

MIT
