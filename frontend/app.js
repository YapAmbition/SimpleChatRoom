const socket = io();

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
// search removed
const roomInput = document.getElementById('roomInput');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const currentRoomEl = document.getElementById('currentRoom');

let myName = null;
let currentRoomId = null; // canonical id used for requests
let currentRoomName = 'main'; // display name
// map room id -> display name
const ROOM_MAP = {};

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
    '#f44336','#e91e63','#9c27b0','#673ab7','#3f51b5','#2196f3','#03a9f4','#00bcd4',
    '#009688','#4caf50','#8bc34a','#cddc39','#ffeb3b','#ffc107','#ff9800','#ff5722',
    '#795548','#607d8b'
  ];
  const idx = Math.abs(h) % colors.length;
  return colors[idx];
}

// Browser notification helpers
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
}

function notifyBrowserMessage(m) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!m || !m.user) return;
    // do not notify for our own messages
    if (m.user === myName) return;
    // Only show notification when page not visible (optional behaviour)
    if (!document.hidden) return;

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

function notify(text, ms = 2500) {
  const n = document.createElement('div');
  n.className = 'notification';
  n.textContent = text;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

function esc(s) { return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Format message text for HTML: escape then convert newlines to <br>
function formatText(s) {
  return esc(s).replace(/\r?\n/g, '<br>');
}

function addMessage(m) {
  const el = document.createElement('div');
  // mark message as from me or other
  const cls = (m.user === myName) ? 'message me' : 'message other';
  el.className = cls;
  // bubble layout: avatar + bubble
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = (m.user || '?').slice(0,1);
  avatar.title = m.user || '';
  avatar.style.backgroundColor = hashStringToColor(m.user || '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `<div class="meta"><strong>${esc(m.user)}</strong> <span class="ts">${new Date(m.ts).toLocaleTimeString()}</span></div><div class="text">${formatText(m.text)}</div>`;
  if (m.user === myName) {
    el.appendChild(bubble);
    el.appendChild(avatar);
  } else {
    el.appendChild(avatar);
    el.appendChild(bubble);
  }
  messagesEl.appendChild(el);
  // auto-scroll only if near bottom
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// insertMessageAtTop used when loading older messages
function insertMessageAtTop(m) {
  const el = document.createElement('div');
  const cls = (m.user === myName) ? 'message me' : 'message other';
  el.className = cls;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = (m.user || '?').slice(0,1);
  avatar.title = m.user || '';
  avatar.style.backgroundColor = hashStringToColor(m.user || '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `<div class="meta"><strong>${esc(m.user)}</strong> <span class="ts">${new Date(m.ts).toLocaleTimeString()}</span></div><div class="text">${formatText(m.text)}</div>`;
  if (m.user === myName) {
    el.appendChild(bubble);
    el.appendChild(avatar);
  } else {
    el.appendChild(avatar);
    el.appendChild(bubble);
  }
  messagesEl.insertBefore(el, messagesEl.firstChild);
}

loginBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { notify('请输入用户名'); usernameInput.focus(); return; }
  socket.emit('login', name, async (res) => {
    if (res && res.ok) {
      // hide overlay modal and enable chat
      overlay.style.display = 'none';
      loginBox.classList.add('hidden');
      chatBox.classList.remove('hidden');
      chatBox.classList.remove('chat-dimmed');
  meLabel.textContent = res.username;
  myName = res.username;
  // update header avatar and name
  if (headerAvatar) { headerAvatar.textContent = myName ? myName.slice(0,1) : ''; headerAvatar.style.backgroundColor = hashStringToColor(myName || ''); }
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
  loginAvatar.textContent = v ? v.slice(0,1) : '';
  loginAvatar.style.backgroundColor = hashStringToColor(v || '');
  if (headerAvatar) { headerAvatar.textContent = v ? v.slice(0,1) : ''; headerAvatar.style.backgroundColor = hashStringToColor(v || ''); }
});

async function loadRooms() {
  try {
    const res = await fetch('/rooms');
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
      const c = await fetch('/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: rname, password: pw || '' }) });
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
    const res = await fetch('/room-exists?room=' + encodeURIComponent(r));
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

// IME composition handling: do not send message when composing (user selecting IME candidates)
let isComposing = false;
msgInput.addEventListener('compositionstart', () => { isComposing = true; });
msgInput.addEventListener('compositionend', () => { 
  // compositionend may be immediately followed by an Enter key event in some IMEs,
  // so clear composing flag on next tick to avoid swallowing a real Enter after composition.
  setTimeout(() => { isComposing = false; }, 0);
});

msgInput.addEventListener('keydown', (e) => {
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
    const res = await fetch('/messages?' + params.toString());
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
