const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/* ---------- Database ---------- */
const db = new Database(path.join(__dirname, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password TEXT NOT NULL, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('direct','group')),
  name TEXT, created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id), body TEXT,
  file_url TEXT, file_name TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, id);
`);

const isMember = (chatId, userId) =>
  !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?').get(chatId, userId);

const toMsg = (r) => ({
  id: r.id, chatId: r.chat_id, senderId: r.sender_id, sender: r.username,
  body: r.body, fileUrl: r.file_url, fileName: r.file_name, createdAt: r.created_at,
});

function chatView(chatId, userId) {
  const c = db.prepare('SELECT * FROM chats WHERE id=?').get(chatId);
  const members = db.prepare(
    `SELECT u.id, u.username, u.last_seen AS lastSeen, m.last_read_id AS lastReadId
     FROM chat_members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=?`).all(chatId);
  const mine = members.find((m) => m.id === userId);
  const last = db.prepare(
    `SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE chat_id=? ORDER BY m.id DESC LIMIT 1`).get(chatId);
  const unread = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE chat_id=? AND id>? AND sender_id!=?')
    .get(chatId, mine.lastReadId, userId).n;
  const other = c.type === 'direct' ? members.find((m) => m.id !== userId) : null;
  return {
    id: c.id, type: c.type, name: other ? other.username : c.name,
    members, lastMessage: last ? toMsg(last) : null, unread, createdAt: c.created_at,
  };
}

/* ---------- App + sockets ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(t, SECRET);
    next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}

/* ---------- Auth routes ---------- */
app.post('/api/register', (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
    return res.status(409).json({ error: 'That username is taken.' });
  const info = db.prepare('INSERT INTO users (username,password,last_seen) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), Date.now());
  const user = { id: info.lastInsertRowid, username };
  res.json({ token: sign(user), user });
});

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!row || !bcrypt.compareSync(password, row.password))
    return res.status(401).json({ error: 'Wrong username or password.' });
  const user = { id: row.id, username: row.username };
  res.json({ token: sign(user), user });
});

app.get('/api/me', auth, (req, res) => res.json({ user: { id: req.user.id, username: req.user.username } }));

/* ---------- Users & chats ---------- */
const online = new Map(); // userId -> socket count

app.get('/api/users', auth, (req, res) => {
  const q = `%${(req.query.q || '').replace(/[%_]/g, '')}%`;
  const users = db.prepare('SELECT id, username FROM users WHERE id!=? AND username LIKE ? ORDER BY username LIMIT 30')
    .all(req.user.id, q);
  res.json({ users });
});

app.get('/api/chats', auth, (req, res) => {
  const ids = db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(req.user.id);
  res.json({ chats: ids.map((r) => chatView(r.chat_id, req.user.id)), onlineIds: [...online.keys()] });
});

function announce(chatId, memberIds) {
  for (const uid of memberIds) {
    io.in(`user:${uid}`).socketsJoin(`chat:${chatId}`);
    io.to(`user:${uid}`).emit('chat:new', chatView(chatId, uid));
  }
}

app.post('/api/chats/direct', auth, (req, res) => {
  const other = Number(req.body.userId), me = req.user.id;
  if (!other || other === me || !db.prepare('SELECT 1 FROM users WHERE id=?').get(other))
    return res.status(400).json({ error: 'Pick another user.' });
  const existing = db.prepare(
    `SELECT c.id FROM chats c WHERE c.type='direct'
     AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=c.id AND user_id=?)
     AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id=c.id AND user_id=?)`).get(me, other);
  if (existing) return res.json({ chat: chatView(existing.id, me) });
  const id = db.transaction(() => {
    const cid = db.prepare("INSERT INTO chats (type,created_by,created_at) VALUES ('direct',?,?)").run(me, Date.now()).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_members (chat_id,user_id) VALUES (?,?)');
    add.run(cid, me); add.run(cid, other);
    return cid;
  })();
  announce(id, [me, other]);
  res.json({ chat: chatView(id, me) });
});

app.post('/api/chats/group', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const ids = [...new Set([req.user.id, ...(req.body.memberIds || []).map(Number)])]
    .filter((id) => db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
  if (!name) return res.status(400).json({ error: 'Give the group a name.' });
  if (ids.length < 3) return res.status(400).json({ error: 'Pick at least two other people.' });
  const id = db.transaction(() => {
    const cid = db.prepare("INSERT INTO chats (type,name,created_by,created_at) VALUES ('group',?,?,?)").run(name, req.user.id, Date.now()).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_members (chat_id,user_id) VALUES (?,?)');
    ids.forEach((u) => add.run(cid, u));
    return cid;
  })();
  announce(id, ids);
  res.json({ chat: chatView(id, req.user.id) });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const id = Number(req.params.id);
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(
    `SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id
     WHERE chat_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50`).all(id, before);
  res.json({ messages: rows.reverse().map(toMsg) });
});

/* ---------- Uploads ---------- */
const ALLOWED = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.gif': 1, '.webp': 1, '.pdf': 1 };
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[path.extname(file.originalname).toLowerCase()]),
});
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only images and PDFs up to 10 MB are allowed.' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname.slice(0, 100) });
});
app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Something went wrong.' }));

/* ---------- Real-time ---------- */
io.use((socket, next) => {
  try { socket.user = jwt.verify(socket.handshake.auth.token, SECRET); next(); }
  catch { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
  const { id: uid, username } = socket.user;
  socket.join(`user:${uid}`);
  db.prepare('SELECT chat_id FROM chat_members WHERE user_id=?').all(uid)
    .forEach((r) => socket.join(`chat:${r.chat_id}`));

  online.set(uid, (online.get(uid) || 0) + 1);
  if (online.get(uid) === 1) io.emit('presence', { userId: uid, online: true });

  socket.on('message:send', ({ chatId, body, fileUrl, fileName } = {}, ack = () => {}) => {
    body = String(body || '').trim().slice(0, 4000);
    if (fileUrl && !/^\/uploads\/[a-f0-9]+\.\w+$/.test(fileUrl)) fileUrl = null;
    if (!isMember(chatId, uid)) return ack({ error: 'Not a member of this chat.' });
    if (!body && !fileUrl) return ack({ error: 'Empty message.' });
    const info = db.prepare('INSERT INTO messages (chat_id,sender_id,body,file_url,file_name,created_at) VALUES (?,?,?,?,?,?)')
      .run(chatId, uid, body || null, fileUrl || null, fileName ? String(fileName).slice(0, 100) : null, Date.now());
    db.prepare('UPDATE chat_members SET last_read_id=? WHERE chat_id=? AND user_id=?').run(info.lastInsertRowid, chatId, uid);
    const row = db.prepare('SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(info.lastInsertRowid);
    io.to(`chat:${chatId}`).emit('message:new', toMsg(row));
    ack({ ok: true });
  });

  socket.on('chat:read', ({ chatId } = {}) => {
    if (!isMember(chatId, uid)) return;
    const last = db.prepare('SELECT MAX(id) id FROM messages WHERE chat_id=?').get(chatId).id || 0;
    db.prepare('UPDATE chat_members SET last_read_id=MAX(last_read_id,?) WHERE chat_id=? AND user_id=?').run(last, chatId, uid);
    io.to(`chat:${chatId}`).emit('read', { chatId, userId: uid, messageId: last });
  });

  socket.on('typing', ({ chatId, isTyping } = {}) => {
    if (isMember(chatId, uid)) socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, username, isTyping: !!isTyping });
  });

  socket.on('disconnect', () => {
    const n = (online.get(uid) || 1) - 1;
    if (n > 0) return online.set(uid, n);
    online.delete(uid);
    const now = Date.now();
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now, uid);
    io.emit('presence', { userId: uid, online: false, lastSeen: now });
  });
});

server.listen(PORT, () => console.log(`Hubbub running at http://localhost:${PORT}`));
