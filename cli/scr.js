#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// ========== Config ==========
const CONFIG_PATH = path.join(os.homedir(), '.scr.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ========== Argument Parser ==========
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-r' || a === '--room') { args.room = argv[++i]; }
    else if (a === '-p' || a === '--password') { args.password = argv[++i]; }
    else if (a === '-n' || a === '--name') { args.name = argv[++i]; }
    else if (a === '--server') { args.server = argv[++i]; }
    else if (a === '--limit') { args.limit = parseInt(argv[++i], 10); }
    else { args._.push(a); }
  }
  return args;
}

// ========== HTTP Helper ==========
function request(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: { ...headers }
    };
    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: { ok: false, error: data || 'invalid response' } });
        }
      });
    });
    req.on('error', (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

// ========== Resolve Server URL ==========
function resolveServer(args) {
  let server = null;
  if (args.server) server = args.server;
  else if (process.env.SCR_SERVER) server = process.env.SCR_SERVER;
  else {
    const cfg = loadConfig();
    if (cfg.server) server = cfg.server;
  }
  if (!server) return 'http://localhost:3000';
  server = server.replace(/\/+$/, '');
  // auto-prepend http:// if no protocol specified
  if (!/^https?:\/\//i.test(server)) server = 'http://' + server;
  return server;
}

// ========== Commands ==========

async function cmdLogin(args) {
  const room = args.room;
  const user = args.name;
  if (!room) { process.stderr.write('Error: -r <room> required\n'); process.exit(1); }
  if (!user) { process.stderr.write('Error: -n <name> required\n'); process.exit(1); }

  const server = resolveServer(args);
  const body = { room, user };
  if (args.password) body.password = args.password;

  try {
    const res = await request('POST', server + '/api/login', body, {});
    if (res.data && res.data.ok) {
      saveConfig({
        server,
        token: res.data.token,
        room: res.data.room,
        roomName: res.data.roomName,
        user: res.data.user
      });
      process.stdout.write(`Logged in as ${res.data.user} to ${res.data.roomName} on ${server}\n`);
    } else {
      process.stderr.write(`Error: ${(res.data && res.data.error) || 'login failed'}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`Error: Cannot connect to server at ${server} - ${e.code || e.message || e}\n`);
    process.exit(1);
  }
}

async function cmdSend(args) {
  const cfg = loadConfig();
  if (!cfg.token) { process.stderr.write('Not logged in. Run: node cli/scr.js login -r <room> -n <name>\n'); process.exit(1); }

  const text = args._.join(' ');
  if (!text) { process.stderr.write('Error: message text required\n'); process.exit(1); }

  const server = resolveServer(args) || cfg.server;
  try {
    const res = await request('POST', server + '/api/send', { text }, {
      'Authorization': 'Bearer ' + cfg.token
    });
    if (res.data && res.data.ok) {
      process.stdout.write(`ok ${res.data.message.id}\n`);
    } else if (res.status === 401) {
      process.stderr.write('Session expired. Please login again.\n');
      process.exit(1);
    } else {
      process.stderr.write(`Error: ${(res.data && res.data.error) || 'send failed'}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`Error: Cannot connect to server at ${server} - ${e.code || e.message || e}\n`);
    process.exit(1);
  }
}

async function cmdRead(args) {
  const cfg = loadConfig();
  if (!cfg.token) { process.stderr.write('Not logged in. Run: node cli/scr.js login -r <room> -n <name>\n'); process.exit(1); }

  const afterId = args._[0] || null;
  const limit = args.limit || 50;
  const server = resolveServer(args) || cfg.server;

  let url = server + '/messages?room=' + encodeURIComponent(cfg.room) + '&limit=' + limit;
  if (afterId) url += '&after=' + encodeURIComponent(afterId);

  try {
    const res = await request('GET', url, null, {});
    if (res.data && res.data.ok && Array.isArray(res.data.messages)) {
      const msgs = res.data.messages;
      if (msgs.length === 0) {
        process.stdout.write('(no new messages)\n');
        return;
      }
      for (const m of msgs) {
        const ts = new Date(m.ts).toLocaleTimeString();
        const text = m.type === 'file' ? `[file] ${m.file ? m.file.name : ''}` : m.text;
        process.stdout.write(`[${m.id}] [${ts}] <${m.user}> ${text}\n`);
      }
      process.stdout.write(`LAST_ID:${msgs[msgs.length - 1].id}\n`);
    } else {
      process.stderr.write(`Error: ${(res.data && res.data.error) || 'read failed'}\n`);
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`Error: Cannot connect to server at ${server} - ${e.code || e.message || e}\n`);
    process.exit(1);
  }
}

function cmdLogout() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
    process.stdout.write('Logged out. Session cleared.\n');
  } else {
    process.stdout.write('Not logged in.\n');
  }
}

function showHelp() {
  process.stdout.write(`scr - SimpleChatRoom CLI

Usage:
  scr login -r <room> -n <name> [-p <password>] [--server <url>]
  scr send <message...>
  scr read [lastMsgId] [--limit N]
  scr logout

Options:
  -r, --room      Room name
  -n, --name      Username
  -p, --password  Room password (if required)
  --server        Server URL (default: http://localhost:3000)
  --limit         Max messages to read (default: 50)

Config: ~/.scr.json
Server priority: --server > $SCR_SERVER > config > localhost:3000
`);
}

// ========== Main ==========
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { showHelp(); return; }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'login': await cmdLogin(args); break;
    case 'logout': cmdLogout(); break;
    case 'send': await cmdSend(args); break;
    case 'read': await cmdRead(args); break;
    case 'help': case '--help': case '-h': showHelp(); break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\nRun: scr help\n`);
      process.exit(1);
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
