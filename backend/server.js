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
    const roomsDir = path.join(DATA_DIR, 'rooms');
    if (!fs.existsSync(roomsDir)) return res.json({ ok: true, rooms: [] });
    const items = fs.readdirSync(roomsDir).filter(n => {
      return fs.statSync(path.join(roomsDir, n)).isDirectory();
    });
    const rooms = items.map(dirName => {
      try {
        const metaFile = path.join(roomsDir, dirName, 'meta.json');
        if (fs.existsSync(metaFile)) {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
          const displayName = meta && meta.name ? meta.name : decodeDirName(dirName);
          return { name: displayName, hasPassword: !!(meta && meta.hash), createdAt: meta && meta.createdAt ? meta.createdAt : null };
        }
      } catch (e) {}
      // if no meta, try to decode dirName, fallback to dirName itself
      return { name: decodeDirName(dirName), hasPassword: false, createdAt: null };
    });
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
    const dir = getRoomDir(room);
    const exists = fs.existsSync(dir);
    let hasPassword = false;
    try {
      const metaFile = roomFile(room, 'meta.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        hasPassword = !!(meta && meta.hash);
      }
    } catch (e) { hasPassword = false; }
    res.json({ ok: true, exists, hasPassword });
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
    const dir = getRoomDir(room);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // ensure files
    const snap = path.join(dir, 'messages.json');
    const log = path.join(dir, 'messages.log');
    const idx = path.join(dir, 'archives.json');
    if (!fs.existsSync(snap)) fs.writeFileSync(snap, '[]', 'utf8');
    if (!fs.existsSync(log)) fs.writeFileSync(log, '', 'utf8');
    if (!fs.existsSync(idx)) fs.writeFileSync(idx, '[]', 'utf8');
    // write meta (always include name + createdAt). include password hash if provided
    const meta = { name: room, createdAt: Date.now() };
    if (password) {
      const salt = crypto.randomBytes(8).toString('hex');
      const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
      meta.salt = salt;
      meta.hash = hash;
    }
    fs.writeFileSync(roomFile(room, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    res.json({ ok: true, room });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function verifyRoomPassword(room, password) {
  try {
    if (!password) return false;
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
    // load snapshot + log + archives for the room
    const all = [];
    const snap = readSnapshot(room); if (Array.isArray(snap)) all.push(...snap);
    const logMsgs = readLogLines(room); if (Array.isArray(logMsgs)) all.push(...logMsgs);
    const idx = readArchivesIndex(room);
    const candidate = (idx || []).slice().sort((a,b) => b.mtime - a.mtime);
    for (const meta of candidate) {
      if (before && meta.maxTs && meta.maxTs < before) break;
      const arr = loadArchive(path.join(getRoomDir(room), meta.file));
      if (Array.isArray(arr)) all.push(...arr);
    }
    all.sort((a,b) => new Date(a.ts) - new Date(b.ts));
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
  // prefer existing encoded dir or legacy sanitized dir; if none exists, return encoded path for creation
  const encName = encodeURIComponent(String(room || 'main'));
  const legacyName = String(room || 'main').replace(/[^a-zA-Z0-9_-]/g, '_');
  const encPath = path.join(DATA_DIR, 'rooms', encName);
  const legacyPath = path.join(DATA_DIR, 'rooms', legacyName);
  if (fs.existsSync(encPath)) return encPath;
  if (fs.existsSync(legacyPath)) return legacyPath;
  // default to encoded path for new rooms
  return encPath;
}

function roomFile(room, name) {
  return path.join(getRoomDir(room), name);
}

function decodeDirName(dirName) {
  try {
    // try decodeURIComponent, but if it's not encoded, this will throw for some patterns
    return decodeURIComponent(dirName);
  } catch (e) {
    return dirName;
  }
}

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

// Merge snapshot + log + archives and return last `limit` messages
function loadAllMessages(room, limit = HISTORY_LIMIT) {
  try {
    let all = [];
    const snapshot = readSnapshot(room);
    if (Array.isArray(snapshot)) all = all.concat(snapshot);
    const logMsgs = readLogLines(room);
    if (Array.isArray(logMsgs)) all = all.concat(logMsgs);
    const archives = listArchives(room);
    for (const a of archives) {
      const msgs = loadArchive(a.path);
      if (Array.isArray(msgs)) all = all.concat(msgs);
    }
    if (limit && all.length > limit) return all.slice(-limit);
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
    socket.data.username = username || '匿名';
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
  });

  socket.on('join-room', function(...args) {
    // signature: join-room(room, password?, cb)
    try {
      let r = String(args[0] || '').trim();
      let password = null;
      let callback = null;
      if (args.length === 3) {
        password = args[1];
        callback = args[2];
      } else if (args.length === 2) {
        if (typeof args[1] === 'function') callback = args[1]; else password = args[1];
      } else if (args.length === 1) {
        callback = null;
      }
      if (!r) return callback && callback({ ok: false, error: 'room required' });
      const dir = getRoomDir(r);
      if (!fs.existsSync(dir)) return callback && callback({ ok: false, error: 'room not found' });
      // check password if meta present
      const metaFile = roomFile(r, 'meta.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8') || '{}');
        if (meta && meta.hash) {
          if (!password) return callback && callback({ ok: false, error: 'password required' });
          if (!verifyRoomPassword(r, password)) return callback && callback({ ok: false, error: 'invalid password' });
        }
      }
      // perform join
      socket.leave(socket.data.room || 'main');
      socket.data.room = r;
      socket.join(r);
      ensureRoomFiles(r);
      // register onlineMap
      global.onlineMap.set(socket.id, socket.data.username);
      // send room history
      const msgs = loadAllMessages(r, HISTORY_LIMIT);
      socket.emit('history', msgs);
      // update roomMembers
      if (!global.roomMembers) global.roomMembers = new Map();
      const members = global.roomMembers.get(r) || new Set();
      members.add(socket.data.username);
      global.roomMembers.set(r, members);
      const users = Array.from(new Set(Array.from(members.values ? members.values() : members)));
      io.to(r).emit('presence', { users, event: 'join', user: socket.data.username, room: r });
      callback && callback({ ok: true, room: r });
    } catch (e) {
      const cb = args.find(a => typeof a === 'function');
      cb && cb({ ok: false, error: String(e) });
    }
  });

  socket.on('create-room', function(...args) {
    // signature: create-room(room, password?, cb)
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
      const dir = getRoomDir(r);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      ensureRoomFiles(r);
      // always write meta with name and createdAt; include password hash if provided
      const meta = { name: r, createdAt: Date.now() };
      if (password) {
        const salt = crypto.randomBytes(8).toString('hex');
        const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
        meta.salt = salt; meta.hash = hash;
      }
      fs.writeFileSync(roomFile(r, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      callback && callback({ ok: true, room: r });
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
