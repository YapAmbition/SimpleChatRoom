// Detect sub-path prefix for reverse proxy deployment (e.g. /chat-room)
// Works both locally (BASE_PATH='') and behind nginx sub-path
const BASE_PATH = window.location.pathname.replace(/\/+$/, '');
const socket = io({ path: BASE_PATH + '/socket.io' });

// ========== E2E Encryption (ECDH P-256 + AES-256-GCM) ==========
let e2eKey = null;      // CryptoKey for AES-256-GCM (null = not established)
let e2eEnabled = false;  // true after successful key exchange

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function e2eEncrypt(plaintext) {
  if (!e2eKey) throw new Error('e2e key not established');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    e2eKey,
    new TextEncoder().encode(plaintext)
  );
  return { _enc: 1, ct: bytesToB64(enc), iv: bytesToB64(iv) };
}

async function e2eDecrypt(envelope) {
  if (!e2eKey) throw new Error('e2e key not established');
  const ct = b64ToBytes(envelope.ct);
  const iv = b64ToBytes(envelope.iv);
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    e2eKey,
    ct
  );
  return new TextDecoder().decode(dec);
}

async function performKeyExchange() {
  try {
    // 1. Fetch server ECDH public key
    const res = await fetch(BASE_PATH + '/e2e/pubkey');
    const json = await res.json();
    if (!json || !json.pubkey) throw new Error('no server pubkey');

    // 2. Generate ephemeral ECDH key pair (P-256)
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );

    // 3. Export client public key (raw uncompressed point)
    const clientPubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const clientPubB64 = bytesToB64(clientPubRaw);

    // 4. Import server public key
    const serverPubBytes = b64ToBytes(json.pubkey);
    const serverPubKey = await crypto.subtle.importKey(
      'raw',
      serverPubBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // 5. Derive shared secret via ECDH
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverPubKey },
      keyPair.privateKey,
      256
    );

    // 6. HKDF: shared secret -> AES-256-GCM key
    const hkdfKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey']
    );

    e2eKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('scr-e2e-salt'),
        info: new TextEncoder().encode('scr-e2e-aes-key')
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // 7. Send client public key to server for server-side key derivation
    await new Promise((resolve, reject) => {
      socket.emit('e2e-exchange', { pubkey: clientPubB64 }, (resp) => {
        if (resp && resp.ok) resolve();
        else reject(new Error((resp && resp.error) || 'e2e exchange failed'));
      });
    });

    e2eEnabled = true;
    console.log('[e2e] key exchange complete');
  } catch (e) {
    console.error('[e2e] key exchange failed:', e);
    e2eKey = null;
    e2eEnabled = false;
  }
}

// Connection status indicator
const connStatusEl = document.getElementById('connStatus');
const connBanner = document.getElementById('connBanner');
let isConnected = false;
function setConnStatus(state) {
  isConnected = (state === 'connected');
  if (connStatusEl) {
    connStatusEl.className = 'conn-status ' + state;
    const labels = { connected: '已连接', disconnected: '已断开', connecting: '连接中...' };
    connStatusEl.title = labels[state] || state;
  }
  if (connBanner) {
    connBanner.style.display = isConnected ? 'none' : 'block';
    connBanner.textContent = state === 'connecting' ? '正在重新连接...' : '连接已断开，正在尝试重连...';
  }
}
setConnStatus('connecting');

// Auto re-login and re-join room after reconnect
socket.on('connect', async () => {
  setConnStatus('connected');
  // Perform E2E key exchange on every new connection
  await performKeyExchange();
  if (myName && currentRoomId) {
    socket.emit('login', myName, (res) => {
      if (res && res.ok) {
        socket.emit('join-room', currentRoomId, null, () => {});
      }
    });
  }
});
socket.on('disconnect', () => { setConnStatus('disconnected'); });
socket.on('connect_error', () => { setConnStatus('disconnected'); });
socket.io.on('reconnect_attempt', () => { setConnStatus('connecting'); });

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
let currentRoomName = '聊天大厅'; // display name
// map room id -> display name
const ROOM_MAP = {};
let maxUploadFileSize = 10 * 1024 * 1024; // default 10MB, updated from server
// ===== Emoji Data =====
const EMOJI_DATA = [
  { icon: '\u{1F600}', label: '笑脸', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
  { icon: '\u{1F44B}', label: '手势', emojis: ['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','👃','👀','👁','👅','👄','💋','🧠','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','💕','💞','💓','💗','💖','💘','💝','💟'] },
  { icon: '\u{1F431}', label: '动物', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿','🦔','🐾','🐉','🐲'] },
  { icon: '\u{1F34E}', label: '食物', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🌽','🥕','🧄','🧅','🥔','🍠','🥜','🌰','🍞','🥐','🥖','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🥙','🧆','🥚','🍳','🥘','🍲','🥣','🥗','🍿','🧈','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🍵','🍶','🍾','🍷','🍸','🍹','🍺','🍻','🥂','🥃','🥤','🧋','🧃'] },
  { icon: '\u{26BD}', label: '活动', emojis: ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🏑','🥍','🏏','⛳','🏹','🎣','🥊','🥋','🎽','🛹','🛼','🛷','⛸','🥌','🎿','🏂','🏋️','🤸','🤺','⛹','🤾','🏌','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆','🥇','🥈','🥉','🏅','🎖','🎗','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','🎲','♟','🎯','🎳','🎮','🎰','🧩'] },
  { icon: '\u{2708}', label: '旅行', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍','🛵','🚲','🛴','🚏','🚨','🚥','🚦','🛑','🚧','⛽','🚢','⛵','🚤','🛳','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','✈️','🛫','🛬','🛩','💺','🚀','🛸','🚁','🏠','🏡','🏘','🏢','🏣','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🕍','⛩','⛲','🌁','🌃','🌄','🌅','🌆','🌇','🌉'] },
  { icon: '\u{1F4A1}', label: '物品', emojis: ['💡','🔦','🕯','🧯','💰','💳','💎','⚖️','🧰','🔧','🔩','⚙️','🧲','🔫','💣','🔪','🗡','🛡','🚬','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','💊','💉','🩸','🩹','🩺','🏷','🔖','📰','📮','✉️','📧','📩','📨','📤','📥','📦','📫','📪','📬','📭','📄','📃','📋','📝','📁','📂','📅','📆','📇','📈','📉','📊','📌','📍','📎','🖇','📏','📐','✂️','🗃','🗄','🗑','🔒','🔓','🔑','🗝'] },
  { icon: '\u{2764}', label: '符号', emojis: ['☮️','✝️','☪️','☸️','✡️','🔯','☯️','☦️','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','☢️','☣️','🈶','🈚','✴️','🆚','💮','🉐','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','⚠️','🚸','🔱','⚜️','♻️','✅','💠','🌐','💤','🏧','🚾','♿','🅿️','🈳','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','▶️','⏸','⏹','⏺','⏭','⏮','⏩','⏪','🔼','🔽','➡️','⬅️','⬆️','⬇️','🔀','🔁','🔂','🔄','🎵','🎶','➕','➖','➗','✖️','💲','💱','™️','©️','®️'] }
];


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

// Click handler (event delegation on messages container: lightbox + copy)
messagesEl.addEventListener('click', (e) => {
  // Lightbox: clicking on image preview opens lightbox
  const imgEl = e.target.closest('.file-preview');
  if (imgEl && imgEl.dataset.full) {
    e.preventDefault();
    e.stopPropagation();
    const lb = document.getElementById('lightbox');
    document.getElementById('lightboxImg').src = imgEl.dataset.full;
    lb.style.display = 'flex';
    return;
  }
  // Sticker collect button
  const collectBtn = e.target.closest('.sticker-collect-btn');
  if (collectBtn) {
    e.preventDefault();
    e.stopPropagation();
    const url = collectBtn.getAttribute('data-url');
    if (url && myName) {
      collectSticker(url, collectBtn);
    }
    return;
  }
  // Copy button
  const btn = e.target.closest('.copy-btn');
  if (btn) {
    const text = btn.getAttribute('data-copy') || '';
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    }).catch(() => { notify('复制失败'); });
    return;
  }
  // Raw/Markdown toggle button
  const rawBtn = e.target.closest('.raw-btn');
  if (rawBtn) {
    const mode = rawBtn.getAttribute('data-mode');
    const rawText = rawBtn.getAttribute('data-raw') || '';
    const textEl = rawBtn.closest('.message').querySelector('.text');
    if (!textEl) return;
    if (mode === 'rendered') {
      // Switch to raw text view
      textEl.textContent = rawText;
      textEl.classList.remove('markdown-body');
      textEl.classList.add('raw-text');
      rawBtn.textContent = '渲染';
      rawBtn.setAttribute('data-mode', 'raw');
    } else {
      // Switch back to markdown rendered view
      textEl.innerHTML = formatText(rawText);
      textEl.classList.remove('raw-text');
      textEl.classList.add('markdown-body');
      rawBtn.textContent = '原文';
      rawBtn.setAttribute('data-mode', 'rendered');
    }
    return;
  }
});

function notify(text, ms = 2500) {
  const n = document.createElement('div');
  n.className = 'notification';
  n.textContent = text;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

function esc(s) { return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Configure marked for chat messages
(function() {
  if (typeof marked !== 'undefined') {
    marked.setOptions({
      breaks: true,       // Convert \n to <br> (chat-friendly)
      gfm: true,          // GitHub Flavored Markdown
    });
  }
})();

// Format message text for HTML: render Markdown with sanitization
function formatText(s) {
  if (!s) return '';
  // If marked or DOMPurify unavailable, fall back to plain escaped text
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return esc(s);
  }
  try {
    let text = s;

    // Fix: unescape literal \n and \t (common in AI model responses)
    // Preserve \\n → \n display, then convert \n → real newline
    text = text.replace(/\\\\n/g, '\x00ESC_N\x00');
    text = text.replace(/\\n/g, '\n');
    text = text.replace(/\x00ESC_N\x00/g, '\\\\n');

    text = text.replace(/\\\\t/g, '\x00ESC_T\x00');
    text = text.replace(/\\t/g, '\t');
    text = text.replace(/\x00ESC_T\x00/g, '\\\\t');

    const rawHtml = marked.parse(text);
    return DOMPurify.sanitize(rawHtml);
  } catch (e) {
    return esc(s);
  }
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
    if (isImage) {
      let fileHtml = `<div class="file-message file-message-img">`;
      fileHtml += `<img class="file-preview" src="${fileUrl}" alt="${esc(f.name)}" data-full="${fileUrl}" />`;
      // Show "add to my stickers" button for image messages from others
      if (m.user !== myName) {
        fileHtml += `<button class="sticker-collect-btn" data-url="${esc(f.url)}" title="添加到我的表情包">+ 收藏</button>`;
      }
      fileHtml += `</div>`;
      return metaHtml + fileHtml;
    }
    let fileHtml = `<a class="file-message" href="${fileUrl}" target="_blank" download="${esc(f.name)}">`;
    fileHtml += `<span class="file-icon">${icon}</span>`;
    fileHtml += `<span class="file-info"><span class="file-name">${esc(f.name)}</span><span class="file-size">${formatFileSize(f.size)}</span></span>`;
    fileHtml += `</a>`;
    return metaHtml + fileHtml;
  }
  return metaHtml + `<div class="text markdown-body">${formatText(m.text)}</div>`;
}

// Build the DOM element for a single message (shared by addMessage & insertMessageAtTop)
function createMessageElement(m) {
  const el = document.createElement('div');
  el.className = (m.user === myName) ? 'message me' : 'message other';
  // avatar column: copy button, optional raw toggle, avatar
  const avatarCol = document.createElement('div');
  avatarCol.className = 'avatar-col';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = '复制';
  copyBtn.setAttribute('data-copy', m.text || '');
  avatarCol.appendChild(copyBtn);
  // raw/markdown toggle button (text messages only)
  if (!(m.type === 'file' && m.file) && m.text) {
    const rawBtn = document.createElement('button');
    rawBtn.className = 'raw-btn';
    rawBtn.textContent = '原文';
    rawBtn.setAttribute('data-raw', m.text);
    rawBtn.setAttribute('data-mode', 'rendered');
    avatarCol.appendChild(rawBtn);
  }
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = avatarChar(m.user);
  avatar.title = m.user || '';
  avatar.style.backgroundColor = hashStringToColor(m.user || '');
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
  return el;
}

function addMessage(m) {
  const el = createMessageElement(m);
  // check if near bottom BEFORE appending the new message
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
  messagesEl.appendChild(el);
  // auto-scroll if was near bottom, or if it's our own message
  if (nearBottom || m.user === myName) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// insertMessageAtTop used when loading older messages
function insertMessageAtTop(m) {
  const el = createMessageElement(m);
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
  const mainId = Object.keys(ROOM_MAP).find(k => ROOM_MAP[k] === '聊天大厅');
  currentRoomId = mainId || '聊天大厅';
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

// Guarded send: only emit when connected, otherwise notify user
// E2E: encrypts payload before sending when key exchange is established
async function guardedSend(data) {
  if (!socket.connected) {
    notify('连接已断开，无法发送');
    return false;
  }
  if (e2eEnabled && e2eKey) {
    try {
      const plain = typeof data === 'string' ? data : JSON.stringify(data);
      const envelope = await e2eEncrypt(plain);
      socket.emit('send', envelope);
      return true;
    } catch (e) {
      console.error('[e2e] encrypt failed, sending plaintext:', e);
    }
  }
  socket.emit('send', data);
  return true;
}

sendBtn.addEventListener('click', async () => {
  if (!myName) return notify('请先登录');
  const text = msgInput.value.trim();
  const hasPendingImage = !!pendingPasteFile;
  if (!text && !hasPendingImage) return;

  // send pending pasted image first
  if (hasPendingImage) {
    const file = pendingPasteFile;
    clearPastePreview();
    const formData = new FormData();
    formData.append('file', file);
    try {
      fileBtn.disabled = true; sendBtn.disabled = true;
      fileBtn.textContent = '...';
      const res = await fetch(BASE_PATH + '/upload', { method: 'POST', body: formData });
      const json = await res.json();
      if (json && json.ok && json.file) {
        await guardedSend({ type: 'file', file: json.file });
      } else {
        notify(json && json.error ? json.error : '图片上传失败');
      }
    } catch (e) {
      console.error('paste image upload failed', e);
      notify('图片上传失败');
    } finally {
      fileBtn.disabled = false; sendBtn.disabled = false;
      fileBtn.textContent = '\u{1F4CE}';
    }
  }

  // send text if any
  if (text) {
    await guardedSend(text);
  }

  msgInput.value = '';
  msgInput.focus();
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
      await guardedSend({ type: 'file', file: json.file });
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

// Paste image handling: show preview, send on user action
let pendingPasteFile = null;
const pastePreview = document.getElementById('pastePreview');
const pasteImg = document.getElementById('pasteImg');
const pasteRemove = document.getElementById('pasteRemove');

function clearPastePreview() {
  pendingPasteFile = null;
  pasteImg.src = '';
  pastePreview.style.display = 'none';
}

pasteRemove.addEventListener('click', () => {
  clearPastePreview();
  msgInput.focus();
});

msgInput.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      if (!myName) return notify('请先登录');
      const file = item.getAsFile();
      if (!file) return;
      if (file.size > maxUploadFileSize) {
        const maxMB = (maxUploadFileSize / (1024 * 1024)).toFixed(1);
        notify(`图片大小超过限制 (最大 ${maxMB}MB)`);
        return;
      }
      const ext = file.type.split('/')[1] || 'png';
      const fname = `clipboard_${Date.now()}.${ext}`;
      pendingPasteFile = new File([file], fname, { type: file.type });
      const reader = new FileReader();
      reader.onload = (ev) => {
        pasteImg.src = ev.target.result;
        pastePreview.style.display = '';
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

// Lightbox close handlers
(function() {
  var lightbox = document.getElementById('lightbox');
  var lightboxClose = document.getElementById('lightboxClose');
  function closeLightbox() { lightbox.style.display = 'none'; document.getElementById('lightboxImg').src = ''; }
  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function(e) { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && lightbox.style.display !== 'none') closeLightbox(); });
})();

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

// ===== Emoji / Sticker Panel =====
const emojiBtn = document.getElementById('emojiBtn');
const emojiPanel = document.getElementById('emojiPanel');
const emojiContent = document.getElementById('emojiContent');
const stickerContent = document.getElementById('stickerContent');
const emojiGrid = document.getElementById('emojiGrid');
const emojiCategories = document.getElementById('emojiCategories');
const stickerGrid = document.getElementById('stickerGrid');
const stickerInput = document.getElementById('stickerInput');

let emojiPanelOpen = false;
let emojiPanelRendered = false;
let stickerCache = null;

function renderEmojiPanel() {
  if (emojiPanelRendered) return;
  emojiPanelRendered = true;
  // Category strip
  emojiCategories.innerHTML = '';
  EMOJI_DATA.forEach((cat, i) => {
    const btn = document.createElement('button');
    btn.className = 'emoji-cat-btn' + (i === 0 ? ' active' : '');
    btn.textContent = cat.icon;
    btn.title = cat.label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      emojiCategories.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const section = emojiGrid.querySelector('[data-cat="' + i + '"]');
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    emojiCategories.appendChild(btn);
  });
  // Emoji grid
  emojiGrid.innerHTML = '';
  EMOJI_DATA.forEach((cat, i) => {
    const label = document.createElement('div');
    label.className = 'emoji-grid-section-label';
    label.textContent = cat.label;
    label.setAttribute('data-cat', i);
    emojiGrid.appendChild(label);
    const section = document.createElement('div');
    section.className = 'emoji-grid-section';
    cat.emojis.forEach(em => {
      const span = document.createElement('span');
      span.className = 'emoji-item';
      span.textContent = em;
      span.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertEmojiAtCursor(em);
      });
      section.appendChild(span);
    });
    emojiGrid.appendChild(section);
  });
}

function insertEmojiAtCursor(emoji) {
  const ta = msgInput;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  const pos = start + emoji.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
}

function toggleEmojiPanel() {
  if (emojiPanelOpen) {
    emojiPanel.style.display = 'none';
    emojiPanelOpen = false;
  } else {
    renderEmojiPanel();
    emojiPanel.style.display = 'flex';
    emojiPanelOpen = true;
  }
}

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleEmojiPanel();
});

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  if (!emojiPanelOpen) return;
  if (emojiPanel.contains(e.target) || e.target === emojiBtn) return;
  emojiPanel.style.display = 'none';
  emojiPanelOpen = false;
});

// Tab switching
emojiPanel.addEventListener('click', (e) => {
  const tab = e.target.closest('.emoji-tab');
  if (!tab) return;
  const tabName = tab.dataset.tab;
  emojiPanel.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  if (tabName === 'emoji') {
    emojiContent.style.display = '';
    stickerContent.style.display = 'none';
  } else {
    emojiContent.style.display = 'none';
    stickerContent.style.display = '';
    loadStickers();
  }
});

// ===== Sticker logic =====
async function loadStickers() {
  try {
    const params = myName ? '?user=' + encodeURIComponent(myName) : '';
    const res = await fetch(BASE_PATH + '/stickers' + params);
    const json = await res.json();
    if (json && json.ok) {
      stickerCache = json.stickers || [];
      renderStickers(stickerCache);
    }
  } catch (e) {
    console.error('loadStickers failed', e);
  }
}

function renderStickers(stickers) {
  stickerGrid.innerHTML = '';
  stickers.forEach(s => {
    const wrapper = document.createElement('div');
    wrapper.className = 'sticker-item';
    const img = document.createElement('img');
    img.src = BASE_PATH + s.url;
    img.alt = s.name;
    img.title = s.name;
    img.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sendSticker(s);
    });
    wrapper.appendChild(img);
    // Add delete button for non-built-in stickers
    if (s.source !== 'built-in') {
      const delBtn = document.createElement('button');
      delBtn.className = 'sticker-delete-btn';
      delBtn.textContent = '\u00d7';
      delBtn.title = '删除表情包';
      delBtn.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm('确定删除这个表情包？')) return;
        try {
          const res = await fetch(BASE_PATH + '/stickers/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id, user: myName })
          });
          const json = await res.json();
          if (json && json.ok) {
            stickerCache = null;
            loadStickers();
          }
        } catch (err) {
          console.error('deleteSticker failed', err);
        }
      });
      wrapper.appendChild(delBtn);
    }
    stickerGrid.appendChild(wrapper);
  });
  // Upload button
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'sticker-upload-btn';
  uploadBtn.textContent = '+';
  uploadBtn.title = '上传表情包';
  uploadBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    stickerInput.click();
  });
  stickerGrid.appendChild(uploadBtn);
}

async function sendSticker(s) {
  if (!myName) return notify('请先登录');
  const ext = s.url.split('.').pop().toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  if (!(await guardedSend({ type: 'file', file: { url: s.url, name: s.name, size: 0, mimetype: mimeMap[ext] || 'image/png', isSticker: true } }))) return;
  emojiPanel.style.display = 'none';
  emojiPanelOpen = false;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  clearUnreadTitle();
}

async function collectSticker(url, btn) {
  try {
    const res = await fetch(BASE_PATH + '/stickers/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, user: myName })
    });
    const json = await res.json();
    if (json && json.ok) {
      btn.textContent = '已收藏';
      btn.disabled = true;
      stickerCache = null; // invalidate cache
      setTimeout(() => { btn.textContent = '+ 收藏'; btn.disabled = false; }, 1500);
      notify('已添加到我的表情包');
    } else {
      notify(json && json.error ? json.error : '收藏失败');
    }
  } catch (e) {
    console.error('collectSticker failed', e);
    notify('收藏失败');
  }
}

stickerInput.addEventListener('change', async () => {
  const file = stickerInput.files[0];
  stickerInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return notify('只能上传图片文件');
  if (file.size > 2 * 1024 * 1024) return notify('表情包大小不能超过 2MB');
  const formData = new FormData();
  formData.append('sticker', file);
  if (myName) formData.append('owner', myName);
  try {
    const res = await fetch(BASE_PATH + '/stickers/upload', { method: 'POST', body: formData });
    const json = await res.json();
    if (json && json.ok && json.sticker) {
      notify('表情包上传成功');
      if (stickerCache) {
        stickerCache.push(json.sticker);
        renderStickers(stickerCache);
      }
    } else {
      notify(json && json.error ? json.error : '上传失败');
    }
  } catch (e) {
    console.error('sticker upload failed', e);
    notify('表情包上传失败');
  }
});

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
  params.set('room', currentRoomId || currentRoomName || '聊天大厅');
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
  currentRoomId = '聊天大厅';
  currentRoomName = '聊天大厅';
  const headerRoom = document.getElementById('roomTitle');
  if (headerRoom) headerRoom.textContent = '聊天大厅';
  loadRooms();
});

// Admin: room list changed (created/deleted/password changed)
socket.on('rooms-updated', () => {
  loadRooms();
});

socket.on('history', async (data) => {
  // E2E: decrypt if encrypted envelope
  let msgs = data;
  if (data && data._enc === 1 && e2eKey) {
    try {
      const plain = await e2eDecrypt(data);
      msgs = JSON.parse(plain);
    } catch (e) {
      console.error('[e2e] decrypt history failed:', e);
      return;
    }
  }
  messagesEl.innerHTML = '';
  msgs.forEach(addMessage);
  // set oldestTs for pagination
  if (msgs.length) oldestTs = msgs[0].ts;
  // scroll to bottom after loading history
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

socket.on('message', async (data) => {
  // E2E: decrypt if encrypted envelope
  let m = data;
  if (data && data._enc === 1 && e2eKey) {
    try {
      const plain = await e2eDecrypt(data);
      m = JSON.parse(plain);
    } catch (e) {
      console.error('[e2e] decrypt message failed:', e);
      return;
    }
  }
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
