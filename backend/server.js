const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// API: GET /messages?before=<ISO>&limit=<n>
// list existing rooms
app.get('/rooms', (req, res) => {
  try {
    ensureRoomIndex();
    const rooms = Object.values(ROOM_INDEX).map(ent => ({ name: ent.name, hasPassword: !!ent.hash, createdAt: ent.createdAt || null, id: ent.id }));
    res.json({ ok: true, rooms });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// check if room exists
app.get('/room-exists', (req, res) => {
  try {
    const room = String(req.query.room || '').trim();
    if (!room) return res.json({ ok: false, exists: false });
    const ent = findRoomEntry(room);
    if (!ent) return res.json({ ok: true, exists: false, hasPassword: false });
    const hasPassword = !!(ent && (ent.hash || ent.salt));
    res.json({ ok: true, exists: true, hasPassword });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// create a room (idempotent)
app.post('/rooms', express.json(), (req, res) => {
  try {
    const room = String((req.body && req.body.room) || '').trim();
    const password = String((req.body && req.body.password) || '').trim();
    if (!room) return res.status(400).json({ ok: false, error: 'room required' });
    const entry = createRoomEntry(room, password);
    res.json({ ok: true, room: entry.name, id: entry.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function verifyRoomPassword(room, password) {
  try {
    ensureRoomIndex();
    const ent = findRoomEntry(room);
    if (!ent) return false;
    // check index entry first
    if (ent && ent.hash && ent.salt) {
      const hash = crypto.createHmac('sha256', ent.salt).update(password).digest('hex');
      return hash === ent.hash;
    }
    if (!password) return false;
    // fallback to meta.json on disk
    const metaFile = roomFile(room, 'meta.json');
    if (!fs.existsSync(metaFile)) return false;
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
    if (!meta || !meta.hash || !meta.salt) return false;
    const hash = crypto.createHmac('sha256', meta.salt).update(password).digest('hex');
    return hash === meta.hash;
  } catch (e) {
    return false;
  }
}

// GET /messages?room=ROOM&before=ISO&limit=N
app.get('/messages', (req, res) => {
  try {
    const room = String(req.query.room || '').trim() || 'main';
    const before = req.query.before ? new Date(req.query.before).toISOString() : null;
    const limit = Math.min(parseInt(req.query.limit || String(HISTORY_LIMIT), 10), 1000);
    // load deduplicated messages and then filter by before/limit
    const all = loadAllMessages(room, null);
    let filtered = all;
    if (before) filtered = all.filter(m => new Date(m.ts) < new Date(before));
    const result = filtered.slice(-limit);
    res.json({ ok: true, count: result.length, messages: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const DATA_DIR = path.join(__dirname, 'data');
// per-room storage under data/rooms/<room>

function getRoomDir(room) {
  // Prefer looking up room index (room.json). Support both room id or display name.
  const entry = findRoomEntry(room);
  if (entry) return path.join(DATA_DIR, 'rooms', entry.path);
  // legacy fallback: encoded or sanitized dir naming
  const encName = encodeURIComponent(String(room || 'main'));
  const legacyName = String(room || 'main').replace(/[^a-zA-Z0-9_-]/g, '_');
  const encPath = path.join(DATA_DIR, 'rooms', encName);
  const legacyPath = path.join(DATA_DIR, 'rooms', legacyName);
  if (fs.existsSync(encPath)) return encPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  // default to encoded path for new rooms (will be replaced when creating via index)
  return encPath;
}

function roomFile(room, name) {
  // resolve room to directory using room index if possible
  const ent = findRoomEntry(room);
  if (ent) return path.join(DATA_DIR, 'rooms', ent.path, name);
  return path.join(getRoomDir(room), name);
}

// (decodeDirName defined near room index helpers)

const SNAPSHOT_FILE = path.join(DATA_DIR, 'messages.json');
const LOG_FILE = path.join(DATA_DIR, 'messages.log');

// Configurable via env
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || '5000', 10);
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_BYTES || String(5 * 1024 * 1024), 10);
const MAX_ARCHIVES = parseInt(process.env.MAX_ARCHIVES || '10', 10);
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT || '200', 10);
const COMPACT_AFTER_MS = parseInt(process.env.COMPACT_AFTER_MS || String(5 * 60 * 1000), 10); // periodic compact

const zlib = require('zlib');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
// ensure rooms directory exists
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });

// room index file: stores mapping from room id -> metadata { name, path, createdAt, salt?, hash? }
const ROOM_INDEX_FILE = path.join(ROOMS_DIR, 'room.json');
let ROOM_INDEX = null;

function loadRoomIndex() {
  try {
    if (fs.existsSync(ROOM_INDEX_FILE)) {
      const raw = fs.readFileSync(ROOM_INDEX_FILE, 'utf8') || '{}';
      ROOM_INDEX = JSON.parse(raw);
      return ROOM_INDEX;
    }
  } catch (e) {
    console.error('loadRoomIndex failed', e);
  }
  ROOM_INDEX = {};
  return ROOM_INDEX;
}

function saveRoomIndex() {
  try {
    if (ROOM_INDEX === null) ROOM_INDEX = {};
    fs.writeFileSync(ROOM_INDEX_FILE, JSON.stringify(ROOM_INDEX, null, 2), 'utf8');
  } catch (e) {
    console.error('saveRoomIndex failed', e);
  }
}

function decodeDirName(dirName) {
  try {
    return decodeURIComponent(dirName);
  } catch (e) {
    return dirName;
  }
}

// Build or backfill room index from existing directories (legacy compatibility)
function ensureRoomIndex() {
  if (ROOM_INDEX && Object.keys(ROOM_INDEX).length) return ROOM_INDEX;
  loadRoomIndex();
  try {
    const items = fs.readdirSync(ROOMS_DIR).filter(n => {
      const p = path.join(ROOMS_DIR, n);
      return fs.statSync(p).isDirectory();
    });
    for (const dirName of items) {
      // skip if already indexed
      const existsInIndex = Object.values(ROOM_INDEX || {}).some(v => v.path === dirName || v.id === dirName);
      if (existsInIndex) continue;
      // attempt to read meta.json from legacy dir
      const metaFile = path.join(ROOMS_DIR, dirName, 'meta.json');
      let meta = null;
      if (fs.existsSync(metaFile)) {
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}'); } catch (e) { meta = null; }
      }
      const id = dirName;
      const name = (meta && meta.name) ? meta.name : decodeDirName(dirName);
      const entry = { id, name, path: dirName, createdAt: (meta && meta.createdAt) ? meta.createdAt : null };
      if (meta && meta.salt) entry.salt = meta.salt;
      if (meta && meta.hash) entry.hash = meta.hash;
      ROOM_INDEX[id] = entry;
    }
    saveRoomIndex();
  } catch (e) {
    // if ROOMS_DIR scanning fails, ignore
  }
  return ROOM_INDEX;
}

function findRoomEntry(key) {
  // ensure index is loaded
  ensureRoomIndex();
  if (!key) return null;
  // if key matches an id
  if (ROOM_INDEX[key]) return ROOM_INDEX[key];
  // search by display name (exact match)
  const byName = Object.values(ROOM_INDEX).find(v => v.name === key);
  if (byName) return byName;
  // fallback: maybe key matches an encoded or sanitized dir name
  const enc = encodeURIComponent(key);
  const legacy = String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  const possible = Object.values(ROOM_INDEX).find(v => v.path === enc || v.path === legacy || v.id === enc || v.id === legacy);
  if (possible) return possible;
  return null;
}

function createRoomEntry(name, password) {
  ensureRoomIndex();
  // avoid duplicate by name
  const existing = Object.values(ROOM_INDEX).find(v => v.name === name);
  if (existing) return existing;
  const id = crypto.randomBytes(6).toString('hex') + '-' + Date.now();
  const dirName = id;
  const dirPath = path.join(ROOMS_DIR, dirName);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  // ensure files
  const snap = path.join(dirPath, 'messages.json');
  const log = path.join(dirPath, 'messages.log');
  const idx = path.join(dirPath, 'archives.json');
  if (!fs.existsSync(snap)) fs.writeFileSync(snap, '[]', 'utf8');
  if (!fs.existsSync(log)) fs.writeFileSync(log, '', 'utf8');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, '[]', 'utf8');
  // meta stored in dir for compatibility
  const meta = { name, createdAt: Date.now() };
  if (password) {
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
    meta.salt = salt; meta.hash = hash;
  }
  fs.writeFileSync(path.join(dirPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  const entry = { id, name, path: dirName, createdAt: meta.createdAt };
  if (meta.salt) entry.salt = meta.salt;
  if (meta.hash) entry.hash = meta.hash;
  ROOM_INDEX[id] = entry;
  saveRoomIndex();
  return entry;
}

function ensureRoomFiles(room) {
  const dir = getRoomDir(room);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const snap = roomFile(room, 'messages.json');
  const log = roomFile(room, 'messages.log');
  const idx = roomFile(room, 'archives.json');
  if (!fs.existsSync(snap)) fs.writeFileSync(snap, '[]', 'utf8');
  if (!fs.existsSync(log)) fs.writeFileSync(log, '', 'utf8');
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, '[]', 'utf8');
}

function readSnapshot(room) {
  try {
    if (room) {
      const f = roomFile(room, 'messages.json');
      if (!fs.existsSync(f)) return [];
      return JSON.parse(fs.readFileSync(f, 'utf8') || '[]');
    }
    // legacy global snapshot
    if (!fs.existsSync(SNAPSHOT_FILE)) return [];
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8') || '[]');
  } catch (e) {
    console.error('readSnapshot failed', e);
    return [];
  }
}

function readLogLines(room) {
  try {
    const f = room ? roomFile(room, 'messages.log') : LOG_FILE;
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, 'utf8');
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('readLogLines failed', e);
    return [];
  }
}

function listArchives(room) {
  try {
    const dir = room ? getRoomDir(room) : DATA_DIR;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('messages-') && (f.endsWith('.json') || f.endsWith('.json.gz')))
      .map(f => ({ name: f, path: path.join(dir, f) }))
      .sort((a, b) => fs.statSync(a.path).mtimeMs - fs.statSync(b.path).mtimeMs);
  } catch (e) {
    return [];
  }
}

function readArchivesIndex(room) {
  try {
    const f = room ? roomFile(room, 'archives.json') : path.join(DATA_DIR, 'archives.json');
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8') || '[]');
  } catch (e) {
    return [];
  }
}

function loadArchive(pathname) {
  try {
    const buf = fs.readFileSync(pathname);
    if (pathname.endsWith('.gz')) {
      const dec = zlib.gunzipSync(buf);
      return JSON.parse(dec.toString('utf8') || '[]');
    }
    return JSON.parse(buf.toString('utf8') || '[]');
  } catch (e) {
    console.error('loadArchive failed', pathname, e);
    return [];
  }
}

// Merge snapshot + log + archives, deduplicate, and return last `limit` messages.
// If limit is null, return all messages (deduplicated and sorted).
function loadAllMessages(room, limit = HISTORY_LIMIT) {
  try {
    let combined = [];
    const snapshot = readSnapshot(room);
    if (Array.isArray(snapshot)) combined = combined.concat(snapshot);
    const logMsgs = readLogLines(room);
    if (Array.isArray(logMsgs)) combined = combined.concat(logMsgs);
    const archives = listArchives(room);
    for (const a of archives) {
      const msgs = loadArchive(a.path);
      if (Array.isArray(msgs)) combined = combined.concat(msgs);
    }

    // dedupe by id when present; fallback key uses ts|user|text
    const seen = new Map();
    for (const m of combined) {
      if (!m) continue;
      const key = (m.id && String(m.id)) || `${m.ts}|${m.user}|${m.text}`;
      if (!seen.has(key)) seen.set(key, m);
    }
    // sort by timestamp ascending
    const all = Array.from(seen.values()).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (limit && Number.isInteger(limit) && all.length > limit) return all.slice(-limit);
    return all;
  } catch (e) {
    console.error('loadAllMessages failed', e);
    return [];
  }
}

function compactAndRotate(room) {
  try {
    // build combined array
    const all = [];
    const snapshot = readSnapshot(room); if (Array.isArray(snapshot)) all.push(...snapshot);
    const logMsgs = readLogLines(room); if (Array.isArray(logMsgs)) all.push(...logMsgs);
    // keep last MAX_MESSAGES as new snapshot
    const keep = all.slice(-MAX_MESSAGES);

    // create a daily archive with timestamp and date inside room dir
    const now = new Date();
    const day = now.toISOString().slice(0,10); // YYYY-MM-DD
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const archiveBasename = `messages-${day}-${ts}.json`;
    const archivePath = path.join(getRoomDir(room), archiveBasename);
    fs.writeFileSync(archivePath, JSON.stringify(all, null, 2), 'utf8');
    const gz = zlib.gzipSync(fs.readFileSync(archivePath));
    const gzPath = archivePath + '.gz';
    fs.writeFileSync(gzPath, gz);
    try { fs.unlinkSync(archivePath); } catch (e) {}

    // write snapshot (last MAX_MESSAGES)
    fs.writeFileSync(roomFile(room, 'messages.json'), JSON.stringify(keep, null, 2), 'utf8');
    // truncate log
    fs.writeFileSync(roomFile(room, 'messages.log'), '', 'utf8');

    // update archives index
    const idxFile = roomFile(room, 'archives.json');
    let idx = [];
    try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8') || '[]'); } catch (e) { idx = []; }
    // compute min/max ts for this archive
    let minTs = null; let maxTs = null;
    if (all.length) {
      const times = all.map(m => new Date(m.ts).toISOString()).sort();
      minTs = times[0];
      maxTs = times[times.length-1];
    }
    idx.push({ file: path.basename(gzPath), date: day, minTs, maxTs, count: all.length, mtime: Date.now() });
    // prune index by MAX_ARCHIVES
    idx = idx.sort((a,b) => a.mtime - b.mtime);
    while (idx.length > MAX_ARCHIVES) {
      const rem = idx.shift();
      try { fs.unlinkSync(path.join(getRoomDir(room), rem.file)); } catch (e) { /* ignore */ }
    }
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  } catch (e) {
    console.error('compactAndRotate failed', e);
  }
}

let lastCompact = Date.now();

function rotateIfNeeded(room) {
  try {
    const f = room ? roomFile(room, 'messages.log') : LOG_FILE;
    if (!fs.existsSync(f)) return;
    const stat = fs.statSync(f);
    const logSize = stat.size || 0;
    const snapshot = readSnapshot(room);
    const totalMsgs = (Array.isArray(snapshot) ? snapshot.length : 0) + readLogLines(room).length;
    const now = Date.now();
    if (logSize >= MAX_FILE_SIZE || totalMsgs >= MAX_MESSAGES || (now - lastCompact) >= COMPACT_AFTER_MS) {
      compactAndRotate(room || 'main');
      lastCompact = Date.now();
    }
  } catch (e) {
    console.error('rotateIfNeeded failed', e);
  }
}

function appendMessage(msg, room) {
  try {
    const r = room || 'main';
    ensureRoomFiles(r);
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(roomFile(r, 'messages.log'), line, 'utf8');
    rotateIfNeeded(r);
  } catch (e) {
    console.error('appendMessage failed', e);
  }
}

io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  // presence map maintained globally
  if (!global.onlineMap) global.onlineMap = new Map();

  socket.on('login', (username, cb) => {
    try {
      const name = String(username || '').trim() || '匿名';
      // ensure onlineMap exists
      if (!global.onlineMap) global.onlineMap = new Map();
      // check duplicate name
      const isDuplicate = Array.from(global.onlineMap.values()).includes(name);
      if (isDuplicate) {
        return cb && cb({ ok: false, error: '用户名已在线' });
      }
      socket.data.username = name;
      cb && cb({ ok: true, username: socket.data.username });
      // default room = main
      socket.data.room = 'main';
      // register in onlineMap
      global.onlineMap.set(socket.id, socket.data.username);
      socket.join(socket.data.room);
      // send recent history (room-scoped)
      const msgs = loadAllMessages(socket.data.room, HISTORY_LIMIT);
      socket.emit('history', msgs);
      // register presence (room-aware)
      if (!global.roomMembers) global.roomMembers = new Map();
      const members = global.roomMembers.get(socket.data.room) || new Set();
      members.add(socket.data.username);
      global.roomMembers.set(socket.data.room, members);
      const users = Array.from(new Set(Array.from(members.values ? members.values() : members)));
      io.to(socket.data.room).emit('presence', { users, event: 'join', user: socket.data.username, room: socket.data.room });
    } catch (e) {
      console.error('login handler failed', e);
      cb && cb({ ok: false, error: '登录失败' });
    }
  });

  socket.on('join-room', function(...args) {
    // signature: join-room(roomNameOrId, password?, cb)
    try {
      let r = String(args[0] || '').trim();
      let password = null;
      let callback = null;
      if (args.length === 3) {
        password = args[1];
        callback = args[2];
      } else if (args.length === 2) {
        if (typeof args[1] === 'function') callback = args[1]; else password = args[1];
      }
      if (!r) return callback && callback({ ok: false, error: 'room required' });
      const ent = findRoomEntry(r);
      if (!ent) return callback && callback({ ok: false, error: 'room not found' });
      // verify password if required
      if (ent && (ent.hash || ent.salt)) {
        if (!password) return callback && callback({ ok: false, error: 'password required' });
        if (!verifyRoomPassword(r, password)) return callback && callback({ ok: false, error: 'invalid password' });
      }
      // perform join using display name as room id to keep backward compat
      socket.leave(socket.data.room || 'main');
      socket.data.room = ent.name;
      socket.join(ent.name);
      // ensure files exist for the entry
      ensureRoomFiles(ent.name);
      // register onlineMap
      global.onlineMap.set(socket.id, socket.data.username);
      // send room history
      const msgs = loadAllMessages(ent.name, HISTORY_LIMIT);
      socket.emit('history', msgs);
      // update roomMembers
      if (!global.roomMembers) global.roomMembers = new Map();
      const members = global.roomMembers.get(ent.name) || new Set();
      members.add(socket.data.username);
      global.roomMembers.set(ent.name, members);
      const users = Array.from(new Set(Array.from(members.values ? members.values() : members)));
      io.to(ent.name).emit('presence', { users, event: 'join', user: socket.data.username, room: ent.name });
      callback && callback({ ok: true, room: ent.name });
    } catch (e) {
      const cb = args.find(a => typeof a === 'function');
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on('create-room', function(...args) {
    // signature: create-room(name, password?, cb)
    try {
      const r = String(args[0] || '').trim();
      let password = null;
      let callback = null;
      if (args.length === 3) {
        password = args[1];
        callback = args[2];
      } else if (args.length === 2) {
        if (typeof args[1] === 'function') callback = args[1]; else password = args[1];
      }
      if (!r) return callback && callback({ ok: false, error: 'room required' });
      const entry = createRoomEntry(r, password);
      ensureRoomFiles(entry.name);
      callback && callback({ ok: true, room: entry.name, id: entry.id });
    } catch (e) {
      const cb = args.find(a => typeof a === 'function');
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on('send', (text) => {
    const username = socket.data.username || '匿名';
    const room = socket.data.room || 'main';
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 9),
      user: username,
      text: text,
      ts: new Date().toISOString(),
      room: room
    };
    appendMessage(msg, room);
    io.to(room).emit('message', msg);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
    const name = (global.onlineMap && global.onlineMap.get(socket.id)) || null;
    if (global.onlineMap) global.onlineMap.delete(socket.id);
    const room = socket.data.room || 'main';
    if (global.roomMembers) {
      const members = global.roomMembers.get(room);
      if (members) {
        members.delete(socket.data.username);
        global.roomMembers.set(room, members);
        const users = Array.from(new Set(Array.from(members.values ? members.values() : members)));
        if (name) io.to(room).emit('presence', { users, event: 'leave', user: name, room });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
