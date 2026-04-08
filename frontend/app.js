// Detect sub-path prefix for reverse proxy deployment (e.g. /chat-room)
// Works both locally (BASE_PATH='') and behind nginx sub-path
const BASE_PATH = window.location.pathname.replace(/\/+$/, '');
const socket = io({ path: BASE_PATH + '/socket.io' });

const loginBox = document.getElementById('loginBox');
const chatBox = document.getElementById('chatBox');
const overlay = document.getElementById('overlay');
const usernameInput = document.getElementById('username');
const loginBtn = document.getElementById('loginBtn');
const loginAvatar = document.getElementById('loginAvatar');
const headerAvatar = document.getElementById('headerAvatar');
const roomTitleEl = document.getElementById('roomTitle');
const roomCountEl = document.getElementById('roomCount');
const meLabel = document.getElementById('me');
const messagesEl = document.getElementById('messages');
const usersEl = document.getElementById('users');
const roomsEl = document.getElementById('rooms');
const roomsToggle = document.getElementById('roomsToggle');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const fileBtn = document.getElementById('fileBtn');
const fileInput = document.getElementById('fileInput');
// search removed
const roomInput = document.getElementById('roomInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const currentRoomEl = document.getElementById('currentRoom');

let myName = null;
let currentRoomId = null; // canonical id used for requests
let currentRoomName = 'main'; // display name
// map room id -> display name
const ROOM_MAP = {};
let maxUploadFileSize = 10 * 1024 * 1024; // default 10MB, updated from server

// password modal elements
const pwModal = document.getElementById('pwModal');
const pwBox = document.getElementById('pwBox');
const pwInput = document.getElementById('pwInput');
const pwConfirm = document.getElementById('pwConfirm');
const pwCancel = document.getElementById('pwCancel');
const pwTitle = document.getElementById('pwTitle');
let pendingRoomAction = null; // { type: 'join'|'create', id, name }

// initially disable controls until user logs in
  roomInput.disabled = true;
  joinRoomBtn.disabled = true;
  msgInput.disabled = true;
  sendBtn.disabled = true;
// overlay should be visible and chat dimmed until login
overlay.style.display = 'flex';
chatBox.classList.add('chat-dimmed');

// Extract a representative character from username for avatar display
// If name contains "的", use the first char after the last "的"; otherwise use the last char
function avatarChar(name) {
  if (!name) return '?';
  const idx = name.lastIndexOf('的');
  if (idx >= 0 && idx + 1 < name.length) return name.charAt(idx + 1);
  return name.charAt(name.length - 1);
}

// Random name generator
const randomNameBtn = document.getElementById('randomNameBtn');
let nameConfig = null;

async function loadNameConfig() {
  if (nameConfig) return nameConfig;
  try {
    const res = await fetch(BASE_PATH + '/name-config.json');
    nameConfig = await res.json();
  } catch (e) {
    nameConfig = { places: ['在某处'], actions: ['做某事'], things: ['某人'] };
  }
  return nameConfig;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateRandomName() {
  const cfg = await loadNameConfig();
  return pickRandom(cfg.places) + pickRandom(cfg.actions) + '的' + pickRandom(cfg.things);
}

if (randomNameBtn) {
  randomNameBtn.addEventListener('click', async () => {
    const name = await generateRandomName();
    usernameInput.value = name;
    usernameInput.dispatchEvent(new Event('input'));
    hideNameHistory();
  });
}

// Recent username history (localStorage, max 5, most recent first)
const NAME_HISTORY_KEY = 'recentUsernames';
const NAME_HISTORY_MAX = 5;

function getNameHistory() {
  try {
    const raw = localStorage.getItem(NAME_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveNameToHistory(name) {
  if (!name) return;
  let history = getNameHistory();
  // remove duplicate then prepend
  history = history.filter(n => n !== name);
  history.unshift(name);
  if (history.length > NAME_HISTORY_MAX) history = history.slice(0, NAME_HISTORY_MAX);
  localStorage.setItem(NAME_HISTORY_KEY, JSON.stringify(history));
}

// Dropdown for name history
let nameHistoryEl = null;

function createNameHistoryDropdown() {
  if (nameHistoryEl) return nameHistoryEl;
  nameHistoryEl = document.createElement('ul');
  nameHistoryEl.className = 'name-history-dropdown';
  usernameInput.parentElement.style.position = 'relative';
  usernameInput.parentElement.appendChild(nameHistoryEl);
  return nameHistoryEl;
}

function showNameHistory() {
  const history = getNameHistory();
  if (!history.length) return;
  if (usernameInput.value.trim()) return; // only show when input is empty
  const dropdown = createNameHistoryDropdown();
  dropdown.innerHTML = '';
  history.forEach(name => {
    const li = document.createElement('li');
    li.textContent = name;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // prevent blur
      usernameInput.value = name;
      usernameInput.dispatchEvent(new Event('input'));
      hideNameHistory();
    });
    dropdown.appendChild(li);
  });
  dropdown.style.display = 'block';
}

function hideNameHistory() {
  if (nameHistoryEl) nameHistoryEl.style.display = 'none';
}

usernameInput.addEventListener('focus', () => { showNameHistory(); });
usernameInput.addEventListener('blur', () => { hideNameHistory(); });
usernameInput.addEventListener('input', () => {
  if (usernameInput.value.trim()) hideNameHistory(); else showNameHistory();
});

// avatar color by username
function hashStringToColor(str) {
  if (!str) return '#cccccc';
  // simple djb2 hash
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i); /* h * 33 + c */
    h = h & h;
  }
  const colors = [
    '#FFB3B3','#FFCBA4','#FFE0A3','#FFF1A3','#E8F5A3','#B8E6B8','#A3E0D8',
    '#A3D5F0','#B3C7F7','#C8B3F7','#E0B3F7','#F7B3E0','#F7B3C8','#B3F0E8',
    '#C7E8A3','#F0D5A3','#A3E8E8','#D5C7F0','#F0C7D5','#C7F0D5'
  ];
  const idx = Math.abs(h) % colors.length;
  return colors[idx];
}

// Browser notification helpers
let notifyEnabled = localStorage.getItem('notifyEnabled') === 'true';
const notifyToggle = document.getElementById('notifyToggle');

if (notifyToggle) {
  notifyToggle.checked = notifyEnabled;
  notifyToggle.addEventListener('change', () => {
    notifyEnabled = notifyToggle.checked;
    localStorage.setItem('notifyEnabled', String(notifyEnabled));
    if (notifyEnabled) requestNotificationPermission();
  });
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
}

function notifyBrowserMessage(m) {
  try {
    if (!notifyEnabled) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!m || !m.user) return;
    if (m.user === myName) return;
    // only notify when page does not have focus (e.g. user is in another app)
    if (document.hasFocus()) return;

    const title = `${m.user} 发送了新消息`;
    const body = (m.text || '').slice(0, 140);
    const n = new Notification(title, { body, tag: m.id });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.error('notifyBrowserMessage failed', e);
  }
}

// Title unread marker
const originalTitle = document.title || 'Chat';
let hasUnread = false;
function setUnreadTitle() {
  if (hasUnread) return;
  try { document.title = `【新消息】 ${originalTitle}`; hasUnread = true; } catch (e) { }
}
function clearUnreadTitle() {
  if (!hasUnread) return;
  try { document.title = originalTitle; hasUnread = false; } catch (e) { }
}

// Clear unread when user focuses or page becomes visible
window.addEventListener('focus', clearUnreadTitle);
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearUnreadTitle(); });

// Copy button handler (event delegation on messages container)
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const text = btn.getAttribute('data-copy') || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  }).catch(() => { notify('复制失败'); });
});

function notify(text, ms = 2500) {
  const n = document.createElement('div');
  n.className = 'notification';
  n.textContent = text;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

function esc(s) { return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Format message text for HTML: escape only (whitespace preserved via CSS white-space:pre-wrap)
function formatText(s) {
  return esc(s);
}

// Format file size for display
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Get file icon based on mimetype
function getFileIcon(mimetype) {
  if (!mimetype) return '\u{1F4C4}';
  if (mimetype.startsWith('image/')) return '\u{1F5BC}';
  if (mimetype.startsWith('video/')) return '\u{1F3AC}';
  if (mimetype.startsWith('audio/')) return '\u{1F3B5}';
  if (mimetype.includes('pdf')) return '\u{1F4D1}';
  if (mimetype.includes('zip') || mimetype.includes('rar') || mimetype.includes('tar') || mimetype.includes('gz')) return '\u{1F4E6}';
  return '\u{1F4C4}';
}

// Render the content area of a message bubble (text or file)
function renderBubbleContent(m) {
  const metaHtml = `<div class="meta"><strong>${esc(m.user)}</strong> <span class="ts">${new Date(m.ts).toLocaleTimeString()}</span></div>`;
  if (m.type === 'file' && m.file) {
    const f = m.file;
    const icon = getFileIcon(f.mimetype);
    const isImage = f.mimetype && f.mimetype.startsWith('image/');
    const fileUrl = esc(BASE_PATH + f.url);
    let fileHtml = `<a class="file-message" href="${fileUrl}" target="_blank" download="${esc(f.name)}">`;
    if (isImage) {
      fileHtml += `<img class="file-preview" src="${fileUrl}" alt="${esc(f.name)}" />`;
    } else {
      fileHtml += `<span class="file-icon">${icon}</span>`;
    }
    fileHtml += `<span class="file-info"><span class="file-name">${esc(f.name)}</span><span class="file-size">${formatFileSize(f.size)}</span></span>`;
    fileHtml += `</a>`;
    return metaHtml + fileHtml;
  }
  return metaHtml + `<div class="text">${formatText(m.text)}</div>`;
}

function addMessage(m) {
  const el = document.createElement('div');
  const cls = (m.user === myName) ? 'message me' : 'message other';
  el.className = cls;
  // avatar column: copy button on top, avatar on bottom
  const avatarCol = document.createElement('div');
  avatarCol.className = 'avatar-col';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制';
  copyBtn.setAttribute('data-copy', m.text || '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = avatarChar(m.user);
  avatar.title = m.user || '';
  avatar.style.backgroundColor = hashStringToColor(m.user || '');
  avatarCol.appendChild(copyBtn);
  avatarCol.appendChild(avatar);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderBubbleContent(m);
  if (m.user === myName) {
    el.appendChild(bubble);
    el.appendChild(avatarCol);
  } else {
    el.appendChild(avatarCol);
    el.appendChild(bubble);
  }
  // check if near bottom BEFORE appending the new message
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
  messagesEl.appendChild(el);
  // auto-scroll if was near bottom, or if it's our own message
  if (nearBottom || m.user === myName) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// insertMessageAtTop used when loading older messages
function insertMessageAtTop(m) {
  const el = document.createElement('div');
  const cls = (m.user === myName) ? 'message me' : 'message other';
  el.className = cls;
  const avatarCol = document.createElement('div');
  avatarCol.className = 'avatar-col';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制';
  copyBtn.setAttribute('data-copy', m.text || '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = avatarChar(m.user);
  avatar.title = m.user || '';
  avatar.style.backgroundColor = hashStringToColor(m.user || '');
  avatarCol.appendChild(copyBtn);
  avatarCol.appendChild(avatar);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderBubbleContent(m);
  if (m.user === myName) {
    el.appendChild(bubble);
    el.appendChild(avatarCol);
  } else {
    el.appendChild(avatarCol);
    el.appendChild(bubble);
  }
  messagesEl.insertBefore(el, messagesEl.firstChild);
}

loginBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { notify('请输入用户名'); usernameInput.focus(); return; }
  socket.emit('login', name, async (res) => {
    if (res && res.ok) {
      // save username to history
      saveNameToHistory(name);
      hideNameHistory();
      // hide overlay modal and enable chat
      overlay.style.display = 'none';
      loginBox.classList.add('hidden');
      chatBox.classList.remove('hidden');
      chatBox.classList.remove('chat-dimmed');
  meLabel.textContent = res.username;
  myName = res.username;
  // update header avatar and name
  if (headerAvatar) { headerAvatar.textContent = avatarChar(myName); headerAvatar.style.backgroundColor = hashStringToColor(myName || ''); }
  const headerName = document.getElementById('me'); if (headerName) headerName.textContent = myName;
      // request browser notification permission
      requestNotificationPermission();
  // show current room (header)
  const headerRoom = document.getElementById('currentRoom');
  if (headerRoom) headerRoom.textContent = `房间: ${currentRoomName}`;
  // enable controls
  roomInput.disabled = false;
  joinRoomBtn.disabled = false;
  msgInput.disabled = false;
  sendBtn.disabled = false;
  // load room list and resolve default room id if available
  await loadRooms();
  // load upload config from server
  try {
    const cfgRes = await fetch(BASE_PATH + '/upload-config');
    const cfgJson = await cfgRes.json();
    if (cfgJson && cfgJson.ok && cfgJson.maxFileSize) maxUploadFileSize = cfgJson.maxFileSize;
  } catch (e) { /* use default */ }
  const mainId = Object.keys(ROOM_MAP).find(k => ROOM_MAP[k] === 'main');
  currentRoomId = mainId || 'main';
    } else {
      // login rejected (duplicate name or other error)
      notify((res && res.error) ? res.error : '登录失败');
    }
  });
});

// live avatar preview while typing username
usernameInput.addEventListener('input', () => {
  const v = usernameInput.value.trim();
  loginAvatar.textContent = avatarChar(v);
  loginAvatar.style.backgroundColor = hashStringToColor(v || '');
  if (headerAvatar) { headerAvatar.textContent = avatarChar(v); headerAvatar.style.backgroundColor = hashStringToColor(v || ''); }
});

async function loadRooms() {
  try {
    const res = await fetch(BASE_PATH + '/rooms');
    const json = await res.json();
    if (!json || !Array.isArray(json.rooms)) return;
    roomsEl.innerHTML = '';
    json.rooms.forEach(r => {
      ROOM_MAP[r.id] = r.name;
      const li = document.createElement('li');
      li.textContent = r.name + (r.hasPassword ? ' 🔒' : '');
      li.style.cursor = 'pointer';
      li.dataset.rid = r.id;
      li.addEventListener('click', async () => {
        if (!myName) return notify('请先登录');
        if (r.name === currentRoomName) return notify('已在该房间');
        // open password modal for join
        pendingRoomAction = { type: 'join', id: r.id, name: r.name };
        pwTitle.textContent = `加入房间：${r.name}`;
        pwInput.value = '';
        pwModal.style.display = 'flex';
        pwInput.focus();
      });
      roomsEl.appendChild(li);
    });
  } catch (e) {
    console.error('loadRooms failed', e);
  }
}

// mobile sidebar toggle
if (roomsToggle) {
  roomsToggle.addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    if (sb.classList.contains('open')) sb.classList.remove('open'); else sb.classList.add('open');
  });
  // close sidebar when clicking on messages area (mobile)
  const messagesArea = document.getElementById('messages');
  if (messagesArea) messagesArea.addEventListener('click', () => { const sb = document.getElementById('sidebar'); if (sb && sb.classList.contains('open')) sb.classList.remove('open'); });
}

// pw modal handlers
pwCancel.addEventListener('click', () => {
  pendingRoomAction = null;
  pwModal.style.display = 'none';
});

pwConfirm.addEventListener('click', async () => {
  if (!pendingRoomAction) { pwModal.style.display = 'none'; return; }
  const pw = pwInput.value || '';
  if (pendingRoomAction.type === 'join') {
  // join by id
  // set tentative current room so incoming history is associated correctly
  currentRoomId = pendingRoomAction.id;
  currentRoomName = pendingRoomAction.name;
  socket.emit('join-room', pendingRoomAction.id, pw || '', (resp) => {
        if (resp && resp.ok) {
        currentRoomId = resp.id || pendingRoomAction.id;
        currentRoomName = resp.name || pendingRoomAction.name;
        const headerRoom = document.getElementById('roomTitle'); if (headerRoom) headerRoom.textContent = currentRoomName;
        notify(`已加入房间 ${currentRoomName}`);
        oldestTs = null;
        pwModal.style.display = 'none';
        pendingRoomAction = null;
      } else {
        notify(resp && resp.error ? resp.error : '加入房间失败');
      }
    });
  } else if (pendingRoomAction.type === 'create') {
    // create room on server
    try {
      const rname = pendingRoomAction.name;
      const c = await fetch(BASE_PATH + '/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: rname, password: pw || '' }) });
      const cj = await c.json();
      if (cj && cj.ok && cj.id) {
        // record mapping and reload rooms
        ROOM_MAP[cj.id] = cj.room || rname;
  // join by id
  // set tentative current room
  currentRoomId = cj.id;
  currentRoomName = rname;
  socket.emit('join-room', cj.id, pw || '', (resp) => {
          if (resp && resp.ok) {
        currentRoomId = resp.id || cj.id;
        currentRoomName = resp.name || rname;
        const headerRoom = document.getElementById('roomTitle'); if (headerRoom) headerRoom.textContent = currentRoomName;
        notify(`已创建并加入房间 ${currentRoomName}`);
            oldestTs = null;
            pwModal.style.display = 'none';
            pendingRoomAction = null;
            loadRooms();
          } else {
            notify(resp && resp.error ? resp.error : '创建或加入房间失败');
          }
        });
      } else {
        notify('创建房间失败');
      }
    } catch (e) {
      console.error('create room failed', e);
      notify('创建房间失败');
    }
  }
});

// allow Enter key in username input to submit login
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

// Join room button flow: check exists -> confirm create -> join
joinRoomBtn.addEventListener('click', async () => {
  if (!myName) return notify('请先登录');
  const r = (roomInput.value || '').trim();
  if (!r) return notify('请输入房间名');
  try {
    const res = await fetch(BASE_PATH + '/room-exists?room=' + encodeURIComponent(r));
    const json = await res.json();
    if (json && json.exists) {
      // find id for this room from ROOM_MAP (if not present, reload rooms)
      let rid = Object.keys(ROOM_MAP).find(k => ROOM_MAP[k] === r);
      if (!rid) {
        await loadRooms();
        rid = Object.keys(ROOM_MAP).find(k => ROOM_MAP[k] === r);
      }
      if (!rid) return notify('无法找到房间 ID');
      pendingRoomAction = { type: 'join', id: rid, name: r };
      pwTitle.textContent = `加入房间：${r}`;
      pwInput.value = '';
      pwModal.style.display = 'flex';
      pwInput.focus();
    } else {
      const ok = confirm(`房间 "${r}" 不存在。是否创建并加入？`);
      if (!ok) return;
      // open modal to set password and create
      pendingRoomAction = { type: 'create', name: r };
      pwTitle.textContent = `创建并加入房间：${r}`;
      pwInput.value = '';
      pwModal.style.display = 'flex';
      pwInput.focus();
    }
  } catch (e) {
    console.error('join room flow failed', e);
    notify('加入房间失败');
  }
});

sendBtn.addEventListener('click', () => {
  if (!myName) return notify('请先登录');
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('send', text);
  msgInput.value = '';
  msgInput.focus();
  // force scroll to bottom after sending
  messagesEl.scrollTop = messagesEl.scrollHeight;
  // clear unread title when we send
  clearUnreadTitle();
});

// File upload handling
fileBtn.addEventListener('click', () => {
  if (!myName) return notify('请先登录');
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = ''; // reset so same file can be selected again

  // check file size
  if (file.size > maxUploadFileSize) {
    const maxMB = (maxUploadFileSize / (1024 * 1024)).toFixed(1);
    notify(`文件大小超过限制 (最大 ${maxMB}MB)`);
    return;
  }

  // upload via HTTP
  const formData = new FormData();
  formData.append('file', file);

  try {
    fileBtn.disabled = true;
    fileBtn.textContent = '...';
    const res = await fetch(BASE_PATH + '/upload', { method: 'POST', body: formData });
    const json = await res.json();
    if (json && json.ok && json.file) {
      // send file message via socket
      socket.emit('send', { type: 'file', file: json.file });
      messagesEl.scrollTop = messagesEl.scrollHeight;
      clearUnreadTitle();
    } else {
      notify(json && json.error ? json.error : '文件上传失败');
    }
  } catch (e) {
    console.error('file upload failed', e);
    notify('文件上传失败');
  } finally {
    fileBtn.disabled = false;
    fileBtn.textContent = '\u{1F4CE}';
  }
});

// IME composition handling: do not send message when composing (user selecting IME candidates)
let isComposing = false;
msgInput.addEventListener('compositionstart', () => { isComposing = true; });
msgInput.addEventListener('compositionend', () => { 
  // compositionend may be immediately followed by an Enter key event in some IMEs,
  // so clear composing flag on next tick to avoid swallowing a real Enter after composition.
  setTimeout(() => { isComposing = false; }, 0);
});

msgInput.addEventListener('keydown', (e) => {
  // Tab key: insert tab character instead of moving focus
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
    return;
  }
  if (e.key === 'Enter') {
    if (isComposing) return; // ignore Enter while composing
    // Mac: metaKey (Command) + Enter -> newline
    // Windows/Linux: ctrlKey + Enter -> newline
    if (e.metaKey || e.ctrlKey) {
      // insert newline at cursor position for textarea
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.slice(0, start) + '\n' + val.slice(end);
      ta.value = newVal;
      // move caret after the newline
      const pos = start + 1;
      ta.selectionStart = ta.selectionEnd = pos;
      // do not send
      e.preventDefault();
      return;
    }
    // plain Enter -> send
    e.preventDefault();
    sendBtn.click();
  }
});

// Emoji picker
// emoji picker removed

// infinite scroll: load older messages when user scrolls near the top
let oldestTs = null;
let loadingOlder = false;
messagesEl.addEventListener('scroll', async () => {
  if (loadingOlder) return;
  if (messagesEl.scrollTop > 150) return; // not near top
  if (!oldestTs) return; // nothing to load
  loadingOlder = true;
  const params = new URLSearchParams();
  params.set('limit', '50');
  params.set('room', currentRoomId || currentRoomName || 'main');
  params.set('before', oldestTs);
  try {
    const prevHeight = messagesEl.scrollHeight;
    const res = await fetch(BASE_PATH + '/messages?' + params.toString());
    const json = await res.json();
    if (json && Array.isArray(json.messages) && json.messages.length) {
      json.messages.forEach(m => insertMessageAtTop(m));
      const added = messagesEl.scrollHeight - prevHeight;
      messagesEl.scrollTop = added + messagesEl.scrollTop;
      oldestTs = json.messages[0].ts;
    }
  } catch (e) {
    console.error('load older failed', e);
  }
  loadingOlder = false;
});

// search removed from UI

// Admin: room deleted by admin — switch to main room
socket.on('room-deleted', (data) => {
  notify(`房间 "${data.roomName}" 已被管理员删除，已自动回到主房间`);
  currentRoomId = 'main';
  currentRoomName = 'main';
  const headerRoom = document.getElementById('roomTitle');
  if (headerRoom) headerRoom.textContent = 'main';
  loadRooms();
});

// Admin: room list changed (created/deleted/password changed)
socket.on('rooms-updated', () => {
  loadRooms();
});

socket.on('history', (msgs) => {
  messagesEl.innerHTML = '';
  msgs.forEach(addMessage);
  // set oldestTs for pagination
  if (msgs.length) oldestTs = msgs[0].ts;
  // scroll to bottom after loading history
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

socket.on('message', (m) => {
  // only show messages for current room (compare with id or name)
  const roomMatch = m.room && (m.room === currentRoomId || m.room === currentRoomName);
  if (m.room && !roomMatch) return;
  addMessage(m);
  // show browser notification for messages from others
  notifyBrowserMessage(m);
  // if message is from other user and page is hidden, set unread title
  if (m.user !== myName && document.hidden) setUnreadTitle();
});

socket.on('presence', (data) => {
  // data: { users: [...], event: 'join'|'leave', user, room }
  if (data.room && !(data.room === currentRoomId || data.room === currentRoomName)) return; // ignore other rooms
  if (Array.isArray(data.users)) {
    usersEl.innerHTML = '';
    data.users.forEach(u => {
      const li = document.createElement('li');
      li.textContent = u;
      if (u === myName) li.style.fontWeight = '700';
      usersEl.appendChild(li);
    });
    // update header room count
    const rc = document.getElementById('roomCount'); if (rc) rc.textContent = String(data.users.length || 0);
  }
  if (data.event === 'join') notify(`${data.user} 已加入`);
  if (data.event === 'leave') notify(`${data.user} 已离开`);
});
