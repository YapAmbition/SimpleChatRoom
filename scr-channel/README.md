# scr-channel

OpenClaw Channel Plugin — 将 [SimpleChatRoom](https://github.com/user/SimpleChatRoom) 接入 OpenClaw，通过聊天界面与 Agent 对话。

## 工作原理

```
Cloud Server                            本地 MacBook
┌───────────────────────┐               ┌─────────────────────────────┐
│  SimpleChatRoom       │   Internet    │  OpenClaw Gateway           │
│  (Express + Socket.IO)│◄────────────►│    └─ scr-channel 插件       │
│                       │  WebSocket    │        ├ Socket.IO 监听消息  │
│  用户在浏览器发消息    │  + HTTP       │        ├ Batcher 批量聚合    │
└───────────────────────┘               │        ├ 转发给 Agent 处理   │
                                        │        └ 回复写回聊天室      │
                                        │  Ollama (本地模型)           │
                                        └─────────────────────────────┘
```

**入站流程**: 用户在 Web UI 发消息 → 插件通过 Socket.IO 收到 → 消息进入 Batcher 缓冲 → 等待一段时间收集完毕后批量发给 Agent → Agent 生成回复

**出站流程**: Agent 回复 → 插件通过 HTTP API 发送到 SimpleChatRoom → 所有用户在聊天室看到回复

### 为什么要批量处理？

本地 Ollama 模型通常只支持单并发请求。如果每条消息都立即触发 Agent，多人同时发言会导致请求排队甚至失败。Batcher 的策略是：

1. 收到第一条消息，启动 debounce 计时器（默认 3 秒）
2. 每来一条新消息，重置 debounce 计时器
3. 3 秒内没有新消息 → 把积攒的消息一次性发给 Agent
4. 即使消息一直在来，最多等 10 秒也会强制发送（maxWait）
5. Agent 处理当前批次期间，新消息自动排入下一批

## 部署

### 前置条件

- OpenClaw 已安装并运行在本地机器上
- SimpleChatRoom 已部署在可访问的服务器上（有公网 IP 或域名）
- Node.js >= 18

### 步骤

**1. 复制插件到 OpenClaw 扩展目录**

```bash
cp -r scr-channel ~/.openclaw/extensions/scr-channel
```

或使用 symlink（方便开发调试）：

```bash
ln -s /path/to/scr-channel ~/.openclaw/extensions/scr-channel
```

**2. 安装依赖**

```bash
cd ~/.openclaw/extensions/scr-channel
npm install
```

**3. 编译 TypeScript**

```bash
npm run build
```

**4. 配置 OpenClaw**

编辑 `~/.openclaw/openclaw.json`，在 `channels` 下添加 `scr` 配置：

```json5
{
  channels: {
    scr: {
      serverUrl: "https://chat.example.com",
      room: "聊天大厅",
      botName: "OpenClaw-Bot"
    }
  }
}
```

**5. 启用插件并重启**

```bash
openclaw plugins enable scr
openclaw gateway restart
```

**6. 验证**

在 SimpleChatRoom 的 Web 界面中发一条消息，等几秒后应该能看到 Bot 的回复。

## 配置参数

所有参数在 `~/.openclaw/openclaw.json` 的 `channels.scr` 下配置。

### 必填参数

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `serverUrl` | string | SimpleChatRoom 服务器地址，需要包含协议和端口（如果非默认端口） | `"https://chat.example.com"` |
| `room` | string | 要加入的房间名，必须是 SimpleChatRoom 上已存在的房间 | `"聊天大厅"` |
| `botName` | string | Bot 在聊天室中显示的用户名，建议取一个辨识度高的名字，避免与真实用户重名 | `"OpenClaw-Bot"` |

### 可选参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `roomPassword` | string | 无 | 房间密码。如果目标房间设置了密码保护，需要填写此项，否则 Bot 无法加入 |
| `requireMention` | boolean | `false` | 是否需要 @提及 Bot 才回复。设为 `true` 时，只有包含 Bot 名字或触发词的消息才会转发给 Agent，其余消息忽略 |
| `mentionPatterns` | string[] | `[]` | 自定义触发词列表。除了 Bot 名字本身之外，消息中包含这些词也视为提及了 Bot |
| `batchDebounceMs` | number | `3000` | 消息聚合的 debounce 等待时间（毫秒）。收到最后一条消息后等待这么久，如果没有新消息就触发处理 |
| `batchMaxWaitMs` | number | `10000` | 消息聚合的最大等待时间（毫秒）。即使消息一直在来，超过这个时间也会强制触发处理 |
| `responsePrefix` | string | `""` | Bot 回复消息的前缀。会加在每条 Agent 回复的开头 |

### 参数详解与建议值

#### `requireMention`

- **多人公共房间**：建议设为 `true`，并配合 `mentionPatterns` 使用。这样 Bot 不会对每条闲聊都回复，只有明确 @Bot 或说出触发词时才会响应。
- **专属 Bot 房间**（只有你和 Bot）：设为 `false`，这样你发的每条消息都会得到回复。

```json5
// 公共房间示例
{
  requireMention: true,
  mentionPatterns: ["小助手", "AI", "帮我"]
}

// 专属房间示例
{
  requireMention: false
}
```

#### `batchDebounceMs`

控制"等多久没新消息就开始处理"。

- **建议值 `3000`**（3 秒）：适合大多数场景。用户打完一段话通常会停顿几秒。
- 设为 `1000`（1 秒）：响应更快，但如果用户习惯分多条发消息，可能只处理到前几条。
- 设为 `5000`（5 秒）：更有耐心地等用户说完，适合长文本讨论场景。

#### `batchMaxWaitMs`

控制"消息一直在来的情况下，最多等多久"。

- **建议值 `10000`**（10 秒）：防止群聊活跃时 Bot 一直不回复。
- 设为 `5000`：在活跃群聊中更快介入。
- 设为 `30000`：给大量讨论留更多缓冲时间后再统一回复。

**注意**: `batchMaxWaitMs` 应大于 `batchDebounceMs`，否则 maxWait 会先触发，debounce 就失去了意义。

#### `responsePrefix`

给 Bot 回复加一个统一前缀，方便在聊天记录中快速区分 Bot 消息。

```json5
// 不加前缀（默认）
responsePrefix: ""

// 加 emoji 前缀
responsePrefix: "🤖 "

// 加文字前缀
responsePrefix: "[AI] "
```

### 环境变量

以下环境变量可以替代配置文件中的参数（优先级低于配置文件）：

| 环境变量 | 对应参数 |
|----------|----------|
| `SCR_SERVER_URL` | `serverUrl` |
| `SCR_ROOM` | `room` |
| `SCR_BOT_NAME` | `botName` |
| `SCR_ROOM_PASSWORD` | `roomPassword` |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway 地址（默认 `http://localhost:18789`） |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway 认证 Token |

## 完整配置示例

```json5
// ~/.openclaw/openclaw.json
{
  channels: {
    scr: {
      // 必填
      serverUrl: "https://chat.example.com",
      room: "AI助手专属房",
      botName: "OpenClaw-Bot",

      // 房间密码（如果有）
      roomPassword: "my-secret",

      // 回复策略 — 专属房间设为 false，公共房间设为 true
      requireMention: false,
      mentionPatterns: ["小助手", "AI"],

      // 批量处理 — 3秒无新消息则处理，最多等10秒
      batchDebounceMs: 3000,
      batchMaxWaitMs: 10000,

      // 回复前缀
      responsePrefix: "🤖 "
    }
  }
}
```

## 多账户配置

如果需要在多个 SimpleChatRoom 房间中运行 Bot，可以使用 `accounts` 配置多个账户：

```json5
{
  channels: {
    scr: {
      // 公共基础配置
      serverUrl: "https://chat.example.com",
      batchDebounceMs: 3000,

      // 默认账户
      defaultAccount: "main",

      accounts: {
        main: {
          room: "聊天大厅",
          botName: "OpenClaw-Bot",
          requireMention: true,
          mentionPatterns: ["小助手"]
        },
        private: {
          room: "我的AI房间",
          botName: "MyAI",
          roomPassword: "secret123",
          requireMention: false
        }
      }
    }
  }
}
```

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build

# 监听模式编译（开发时）
npm run dev

# 运行测试
npm test
```

## 故障排查

| 现象 | 可能原因 | 解决方法 |
|------|----------|----------|
| Bot 不上线 | serverUrl 不正确或服务器不可达 | 检查 URL 是否能在浏览器中打开，确认端口和协议正确 |
| Bot 上线但不回复 | `requireMention` 为 `true` 但消息中没有提及 Bot | 在消息中加入 Bot 名字，或设为 `false` |
| Bot 重复回复 | Bot 名字与其他用户重名导致 echo 过滤失效 | 使用一个不会与真实用户重复的 Bot 名字 |
| 回复很慢 | `batchDebounceMs` / `batchMaxWaitMs` 设置过大，或 Ollama 推理慢 | 减小批量等待时间，或检查 Ollama 模型性能 |
| `Session expired` | SimpleChatRoom 服务器重启导致 token 失效 | 插件会自动重新登录，如果持续报错检查服务器状态 |
| `用户名已在线` | 之前的连接未正常断开 | 插件会自动尝试添加后缀重试，也可以重启 SimpleChatRoom 清理在线列表 |
