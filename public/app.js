const $ = (s) => document.querySelector(s);
let token = localStorage.getItem('token'), me = null, socket;
let chats = [], messages = {}, activeId = null, online = new Set(), typing = {};
let authMode = 'login', groupMode = false, picked = new Set(), typingTimer;

/* ---------- helpers ---------- */
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && token) logout(); throw new Error(d.error || 'Request failed'); }
  return d;
}
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body) });
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 360;
function avatar(el, name, isOn) {
  el.textContent = name[0].toUpperCase();
  el.style.background = `hsl(${hue(name)} 45% 40%)`;
  el.classList.toggle('on', !!isOn);
}
const chatById = (id) => chats.find((c) => c.id === id);
const peer = (c) => (c.type === 'direct' ? c.members.find((m) => m.id !== me.id) : null);

/* ---------- auth ---------- */
function setAuthMode(m) {
  authMode = m;
  const reg = m === 'register';
  $('#authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('#authToggle').textContent = reg ? 'Have an account? Sign in' : 'New here? Create an account';
  $('#authHint').textContent = reg ? 'Pick a username and password to start chatting.' : 'Sign in to pick up your conversations.';
  $('#authError').textContent = '';
}
$('#authToggle').onclick = () => setAuthMode(authMode === 'login' ? 'register' : 'login');
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const d = await post('/' + authMode, { username: f.get('username'), password: f.get('password') });
    token = d.token; me = d.user; localStorage.setItem('token', token); start();
  } catch (err) { $('#authError').textContent = err.message; }
};
function logout() {
  localStorage.removeItem('token'); token = null; me = null;
  if (socket) socket.disconnect();
  location.reload();
}
$('#logoutBtn').onclick = logout;

/* ---------- start ---------- */
async function init() {
  if (!token) return;
  try { me = (await api('/me')).user; start(); } catch { /* stays on sign-in */ }
}
async function start() {
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#meName').textContent = me.username; avatar($('#meAvatar'), me.username);
  socket = io({ auth: { token } });
  socket.on('connect_error', (e) => e.message === 'unauthorized' && logout());
  socket.on('message:new', onMessage);
  socket.on('chat:new', (c) => { upsert(c); renderList(); });
  socket.on('read', ({ chatId, userId, messageId }) => {
    const m = chatById(chatId)?.members.find((x) => x.id === userId);
    if (m) m.lastReadId = Math.max(m.lastReadId, messageId);
    if (chatId === activeId) renderMessages();
  });
  socket.on('typing', ({ chatId, userId, username, isTyping }) => {
    typing[chatId] = typing[chatId] || {};
    if (isTyping) typing[chatId][userId] = username; else delete typing[chatId][userId];
    renderList(); if (chatId === activeId) renderHeader();
  });
  socket.on('presence', ({ userId, online: on, lastSeen }) => {
    on ? online.add(userId) : online.delete(userId);
    chats.forEach((c) => c.members.forEach((m) => { if (m.id === userId && lastSeen) m.lastSeen = lastSeen; }));
    renderList(); if (activeId) renderHeader();
  });
  const d = await api('/chats'); chats = d.chats; online = new Set(d.onlineIds); renderList();
}
function upsert(c) {
  const i = chats.findIndex((x) => x.id === c.id);
  if (i >= 0) chats[i] = c; else chats.unshift(c);
}

/* ---------- chat list ---------- */
const typingText = (id) => Object.values(typing[id] || {})[0];
function preview(c) {
  const t = typingText(c.id);
  if (t) return [c.type === 'group' ? `${t} is typing…` : 'typing…', true];
  const m = c.lastMessage; if (!m) return ['No messages yet', false];
  const who = m.senderId === me.id ? 'You: ' : c.type === 'group' ? m.sender + ': ' : '';
  return [who + (m.body || 'Attachment'), false];
}
function renderList() {
  chats.sort((a, b) => (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
  const ul = $('#chatList'); ul.innerHTML = '';
  if (!chats.length) ul.innerHTML = '<li style="cursor:default;color:var(--muted)">No chats yet. Press + to find someone.</li>';
  for (const c of chats) {
    const li = document.createElement('li');
    if (c.id === activeId) li.className = 'active';
    const av = document.createElement('div'); av.className = 'avatar';
    avatar(av, c.name, peer(c) && online.has(peer(c).id));
    const [text, isTyping] = preview(c);
    const mid = document.createElement('div'); mid.className = 'mid';
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('strong'); name.textContent = c.name;
    const tm = document.createElement('time'); tm.textContent = c.lastMessage ? time(c.lastMessage.createdAt) : '';
    row.append(name, tm);
    const row2 = document.createElement('div'); row2.className = 'row';
    const pv = document.createElement('div'); pv.className = 'prev' + (isTyping ? ' typing' : ''); pv.textContent = text;
    row2.append(pv);
    if (c.unread) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = c.unread; row2.append(b); }
    mid.append(row, row2); li.append(av, mid);
    li.onclick = () => openChat(c.id);
    ul.append(li);
  }
}

/* ---------- active chat ---------- */
async function openChat(id) {
  activeId = id;
  $('#app').classList.add('chat-open'); $('#empty').classList.add('hidden'); $('#chat').classList.remove('hidden');
  if (!messages[id]) messages[id] = (await api(`/chats/${id}/messages`)).messages;
  renderHeader(); renderMessages(); markRead(); renderList(); $('#text').focus();
}
function markRead() {
  const c = chatById(activeId); if (!c) return;
  c.unread = 0; socket.emit('chat:read', { chatId: activeId }); renderList();
}
function renderHeader() {
  const c = chatById(activeId); if (!c) return;
  const p = peer(c);
  avatar($('#chatAvatar'), c.name, p && online.has(p.id));
  $('#chatName').textContent = c.name;
  const t = typingText(c.id);
  $('#chatStatus').textContent = t ? (c.type === 'group' ? `${t} is typing…` : 'typing…')
    : p ? (online.has(p.id) ? 'online' : p.lastSeen ? 'last seen ' + new Date(p.lastSeen).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : 'offline')
    : c.members.map((m) => m.username).join(', ');
}
function renderMessages() {
  const c = chatById(activeId), box = $('#msgs');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || !box.children.length;
  box.innerHTML = '';
  for (const m of messages[activeId] || []) {
    const mine = m.senderId === me.id;
    const el = document.createElement('div'); el.className = 'msg' + (mine ? ' mine' : '');
    if (!mine && c.type === 'group') { const w = document.createElement('span'); w.className = 'who'; w.textContent = m.sender; el.append(w); }
    if (m.fileUrl) {
      const a = document.createElement('a'); a.href = m.fileUrl; a.target = '_blank'; a.rel = 'noopener';
      if (/\.(jpe?g|png|gif|webp)$/i.test(m.fileUrl)) { const i = document.createElement('img'); i.src = m.fileUrl; i.alt = m.fileName || 'Image'; a.append(i); }
      else a.textContent = m.fileName || 'Download file';
      el.append(a);
    }
    if (m.body) { const p = document.createElement('p'); p.textContent = m.body; el.append(p); }
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = time(m.createdAt) + ' ';
    if (mine) {
      const seen = c.members.filter((x) => x.id !== me.id).every((x) => x.lastReadId >= m.id);
      const t = document.createElement('span'); t.className = 'tick' + (seen ? ' read' : '');
      t.textContent = seen ? '✓✓' : '✓'; t.title = seen ? 'Read' : 'Sent'; meta.append(t);
    }
    el.append(meta); box.append(el);
  }
  if (stick) box.scrollTop = box.scrollHeight;
}
function onMessage(m) {
  const c = chatById(m.chatId); if (!c) return;
  c.lastMessage = m;
  if (typing[m.chatId]) delete typing[m.chatId][m.senderId];
  if (messages[m.chatId]) messages[m.chatId].push(m);
  if (m.senderId !== me.id) {
    if (m.chatId === activeId && !document.hidden) { renderMessages(); markRead(); }
    else c.unread++;
  } else if (m.chatId === activeId) renderMessages();
  renderList(); if (m.chatId === activeId) renderHeader();
}

/* ---------- composer ---------- */
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const body = $('#text').value.trim(); if (!body) return;
  socket.emit('message:send', { chatId: activeId, body }, (r) => r?.error && alert(r.error));
  $('#text').value = ''; stopTyping();
};
function stopTyping() { clearTimeout(typingTimer); typingTimer = null; socket.emit('typing', { chatId: activeId, isTyping: false }); }
$('#text').oninput = () => {
  if (!typingTimer) socket.emit('typing', { chatId: activeId, isTyping: true });
  clearTimeout(typingTimer); typingTimer = setTimeout(stopTyping, 1500);
};
$('#attachBtn').onclick = () => $('#file').click();
$('#file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  try {
    const u = await api('/upload', { method: 'POST', body: fd });
    socket.emit('message:send', { chatId: activeId, fileUrl: u.url, fileName: u.name, body: $('#text').value.trim() });
    $('#text').value = '';
  } catch (err) { alert(err.message); }
};
$('#backBtn').onclick = () => { activeId = null; $('#app').classList.remove('chat-open'); $('#chat').classList.add('hidden'); $('#empty').classList.remove('hidden'); renderList(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && activeId) markRead(); });

/* ---------- new chat / group modal ---------- */
function setGroupMode(g) {
  groupMode = g; picked.clear();
  $('#tabDirect').classList.toggle('on', !g); $('#tabGroup').classList.toggle('on', g);
  $('#groupName').classList.toggle('hidden', !g); $('#createGroup').classList.toggle('hidden', !g);
  $('#modalError').textContent = ''; loadUsers();
}
async function loadUsers() {
  const { users } = await api('/users?q=' + encodeURIComponent($('#search').value));
  const ul = $('#userList'); ul.innerHTML = '';
  if (!users.length) ul.innerHTML = '<li style="cursor:default;color:var(--muted)">No one found.</li>';
  for (const u of users) {
    const li = document.createElement('li');
    const av = document.createElement('div'); av.className = 'avatar'; avatar(av, u.username, online.has(u.id));
    const n = document.createElement('span'); n.textContent = u.username; li.append(av, n);
    if (groupMode) {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = picked.has(u.id);
      cb.onchange = () => (cb.checked ? picked.add(u.id) : picked.delete(u.id));
      li.append(cb); li.onclick = (e) => { if (e.target !== cb) { cb.checked = !cb.checked; cb.onchange(); } };
    } else li.onclick = () => startDirect(u.id);
    ul.append(li);
  }
}
async function startDirect(userId) {
  try { const { chat } = await post('/chats/direct', { userId }); upsert(chat); closeModal(); openChat(chat.id); }
  catch (e) { $('#modalError').textContent = e.message; }
}
$('#createGroup').onclick = async () => {
  try {
    const { chat } = await post('/chats/group', { name: $('#groupName').value, memberIds: [...picked] });
    upsert(chat); closeModal(); openChat(chat.id);
  } catch (e) { $('#modalError').textContent = e.message; }
};
const closeModal = () => $('#modal').classList.add('hidden');
$('#newBtn').onclick = () => { $('#modal').classList.remove('hidden'); $('#search').value = ''; setGroupMode(false); $('#search').focus(); };
$('#closeModal').onclick = closeModal;
$('#tabDirect').onclick = () => setGroupMode(false);
$('#tabGroup').onclick = () => setGroupMode(true);
let searchT; $('#search').oninput = () => { clearTimeout(searchT); searchT = setTimeout(loadUsers, 200); };

init();
