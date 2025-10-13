const socket = io();

const loginBox = document.getElementById('loginBox');
const chatBox = document.getElementById('chatBox');
const usernameInput = document.getElementById('username');
const loginBtn = document.getElementById('loginBtn');
const meLabel = document.getElementById('me');
const messagesEl = document.getElementById('messages');
const usersEl = document.getElementById('users');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');

let myName = null;

function notify(text, ms = 2500) {
  const n = document.createElement('div');
  n.className = 'notification';
  n.textContent = text;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

function esc(s) { return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function addMessage(m) {
  const el = document.createElement('div');
  el.className = 'message';
  el.innerHTML = `<div class="meta"><strong>${esc(m.user)}</strong> <span class="ts">${new Date(m.ts).toLocaleTimeString()}</span></div><div class="text">${esc(m.text)}</div>`;
  messagesEl.appendChild(el);
  // auto-scroll only if near bottom
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// insertMessageAtTop used when loading older messages
function insertMessageAtTop(m) {
  const el = document.createElement('div');
  el.className = 'message';
  el.innerHTML = `<div class="meta"><strong>${esc(m.user)}</strong> <span class="ts">${new Date(m.ts).toLocaleTimeString()}</span></div><div class="text">${esc(m.text)}</div>`;
  messagesEl.insertBefore(el, messagesEl.firstChild);
}

loginBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim() || '匿名';
  socket.emit('login', name, (res) => {
    if (res && res.ok) {
      loginBox.classList.add('hidden');
      chatBox.classList.remove('hidden');
      meLabel.textContent = res.username;
      myName = res.username;
    }
  });
});

sendBtn.addEventListener('click', () => {
  const text = msgInput.value.trim();
  if (!text) return;
  socket.emit('send', text);
  msgInput.value = '';
  msgInput.focus();
  // force scroll to bottom after sending
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

msgInput.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

// Emoji picker
// emoji picker removed

// Load more (pagination) - keep track of oldest timestamp loaded
let oldestTs = null;
const loadMoreBtn = document.getElementById('loadMoreBtn');
loadMoreBtn.addEventListener('click', async () => {
  const params = new URLSearchParams();
  if (oldestTs) params.set('before', oldestTs);
  params.set('limit', '50');
  try {
    const res = await fetch('/messages?' + params.toString());
    const json = await res.json();
    if (json && Array.isArray(json.messages)) {
      // insert older messages at top
      json.messages.forEach(m => insertMessageAtTop(m));
      if (json.messages.length) oldestTs = json.messages[0].ts;
    }
  } catch (e) {
    console.error('loadMore failed', e);
  }
});

// Search local messages (simple highlight)
searchBtn.addEventListener('click', () => {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return;
  const items = messagesEl.querySelectorAll('.message');
  items.forEach(it => {
    const text = it.querySelector('.text').textContent.toLowerCase();
    if (text.includes(q)) {
      it.style.background = '#fff6a8';
    } else {
      it.style.background = '';
    }
  });
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
  addMessage(m);
});

socket.on('presence', (data) => {
  // data: { users: [...], event: 'join'|'leave', user }
  if (Array.isArray(data.users)) {
    usersEl.innerHTML = '';
    data.users.forEach(u => {
      const li = document.createElement('li');
      li.textContent = u;
      if (u === myName) li.style.fontWeight = '700';
      usersEl.appendChild(li);
    });
  }
  if (data.event === 'join') notify(`${data.user} 已加入`);
  if (data.event === 'leave') notify(`${data.user} 已离开`);
});
