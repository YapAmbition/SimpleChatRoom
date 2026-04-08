const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
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
    if (room.startsWith('_')) return res.status(400).json({ ok: false, error: '房间名不能以下划线开头' });
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
const COMPACT_AFTER_MS = parseInt(process.env.COMPACT_AFTER_MS || String(24 * 60 * 60 * 1000), 10); // periodic compact

// File upload config: max upload file size in bytes (default 10MB)
const MAX_UPLOAD_FILE_SIZE = parseInt(process.env.MAX_UPLOAD_FILE_SIZE || String(10 * 1024 * 1024), 10);

const zlib = require('zlib');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
// ensure rooms directory exists
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR, { recursive: true });

// ensure uploads directory exists
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
    const unique = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    cb(null, `${unique}_${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE }
});

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// File upload endpoint
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMB = (MAX_UPLOAD_FILE_SIZE / (1024 * 1024)).toFixed(1);
        return res.status(413).json({ ok: false, error: `文件大小超过限制 (最大 ${maxMB}MB)` });
      }
      return res.status(400).json({ ok: false, error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: '没有选择文件' });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({
      ok: true,
      file: {
        url: fileUrl,
        name: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });
  });
});

// API: get max upload file size
app.get('/upload-config', (req, res) => {
  res.json({ ok: true, maxFileSize: MAX_UPLOAD_FILE_SIZE });
});

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
      if (n.startsWith('_')) return false; // skip backup directories
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
      if (meta && meta.password) entry.password = meta.password;
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
    meta.password = password;
  }
  fs.writeFileSync(path.join(dirPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  const entry = { id, name, path: dirName, createdAt: meta.createdAt };
  if (meta.salt) entry.salt = meta.salt;
  if (meta.hash) entry.hash = meta.hash;
  if (meta.password) entry.password = meta.password;
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
  // default room = main (use id from ROOM_INDEX if available)
  ensureRoomIndex();
  const mainEntry = Object.values(ROOM_INDEX).find(e => e.name === 'main') || null;
  const defaultRoomId = mainEntry ? mainEntry.id : 'main';
  socket.data.room = defaultRoomId;
  // register in onlineMap
  global.onlineMap.set(socket.id, socket.data.username);
  socket.join(socket.data.room);
  // send recent history (room-scoped by id)
  const msgs = loadAllMessages(socket.data.room, HISTORY_LIMIT) || [];
  // ensure each message has the room id so clients can filter reliably
  msgs.forEach(m => { if (m) m.room = socket.data.room; });
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
  // perform join using canonical room id (use ent.id) to avoid name/id mixing
  socket.leave(socket.data.room || 'main');
  socket.data.room = ent.id;
  socket.join(ent.id);
  // ensure files exist for the entry (use id)
  ensureRoomFiles(ent.id);
  // register onlineMap
  global.onlineMap.set(socket.id, socket.data.username);
  // send room history (by id)
  const msgs = loadAllMessages(ent.id, HISTORY_LIMIT) || [];
  // tag messages with canonical room id for client-side filtering
  msgs.forEach(m => { if (m) m.room = ent.id; });
  socket.emit('history', msgs);
  // update roomMembers
  if (!global.roomMembers) global.roomMembers = new Map();
  const members = global.roomMembers.get(ent.id) || new Set();
  members.add(socket.data.username);
  global.roomMembers.set(ent.id, members);
  const users = Array.from(new Set(Array.from(members.values ? members.values() : members)));
  io.to(ent.id).emit('presence', { users, event: 'join', user: socket.data.username, room: ent.id });
  callback && callback({ ok: true, id: ent.id, name: ent.name });
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
      if (r.startsWith('_')) return callback && callback({ ok: false, error: '房间名不能以下划线开头' });
      const entry = createRoomEntry(r, password);
      ensureRoomFiles(entry.name);
      callback && callback({ ok: true, room: entry.name, id: entry.id });
    } catch (e) {
      const cb = args.find(a => typeof a === 'function');
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on('send', (data) => {
    const username = socket.data.username || '匿名';
    const room = socket.data.room || 'main';
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 9),
      user: username,
      ts: new Date().toISOString(),
      room: room
    };
    // support both plain text and file messages
    if (typeof data === 'object' && data !== null && data.type === 'file') {
      msg.type = 'file';
      msg.file = { url: data.file.url, name: data.file.name, size: data.file.size, mimetype: data.file.mimetype };
      msg.text = `[文件] ${data.file.name}`;
    } else {
      msg.text = typeof data === 'string' ? data : String(data || '');
    }
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

// ========== Admin Panel ==========

const ADMIN_CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const adminTokens = new Set();

function loadAdminConfig() {
  try {
    if (fs.existsSync(ADMIN_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8') || '{}');
    }
  } catch (e) { console.error('loadAdminConfig failed', e); }
  return null;
}

function saveAdminConfig(config) {
  fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function hashAdminPassword(password, salt) {
  return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

function verifyAdminPassword(password) {
  const config = loadAdminConfig();
  if (!config || !config.salt || !config.hash) return false;
  return hashAdminPassword(password, config.salt) === config.hash;
}

function setAdminPassword(newPassword) {
  const existing = loadAdminConfig();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashAdminPassword(newPassword, salt);
  const config = { salt, hash, createdAt: (existing && existing.createdAt) || Date.now(), updatedAt: Date.now() };
  saveAdminConfig(config);
  return config;
}

// Bootstrap admin config on startup
(function initAdminConfig() {
  if (!loadAdminConfig()) {
    const defaultPw = 'admin123';
    setAdminPassword(defaultPw);
    console.log(`[Admin] Default admin password created: ${defaultPw}`);
    console.log('[Admin] Please change it from the admin panel.');
  }
})();

// Auth middleware
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// POST /admin/login
app.post('/admin/login', express.json(), (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ ok: false, error: '密码错误' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ ok: true, token });
});

// POST /admin/logout
app.post('/admin/logout', adminAuth, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.slice(7);
  adminTokens.delete(token);
  res.json({ ok: true });
});

// GET /admin/rooms — list all rooms with details
app.get('/admin/rooms', adminAuth, (req, res) => {
  try {
    ensureRoomIndex();
    const rooms = Object.values(ROOM_INDEX).map(ent => {
      const online = (global.roomMembers && global.roomMembers.get(ent.id)) ? global.roomMembers.get(ent.id).size : 0;
      return {
        id: ent.id,
        name: ent.name,
        createdAt: ent.createdAt || null,
        hasPassword: !!(ent.hash || ent.salt),
        password: ent.password || null,
        online
      };
    });
    res.json({ ok: true, rooms });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /admin/rooms — create room
app.post('/admin/rooms', adminAuth, express.json(), (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const password = String((req.body && req.body.password) || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: '房间名不能为空' });
    if (name.startsWith('_')) return res.status(400).json({ ok: false, error: '房间名不能以下划线开头' });
    const existing = Object.values(ROOM_INDEX).find(v => v.name === name);
    if (existing) return res.status(400).json({ ok: false, error: '房间已存在' });
    const entry = createRoomEntry(name, password);
    io.emit('rooms-updated');
    res.json({ ok: true, room: entry });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// DELETE /admin/rooms/:id — delete room with backup
app.delete('/admin/rooms/:id', adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    ensureRoomIndex();
    const entry = ROOM_INDEX[id];
    if (!entry) return res.status(404).json({ ok: false, error: '房间不存在' });
    if (entry.name === 'main' || entry.id === 'main') {
      return res.status(400).json({ ok: false, error: '不能删除主房间' });
    }

    // Kick active users to main room
    const mainEntry = Object.values(ROOM_INDEX).find(e => e.name === 'main') || null;
    const mainRoomId = mainEntry ? mainEntry.id : 'main';
    try {
      const sockets = await io.in(id).fetchSockets();
      for (const s of sockets) {
        const oldMembers = global.roomMembers && global.roomMembers.get(id);
        if (oldMembers) oldMembers.delete(s.data.username);
        s.leave(id);
        s.data.room = mainRoomId;
        s.join(mainRoomId);
        if (!global.roomMembers) global.roomMembers = new Map();
        const mainMembers = global.roomMembers.get(mainRoomId) || new Set();
        mainMembers.add(s.data.username);
        global.roomMembers.set(mainRoomId, mainMembers);
        const msgs = loadAllMessages(mainRoomId, HISTORY_LIMIT) || [];
        msgs.forEach(m => { if (m) m.room = mainRoomId; });
        s.emit('room-deleted', { roomId: id, roomName: entry.name });
        s.emit('history', msgs);
      }
      const mainMembers = global.roomMembers.get(mainRoomId) || new Set();
      const mainUsers = Array.from(mainMembers);
      io.to(mainRoomId).emit('presence', { users: mainUsers, event: 'join', user: '', room: mainRoomId });
    } catch (e) {
      console.error('Error kicking users from deleted room', e);
    }

    if (global.roomMembers) global.roomMembers.delete(id);

    // Backup: rename directory to _roomName_timestamp
    const roomDir = path.join(ROOMS_DIR, entry.path);
    const safeName = entry.name.replace(/[\/\\:\0]/g, '_');
    const backupName = `_${safeName}_${Date.now()}`;
    const backupDir = path.join(ROOMS_DIR, backupName);
    if (fs.existsSync(roomDir)) {
      fs.renameSync(roomDir, backupDir);
    }

    delete ROOM_INDEX[id];
    saveRoomIndex();
    io.emit('rooms-updated');
    res.json({ ok: true, backup: backupName });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// POST /admin/rooms/:id/clear — clear chat history
app.post('/admin/rooms/:id/clear', adminAuth, (req, res) => {
  try {
    const id = req.params.id;
    ensureRoomIndex();
    const entry = ROOM_INDEX[id];
    if (!entry) return res.status(404).json({ ok: false, error: '房间不存在' });

    const dir = getRoomDir(id);
    fs.writeFileSync(path.join(dir, 'messages.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(dir, 'messages.log'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'archives.json'), '[]', 'utf8');
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith('messages-') && f.endsWith('.json.gz'));
      for (const f of files) fs.unlinkSync(path.join(dir, f));
    } catch (e) { /* ignore */ }

    io.to(id).emit('history', []);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// PUT /admin/rooms/:id/password — set/change room password
app.put('/admin/rooms/:id/password', adminAuth, express.json(), (req, res) => {
  try {
    const id = req.params.id;
    const password = String((req.body && req.body.password) || '').trim();
    if (!password) return res.status(400).json({ ok: false, error: '密码不能为空' });
    ensureRoomIndex();
    const entry = ROOM_INDEX[id];
    if (!entry) return res.status(404).json({ ok: false, error: '房间不存在' });

    const salt = crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
    entry.salt = salt;
    entry.hash = hash;
    entry.password = password;
    saveRoomIndex();

    const metaFile = path.join(getRoomDir(id), 'meta.json');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        meta.salt = salt; meta.hash = hash; meta.password = password;
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
      } catch (e) { /* ignore */ }
    }

    io.emit('rooms-updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// DELETE /admin/rooms/:id/password — remove room password
app.delete('/admin/rooms/:id/password', adminAuth, (req, res) => {
  try {
    const id = req.params.id;
    ensureRoomIndex();
    const entry = ROOM_INDEX[id];
    if (!entry) return res.status(404).json({ ok: false, error: '房间不存在' });

    delete entry.salt;
    delete entry.hash;
    delete entry.password;
    saveRoomIndex();

    const metaFile = path.join(getRoomDir(id), 'meta.json');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        delete meta.salt; delete meta.hash; delete meta.password;
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
      } catch (e) { /* ignore */ }
    }

    io.emit('rooms-updated');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// PUT /admin/config/password — change admin password
app.put('/admin/config/password', adminAuth, express.json(), (req, res) => {
  try {
    const currentPassword = String((req.body && req.body.currentPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '').trim();
    if (!verifyAdminPassword(currentPassword)) {
      return res.status(400).json({ ok: false, error: '当前密码错误' });
    }
    if (!newPassword) return res.status(400).json({ ok: false, error: '新密码不能为空' });
    setAdminPassword(newPassword);
    adminTokens.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
