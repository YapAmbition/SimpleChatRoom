#!/usr/bin/env python3
"""scr - SimpleChatRoom CLI"""

import sys
import os
import json
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".scr.json")


# ========== Config ==========

def load_config():
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


# ========== Argument Parser ==========

def parse_args(argv):
    args = {"_": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-r", "--room") and i + 1 < len(argv):
            i += 1; args["room"] = argv[i]
        elif a in ("-p", "--password") and i + 1 < len(argv):
            i += 1; args["password"] = argv[i]
        elif a in ("-n", "--name") and i + 1 < len(argv):
            i += 1; args["name"] = argv[i]
        elif a == "--server" and i + 1 < len(argv):
            i += 1; args["server"] = argv[i]
        elif a == "--limit" and i + 1 < len(argv):
            i += 1; args["limit"] = int(argv[i])
        else:
            args["_"].append(a)
        i += 1
    return args


# ========== HTTP Helper ==========

def http_request(method, url, body=None, headers=None):
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, {"ok": False, "error": raw or "invalid response"}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"ok": False, "error": raw or "HTTP error"}
    except urllib.error.URLError as e:
        raise ConnectionError(str(e.reason))


# ========== Resolve Server URL ==========

def resolve_server(args):
    server = args.get("server") or os.environ.get("SCR_SERVER") or load_config().get("server")
    if not server:
        return "http://localhost:3000"
    server = server.rstrip("/")
    if not server.startswith(("http://", "https://")):
        server = "http://" + server
    return server


# ========== Commands ==========

def cmd_login(args):
    room = args.get("room")
    user = args.get("name")
    if not room:
        sys.stderr.write("Error: -r <room> required\n")
        sys.exit(1)
    if not user:
        sys.stderr.write("Error: -n <name> required\n")
        sys.exit(1)

    server = resolve_server(args)
    body = {"room": room, "user": user}
    if args.get("password"):
        body["password"] = args["password"]

    try:
        status, data = http_request("POST", server + "/api/login", body)
        if data.get("ok"):
            save_config({
                "server": server,
                "token": data["token"],
                "room": data["room"],
                "roomName": data["roomName"],
                "user": data["user"],
            })
            print(f"Logged in as {data['user']} to {data['roomName']} on {server}")
        else:
            sys.stderr.write(f"Error: {data.get('error', 'login failed')}\n")
            sys.exit(1)
    except ConnectionError as e:
        sys.stderr.write(f"Error: Cannot connect to server at {server} - {e}\n")
        sys.exit(1)


def cmd_logout(_args):
    if os.path.exists(CONFIG_PATH):
        os.remove(CONFIG_PATH)
        print("Logged out. Session cleared.")
    else:
        print("Not logged in.")


def cmd_send(args):
    cfg = load_config()
    if not cfg.get("token"):
        sys.stderr.write("Not logged in. Run: ./scripts/scr login -r <room> -n <name>\n")
        sys.exit(1)

    text = " ".join(args["_"])
    if not text:
        sys.stderr.write("Error: message text required\n")
        sys.exit(1)

    server = resolve_server(args) or cfg.get("server")
    try:
        status, data = http_request("POST", server + "/api/send", {"text": text}, {
            "Authorization": "Bearer " + cfg["token"]
        })
        if data.get("ok"):
            print(f"ok {data['message']['id']}")
        elif status == 401:
            sys.stderr.write("Session expired. Please login again.\n")
            sys.exit(1)
        else:
            sys.stderr.write(f"Error: {data.get('error', 'send failed')}\n")
            sys.exit(1)
    except ConnectionError as e:
        sys.stderr.write(f"Error: Cannot connect to server at {server} - {e}\n")
        sys.exit(1)


def cmd_read(args):
    cfg = load_config()
    if not cfg.get("token"):
        sys.stderr.write("Not logged in. Run: ./scripts/scr login -r <room> -n <name>\n")
        sys.exit(1)

    after_id = args["_"][0] if args["_"] else None
    limit = args.get("limit", 50)
    server = resolve_server(args) or cfg.get("server")

    params = {"room": cfg["room"], "limit": str(limit)}
    if after_id:
        params["after"] = after_id
    url = server + "/messages?" + urllib.parse.urlencode(params)

    try:
        status, data = http_request("GET", url)
        if data.get("ok") and isinstance(data.get("messages"), list):
            msgs = data["messages"]
            if not msgs:
                print("(no new messages)")
                return
            for m in msgs:
                ts_str = m.get("ts", "")
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    time_str = ts.strftime("%H:%M:%S")
                except Exception:
                    time_str = ts_str
                if m.get("type") == "file":
                    text = f"[file] {m.get('file', {}).get('name', '')}"
                else:
                    text = m.get("text", "")
                print(f"[{m['id']}] [{time_str}] <{m['user']}> {text}")
            print(f"LAST_ID:{msgs[-1]['id']}")
        else:
            sys.stderr.write(f"Error: {data.get('error', 'read failed')}\n")
            sys.exit(1)
    except ConnectionError as e:
        sys.stderr.write(f"Error: Cannot connect to server at {server} - {e}\n")
        sys.exit(1)


def show_help():
    print("""scr - SimpleChatRoom CLI

Usage:
  scr login -r <room> -n <name> [-p <password>] [--server <url>]
  scr logout
  scr send <message...>
  scr read [lastMsgId] [--limit N]

Options:
  -r, --room      Room name
  -n, --name      Username
  -p, --password  Room password (if required)
  --server        Server URL (default: http://localhost:3000)
  --limit         Max messages to read (default: 50)

Config: ~/.scr.json
Server priority: --server > $SCR_SERVER > config > localhost:3000""")


# ========== Main ==========

def main():
    argv = sys.argv[1:]
    if not argv:
        show_help()
        return

    cmd = argv[0]
    args = parse_args(argv[1:])

    commands = {
        "login": cmd_login,
        "logout": cmd_logout,
        "send": cmd_send,
        "read": cmd_read,
        "help": lambda _: show_help(),
        "--help": lambda _: show_help(),
        "-h": lambda _: show_help(),
    }

    func = commands.get(cmd)
    if func:
        func(args)
    else:
        sys.stderr.write(f"Unknown command: {cmd}\nRun: scr help\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
