const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
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
app.get('/messages', (req, res) => {
  try {
    const before = req.query.before ? new Date(req.query.before).toISOString() : null;
    const limit = Math.min(parseInt(req.query.limit || String(HISTORY_LIMIT), 10), 1000);
    // load all messages across snapshot/log/archives but we can stop early
    const all = [];
    // load snapshot + log first
    const snap = readSnapshot(); if (Array.isArray(snap)) all.push(...snap);
    const logMsgs = readLogLines(); if (Array.isArray(logMsgs)) all.push(...logMsgs);
    // load archives metadata to selectively read only needed archives
    const idxFile = path.join(DATA_DIR, 'archives.json');
    let idx = [];
    try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8') || '[]'); } catch (e) { idx = []; }
    // include archives whose maxTs is >= before (or include all if no before)
    const candidate = idx.slice().sort((a,b) => b.mtime - a.mtime);
    for (const meta of candidate) {
      // if before is present and meta.maxTs < before we can skip older archives
      if (before && meta.maxTs && meta.maxTs < before) break;
      // read archive
      const arr = loadArchive(path.join(DATA_DIR, meta.file));
      if (Array.isArray(arr)) all.push(...arr);
    }
    // sort by ts asc
    all.sort((a,b) => new Date(a.ts) - new Date(b.ts));
    // filter by before if provided
    let filtered = all;
    if (before) filtered = all.filter(m => new Date(m.ts) < new Date(before));
    // return last `limit` messages before 'before' (so newest last)
    const result = filtered.slice(-limit);
    res.json({ ok: true, count: result.length, messages: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const DATA_DIR = path.join(__dirname, 'data');
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
if (!fs.existsSync(SNAPSHOT_FILE)) fs.writeFileSync(SNAPSHOT_FILE, '[]', 'utf8');
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');

function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8') || '[]');
  } catch (e) {
    console.error('readSnapshot failed', e);
    return [];
  }
}

function readLogLines() {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.error('readLogLines failed', e);
    return [];
  }
}

function listArchives() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('messages-') && (f.endsWith('.json') || f.endsWith('.json.gz')))
    .map(f => ({ name: f, path: path.join(DATA_DIR, f) }))
    .sort((a, b) => fs.statSync(a.path).mtimeMs - fs.statSync(b.path).mtimeMs);
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
function loadAllMessages(limit = HISTORY_LIMIT) {
  try {
    let all = [];
    const snapshot = readSnapshot();
    if (Array.isArray(snapshot)) all = all.concat(snapshot);
    const logMsgs = readLogLines();
    if (Array.isArray(logMsgs)) all = all.concat(logMsgs);
    const archives = listArchives();
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

function compactAndRotate() {
  try {
    // build combined array
    const all = [];
    const snapshot = readSnapshot(); if (Array.isArray(snapshot)) all.push(...snapshot);
    const logMsgs = readLogLines(); if (Array.isArray(logMsgs)) all.push(...logMsgs);
    // keep last MAX_MESSAGES as new snapshot
    const keep = all.slice(-MAX_MESSAGES);

    // create a daily archive with timestamp and date
    const now = new Date();
    const day = now.toISOString().slice(0,10); // YYYY-MM-DD
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const archiveBasename = `messages-${day}-${ts}.json`;
    const archivePath = path.join(DATA_DIR, archiveBasename);
    fs.writeFileSync(archivePath, JSON.stringify(all, null, 2), 'utf8');
    const gz = zlib.gzipSync(fs.readFileSync(archivePath));
    const gzPath = archivePath + '.gz';
    fs.writeFileSync(gzPath, gz);
    try { fs.unlinkSync(archivePath); } catch (e) {}

    // write snapshot (last MAX_MESSAGES)
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(keep, null, 2), 'utf8');
    // truncate log
    fs.writeFileSync(LOG_FILE, '', 'utf8');

    // update archives index
    const idxFile = path.join(DATA_DIR, 'archives.json');
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
      try { fs.unlinkSync(path.join(DATA_DIR, rem.file)); } catch (e) { /* ignore */ }
    }
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  } catch (e) {
    console.error('compactAndRotate failed', e);
  }
}

let lastCompact = Date.now();

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    const logSize = stat.size || 0;
    const snapshot = readSnapshot();
    const totalMsgs = (Array.isArray(snapshot) ? snapshot.length : 0) + readLogLines().length;
    const now = Date.now();
    if (logSize >= MAX_FILE_SIZE || totalMsgs >= MAX_MESSAGES || (now - lastCompact) >= COMPACT_AFTER_MS) {
      compactAndRotate();
      lastCompact = Date.now();
    }
  } catch (e) {
    console.error('rotateIfNeeded failed', e);
  }
}

function appendMessage(msg) {
  try {
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    rotateIfNeeded();
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
    // send recent history (uses rotated archives too)
    const msgs = loadAllMessages(HISTORY_LIMIT);
    socket.emit('history', msgs);
    // register presence
    global.onlineMap.set(socket.id, socket.data.username);
    const users = Array.from(new Set(Array.from(global.onlineMap.values())));
    io.emit('presence', { users, event: 'join', user: socket.data.username });
  });

  socket.on('send', (text) => {
    const username = socket.data.username || '匿名';
    const msg = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 9),
      user: username,
      text: text,
      ts: new Date().toISOString()
    };
    appendMessage(msg);
    io.emit('message', msg);
  });

  socket.on('disconnect', () => {
    console.log('client disconnected', socket.id);
    const name = (global.onlineMap && global.onlineMap.get(socket.id)) || null;
    if (global.onlineMap) global.onlineMap.delete(socket.id);
    const users = Array.from(new Set(Array.from(global.onlineMap ? global.onlineMap.values() : [])));
    if (name) io.emit('presence', { users, event: 'leave', user: name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
