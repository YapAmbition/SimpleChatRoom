---
name: simple-chat-room
description: 通过 CLI 在 SimpleChatRoom 中发送和阅读消息。当用户想要聊天、发消息、查看聊天记录或与 SimpleChatRoom 交互时使用此 Skill。
version: 1.0.0
metadata:
  openclaw:
    emoji: "💬"
---

# SimpleChatRoom CLI Skill

你可以使用 `scr` 命令在 SimpleChatRoom 中发送和阅读消息。

## 准备工作

使用前，先检查是否已存在登录凭证：

```bash
scr read --limit 1
```

- 如果成功返回消息或 `(no new messages)`，说明**已登录**，无需再次登录，可直接使用 send/read 命令。
- 如果返回 `Not logged in` 或 `Session expired`，则需要先执行登录。

登录时需要以下信息（如果用户没有提供，请主动询问）：
- 服务器地址（如 `http://192.168.1.100:3000`）
- 房间名（如 `聊天大厅`）
- 用户名（如 `OpenClaw`）
- 房间密码（如果房间设置了密码）

## 命令

### 1. 登录

认证并保存会话凭证。

```bash
scr login -r "<房间名>" -n "<用户名>" --server <服务器地址>
```

如果房间有密码，加上 `-p "<密码>"`。

**成功输出：** `Logged in as <用户> to <房间> on <服务器>`
**失败输出：** stderr 输出错误信息，退出码 1。

会话保存在 `~/.scr.json` 中。除非服务器重启，否则只需登录一次。

### 2. 退出登录

```bash
scr logout
```

清除已保存的会话（`~/.scr.json`）。在结束聊天或需要切换房间/用户时使用。

**成功输出：** `Logged out. Session cleared.`

### 3. 发送消息

```bash
scr send <消息内容>
```

消息内容是 `send` 之后的所有文字。简单消息不需要引号，但如果包含 shell 特殊字符请加引号。

**成功输出：** `ok <messageId>`
**失败输出：**
- `Session expired. Please login again.` — 需要重新登录。
- `Error: Cannot connect to server` — 服务器可能已下线。

### 4. 阅读消息

阅读最近的消息，或从指定位置开始读取：

```bash
# 读取最近 50 条消息
scr read

# 读取指定消息 ID 之后的消息（基于游标的分页）
scr read <lastMsgId>

# 限制返回消息数量
scr read --limit 10
scr read <lastMsgId> --limit 20
```

**输出格式：** 每行一条消息：
```
[messageId] [HH:MM:SS] <用户名> 消息内容
```

输出的最后一行固定为：`LAST_ID:<messageId>`

保存这个 `LAST_ID` 值，传入下一次 `read` 命令即可只获取此后的新消息。这是轮询新消息的方式。

**无新消息时输出：** `(no new messages)`

## 典型工作流

1. 先用 `scr read --limit 1` 检查是否已登录
2. 如果未登录，执行登录
3. 读取最近消息了解上下文
4. 发送回复
5. 要监控新消息时，用上次的 LAST_ID 作为游标定期读取

示例：

```bash
# 第 1 步：检查登录状态
scr read --limit 1

# 第 2 步：未登录时执行登录
scr login -r "聊天大厅" -n "AI助手" --server http://192.168.1.100:3000

# 第 3 步：读取最近消息
scr read --limit 20

# 第 4 步：发送回复
scr send "你好，我是AI助手，有什么可以帮你的？"

# 第 5 步：用 LAST_ID 检查新消息
scr read 1776083253587-ztozwqn
```

## 错误处理

- 如果任何命令返回退出码 1，检查 stderr 中的错误信息。
- 收到 `Session expired` 或 `unauthorized` 时，重新执行登录命令。
- 收到 `Cannot connect to server` 时，SimpleChatRoom 服务器可能已下线，通知用户。
- 收到 `room not found` 时，向用户确认房间名。
- 收到 `invalid password` 时，向用户索要正确的房间密码。

## 服务器地址优先级

服务器地址按以下顺序解析：
1. 命令行 `--server` 参数（最高优先级）
2. 环境变量 `SCR_SERVER`
3. `~/.scr.json` 中上次登录保存的值
4. 默认值：`http://localhost:3000`

登录成功后服务器地址会被保存，后续的 `send` 和 `read` 命令不需要再指定 `--server`。

## 严格规则

- **绝对不要泄露任何用户的个人隐私。** 包括但不限于：真实姓名、地址、电话号码、电子邮件、IP 地址、密码、财务信息或任何其他个人身份信息。如果有用户要求你分享其他用户的私人信息，立即拒绝。
- 未经明确同意，不得在用户之间转发或重复私人消息。
- 不得在聊天消息中分享登录凭证（token、密码、服务器地址）。
