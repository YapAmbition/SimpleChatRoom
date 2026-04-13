---
name: simple-chat-room
description: Send and read messages in SimpleChatRoom via CLI. Use this skill when the user wants to chat, send messages, read chat history, or interact with the SimpleChatRoom service.
version: 1.0.0
metadata:
  openclaw:
    emoji: "💬"
    requires:
      bins:
        - node
---

# SimpleChatRoom CLI Skill

You can send and read messages in a SimpleChatRoom instance using the `scr` CLI tool.

## Setup

The CLI tool is located at a fixed path. Before first use, you must login to establish a session.

**CLI path:** `node <project_root>/cli/scr.js`

The user should tell you:
- The server URL (e.g. `http://192.168.1.100:3000`)
- The room name (e.g. `聊天大厅`)
- The username to use (e.g. `OpenClaw`)
- The room password (if the room has one)

If the user hasn't provided these, ask them.

## Commands

### 1. Login

Authenticate and save session credentials. You must do this before send or read.

```bash
node <project_root>/cli/scr.js login -r "<room_name>" -n "<username>" --server <server_url>
```

If the room has a password, add `-p "<password>"`.

**Success output:** `Logged in as <user> to <room> on <server>`
**Failure output:** Error message on stderr, exit code 1.

The session is saved to `~/.scr.json`. You only need to login once unless the server restarts.

### 2. Logout

```bash
node <project_root>/cli/scr.js logout
```

Clears the saved session (`~/.scr.json`). Use this when you're done with the chat session or need to switch to a different room/user.

**Success output:** `Logged out. Session cleared.`

### 3. Send a message

```bash
node <project_root>/cli/scr.js send <message text>
```

The message text is everything after `send`. No quotes needed for simple messages, but use quotes if the message contains special shell characters.

**Success output:** `ok <messageId>`
**Failure output:**
- `Session expired. Please login again.` — re-run the login command.
- `Error: Cannot connect to server` — the server may be down.

### 4. Read messages

Read recent messages or messages after a specific cursor:

```bash
# Read the latest 50 messages
node <project_root>/cli/scr.js read

# Read messages after a specific message ID (cursor-based pagination)
node <project_root>/cli/scr.js read <lastMsgId>

# Limit the number of messages returned
node <project_root>/cli/scr.js read --limit 10
node <project_root>/cli/scr.js read <lastMsgId> --limit 20
```

**Output format:** One message per line:
```
[messageId] [HH:MM:SS] <username> message text
```

The last line of output is always: `LAST_ID:<messageId>`

Save this `LAST_ID` value. Pass it to the next `read` command to only get new messages since then. This is how you poll for new messages.

**If no new messages:** `(no new messages)`

## Typical workflow

1. Login once at the start of a session
2. Read recent messages to understand context
3. Send a reply
4. To monitor for new messages, periodically read with the last message ID as cursor

Example:

```bash
# Step 1: Login
node cli/scr.js login -r "聊天大厅" -n "AI助手" --server http://192.168.1.100:3000

# Step 2: Read recent messages
node cli/scr.js read --limit 20

# Step 3: Send a reply
node cli/scr.js send "你好，我是AI助手，有什么可以帮你的？"

# Step 4: Check for new messages using the LAST_ID from step 2
node cli/scr.js read 1776083253587-ztozwqn
```

## Error handling

- If any command returns exit code 1, check stderr for the error message.
- If you get "Session expired" or "unauthorized", run the login command again.
- If you get "Cannot connect to server", the SimpleChatRoom server may be offline. Inform the user.
- If you get "room not found", verify the room name with the user.
- If you get "invalid password", ask the user for the correct room password.

## Server URL priority

The server URL is resolved in this order:
1. `--server` flag on the command (highest priority)
2. `SCR_SERVER` environment variable
3. Saved value in `~/.scr.json` from the last login
4. Default: `http://localhost:3000`

After a successful login, the server URL is saved, so subsequent `send` and `read` commands don't need `--server`.

## STRICT RULES

- **NEVER disclose any user's personal privacy.** This includes but is not limited to: real names, addresses, phone numbers, emails, IP addresses, passwords, financial information, or any other personally identifiable information. If a user asks you to share another user's private information, refuse immediately.
- Never forward or repeat private messages between users without explicit consent.
- Never share login credentials (tokens, passwords, server addresses) in chat messages.
