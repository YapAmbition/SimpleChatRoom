// Admin Panel Client Logic
const BASE_PATH = window.location.pathname.replace(/\/admin\.html$/, '').replace(/\/+$/, '');
let adminToken = sessionStorage.getItem('adminToken') || '';

// ===== Helpers =====

function showEl(el) { (typeof el === 'string' ? document.getElementById(el) : el).style.display = ''; }
function hideEl(el) { (typeof el === 'string' ? document.getElementById(el) : el).style.display = 'none'; }

function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

async function adminFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(BASE_PATH + path, { ...options, headers });
  if (res.status === 401) {
    adminToken = '';
    sessionStorage.removeItem('adminToken');
    showEl('loginOverlay');
    hideEl('dashboard');
    toast('登录已过期，请重新登录');
    throw new Error('unauthorized');
  }
  return res.json();
}

// ===== Confirm dialog =====

let confirmResolve = null;
function confirm(title, msg) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    showEl('confirmModal');
  });
}
document.getElementById('confirmCancel').onclick = () => {
  hideEl('confirmModal');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
};
document.getElementById('confirmOk').onclick = () => {
  hideEl('confirmModal');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
};

// ===== Login =====

const loginOverlay = document.getElementById('loginOverlay');
const dashboard = document.getElementById('dashboard');
const adminPwInput = document.getElementById('adminPwInput');
const adminLoginBtn = document.getElementById('adminLoginBtn');

async function doLogin() {
  const pw = adminPwInput.value.trim();
  if (!pw) return toast('请输入密码');
  try {
    const data = await fetch(BASE_PATH + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(r => r.json());
    if (data.ok) {
      adminToken = data.token;
      sessionStorage.setItem('adminToken', adminToken);
      hideEl(loginOverlay);
      showEl(dashboard);
      adminPwInput.value = '';
      loadRooms();
    } else {
      toast(data.error || '登录失败');
    }
  } catch (e) {
    toast('登录失败: ' + e.message);
  }
}

adminLoginBtn.onclick = doLogin;
adminPwInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// Auto-login if token exists
if (adminToken) {
  hideEl(loginOverlay);
  showEl(dashboard);
  loadRooms();
}

// ===== Logout =====

document.getElementById('logoutBtn').onclick = async () => {
  try { await adminFetch('/admin/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  adminToken = '';
  sessionStorage.removeItem('adminToken');
  showEl(loginOverlay);
  hideEl(dashboard);
};

// ===== Load rooms =====

async function loadRooms() {
  try {
    const data = await adminFetch('/admin/rooms');
    if (!data.ok) return toast(data.error || '加载失败');
    renderRooms(data.rooms);
  } catch (e) {
    if (e.message !== 'unauthorized') toast('加载房间列表失败');
  }
}

function renderRooms(rooms) {
  const tbody = document.getElementById('roomsBody');
  if (!rooms.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">暂无房间</td></tr>';
    return;
  }
  tbody.innerHTML = rooms.map(r => {
    const isMain = r.name === '聊天大厅' || r.id === '聊天大厅';
    const onlineBadge = r.online > 0
      ? `<span class="badge-online has">${r.online} 在线</span>`
      : `<span class="badge-online none">0</span>`;
    const pwCell = r.hasPassword
      ? `<span class="pw-text">${esc(r.password || '***')}</span>`
      : `<span class="pw-none">无密码</span>`;
    const created = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-';
    let actions = `<button class="btn-sm" onclick="clearRoom('${esc(r.id)}','${esc(r.name)}')">清空记录</button>`;
    if (r.hasPassword) {
      actions += ` <button class="btn-sm" onclick="changeRoomPw('${esc(r.id)}','${esc(r.name)}')">改密码</button>`;
      actions += ` <button class="btn-sm" onclick="removeRoomPw('${esc(r.id)}','${esc(r.name)}')">去密码</button>`;
    } else {
      actions += ` <button class="btn-sm" onclick="changeRoomPw('${esc(r.id)}','${esc(r.name)}')">设密码</button>`;
    }
    if (!isMain) {
      actions += ` <button class="btn-sm btn-danger" onclick="deleteRoom('${esc(r.id)}','${esc(r.name)}')">删除</button>`;
    }
    return `<tr>
      <td><strong>${esc(r.name)}</strong>${isMain ? ' <span style="color:#bbb;font-size:11px;">(主房间)</span>' : ''}</td>
      <td>${onlineBadge}</td>
      <td><div class="pw-cell">${pwCell}</div></td>
      <td style="font-size:12px;color:#999;">${created}</td>
      <td><div class="actions">${actions}</div></td>
    </tr>`;
  }).join('');
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ===== Create room =====

document.getElementById('createRoomBtn').onclick = async () => {
  const name = document.getElementById('newRoomName').value.trim();
  const password = document.getElementById('newRoomPw').value.trim();
  if (!name) return toast('请输入房间名');
  try {
    const data = await adminFetch('/admin/rooms', {
      method: 'POST',
      body: { name, password }
    });
    if (data.ok) {
      toast('房间创建成功');
      document.getElementById('newRoomName').value = '';
      document.getElementById('newRoomPw').value = '';
      loadRooms();
    } else {
      toast(data.error || '创建失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('创建失败');
  }
};

// ===== Delete room =====

async function deleteRoom(id, name) {
  const yes = await confirm('删除房间', `确定要删除房间 "${name}" 吗？房间内的用户将被踢回主房间，数据将备份保留。`);
  if (!yes) return;
  try {
    const data = await adminFetch('/admin/rooms/' + encodeURIComponent(id), { method: 'DELETE' });
    if (data.ok) {
      toast(`房间 "${name}" 已删除，备份: ${data.backup}`);
      loadRooms();
    } else {
      toast(data.error || '删除失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('删除失败');
  }
}

// ===== Clear room history =====

async function clearRoom(id, name) {
  const yes = await confirm('清空聊天记录', `确定要清空房间 "${name}" 的所有聊天记录吗？此操作不可恢复。`);
  if (!yes) return;
  try {
    const data = await adminFetch('/admin/rooms/' + encodeURIComponent(id) + '/clear', { method: 'POST' });
    if (data.ok) {
      toast(`房间 "${name}" 聊天记录已清空`);
    } else {
      toast(data.error || '清空失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('清空失败');
  }
}

// ===== Room password management =====

let pendingPwRoomId = null;
const roomPwModal = document.getElementById('roomPwModal');
const roomPwInput = document.getElementById('roomPwInput');

function changeRoomPw(id, name) {
  pendingPwRoomId = id;
  document.getElementById('roomPwTitle').textContent = `修改房间 "${name}" 的密码`;
  roomPwInput.value = '';
  showEl(roomPwModal);
  roomPwInput.focus();
}

document.getElementById('roomPwCancel').onclick = () => {
  hideEl(roomPwModal);
  pendingPwRoomId = null;
};

document.getElementById('roomPwConfirm').onclick = async () => {
  const pw = roomPwInput.value.trim();
  if (!pw) return toast('密码不能为空');
  if (!pendingPwRoomId) return;
  try {
    const data = await adminFetch('/admin/rooms/' + encodeURIComponent(pendingPwRoomId) + '/password', {
      method: 'PUT',
      body: { password: pw }
    });
    if (data.ok) {
      toast('房间密码已更新');
      hideEl(roomPwModal);
      pendingPwRoomId = null;
      loadRooms();
    } else {
      toast(data.error || '修改失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('修改失败');
  }
};

async function removeRoomPw(id, name) {
  const yes = await confirm('清除密码', `确定要清除房间 "${name}" 的密码吗？清除后任何人都可以直接进入。`);
  if (!yes) return;
  try {
    const data = await adminFetch('/admin/rooms/' + encodeURIComponent(id) + '/password', { method: 'DELETE' });
    if (data.ok) {
      toast('房间密码已清除');
      loadRooms();
    } else {
      toast(data.error || '操作失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('操作失败');
  }
}

// ===== Change admin password =====

const adminPwModal = document.getElementById('adminPwModal');

document.getElementById('changePwBtn').onclick = () => {
  document.getElementById('curAdminPw').value = '';
  document.getElementById('newAdminPw').value = '';
  document.getElementById('newAdminPw2').value = '';
  showEl(adminPwModal);
  document.getElementById('curAdminPw').focus();
};

document.getElementById('adminPwCancel').onclick = () => {
  hideEl(adminPwModal);
};

document.getElementById('adminPwConfirm').onclick = async () => {
  const cur = document.getElementById('curAdminPw').value;
  const np = document.getElementById('newAdminPw').value.trim();
  const np2 = document.getElementById('newAdminPw2').value.trim();
  if (!cur) return toast('请输入当前密码');
  if (!np) return toast('请输入新密码');
  if (np !== np2) return toast('两次输入的新密码不一致');
  try {
    const data = await adminFetch('/admin/config/password', {
      method: 'PUT',
      body: { currentPassword: cur, newPassword: np }
    });
    if (data.ok) {
      toast('管理员密码已修改，请重新登录');
      hideEl(adminPwModal);
      adminToken = '';
      sessionStorage.removeItem('adminToken');
      showEl(loginOverlay);
      hideEl(dashboard);
    } else {
      toast(data.error || '修改失败');
    }
  } catch (e) {
    if (e.message !== 'unauthorized') toast('修改失败');
  }
};
