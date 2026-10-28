// Chat App — real-time messaging server (WhatsApp-style texting)
// Stack: Node.js + Express + ws (WebSocket) + node:sqlite (single DB file).
// Passwords are hashed with scrypt and never leave the server.
// Run: npm install && npm start   (PORT env var optional, default 3000)

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chat.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar TEXT,
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('direct','group')),
  name TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('text','image','audio')),
  body TEXT,
  file_path TEXT,
  reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS message_status (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);
`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function now() { return Date.now(); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

// Public user shape — NEVER includes password_hash.
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, display_name: row.display_name, avatar: row.avatar || null, last_seen: row.last_seen };
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getSessionUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) || null;
}
function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}
function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}
function chatMembers(chatId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map(r => r.user_id);
}
function chatTitle(chat, meId) {
  if (chat.type === 'group') return chat.name || 'Group';
  const other = db.prepare(
    'SELECT u.* FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? AND cm.user_id != ? LIMIT 1'
  ).get(chat.id, meId);
  return other ? other.display_name : 'Chat';
}

// Serialize a message for the client, including reply preview + receipt state.
function serializeMessage(row, meId) {
  const sender = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(row.sender_id);
  let reply = null;
  if (row.reply_to) {
    const r = db.prepare('SELECT m.*, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(row.reply_to);
    if (r) reply = { id: r.id, sender_name: r.display_name, type: r.type, body: r.deleted ? null : r.body, deleted: !!r.deleted };
  }
  // Receipts: only meaningful for the sender's own messages.
  let ticks = null;
  if (row.sender_id === meId) {
    const others = chatMembers(row.chat_id).filter(id => id !== meId);
    if (others.length > 0) {
      // message_status rows are created for every other member at send time.
      const rows = db.prepare('SELECT user_id, delivered, read FROM message_status WHERE message_id = ?').all(row.id);
      const allDelivered = others.every(id => rows.find(r => r.user_id === id)?.delivered);
      const allRead = others.every(id => rows.find(r => r.user_id === id)?.read);
      ticks = allRead ? 'read' : allDelivered ? 'delivered' : 'sent';
    }
  }
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender: sender ? { id: sender.id, username: sender.username, display_name: sender.display_name, avatar: sender.avatar || null } : null,
    type: row.type,
    body: row.deleted ? null : row.body,
    file_url: row.deleted || !row.file_path ? null : `/uploads/${path.basename(row.file_path)}`,
    reply_to: reply,
    edited: !!row.edited_at,
    deleted: !!row.deleted,
    created_at: row.created_at,
    ticks,
  };
}

// ---------------------------------------------------------------------------
// App + uploads
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|gif|webp)|audio\/(webm|ogg|mpeg|mp4|wav|x-wav))$/.test(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

// Uploaded files: only logged-in users may fetch them.
app.use('/uploads', requireAuth, express.static(UPLOAD_DIR, { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9._]{3,20}$/;

app.post('/api/signup', (req, res) => {
  const { username, display_name, password } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers, dots or underscores.' });
  if (!display_name || display_name.trim().length < 1 || display_name.length > 40) return res.status(400).json({ error: 'Display name is required.' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  try {
    const result = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, display_name.trim(), hashPassword(password), now());
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, Number(result.lastInsertRowid), now());
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid))) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username is already taken.' });
    throw e;
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username || '');
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, now());
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(parseCookies(req).session);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/me', requireAuth, (req, res) => {
  const { display_name } = req.body || {};
  if (!display_name || display_name.trim().length < 1 || display_name.length > 40) {
    return res.status(400).json({ error: 'Display name is required.' });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name.trim(), req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(`/uploads/${req.file.filename}`, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ---------------------------------------------------------------------------
// Users + contacts API
// ---------------------------------------------------------------------------
app.get('/api/users', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = db.prepare(
    `SELECT id, username, display_name, avatar, last_seen FROM users
     WHERE id != ? AND (username LIKE ? OR display_name LIKE ?) LIMIT 20`
  ).all(req.user.id, `%${q}%`, `%${q}%`);
  res.json({ users: rows.map(publicUser) });
});

app.get('/api/contacts', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.last_seen FROM contacts c
     JOIN users u ON u.id = c.contact_id WHERE c.user_id = ? ORDER BY u.display_name`
  ).all(req.user.id);
  res.json({ contacts: rows.map(publicUser) });
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const contactId = Number(req.body.contact_id);
  if (!contactId || contactId === req.user.id) return res.status(400).json({ error: 'Invalid contact.' });
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(contactId);
  if (!exists) return res.status(404).json({ error: 'User not found.' });
  db.prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?)').run(req.user.id, contactId, now());
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chats API
// ---------------------------------------------------------------------------
function chatSummary(chat, meId) {
  const members = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar, u.last_seen FROM chat_members cm
     JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`
  ).all(chat.id);
  const last = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chat.id);
  const unread = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m LEFT JOIN message_status s
     ON s.message_id = m.id AND s.user_id = ?
     WHERE m.chat_id = ? AND m.sender_id != ? AND (s.read IS NULL OR s.read = 0) AND m.deleted = 0`
  ).get(meId, chat.id, meId).n;
  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === 'group' ? (chat.name || 'Group') : (members.find(m => m.id !== meId)?.display_name || 'Chat'),
    members: members.map(publicUser),
    last_message: last ? serializeMessage(last, meId) : null,
    unread,
  };
}

app.get('/api/chats', requireAuth, (req, res) => {
  const chats = db.prepare(
    `SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
     WHERE cm.user_id = ? ORDER BY c.id DESC`
  ).all(req.user.id);
  const summaries = chats.map(c => chatSummary(c, req.user.id));
  summaries.sort((a, b) => (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0));
  res.json({ chats: summaries });
});

app.post('/api/chats', requireAuth, (req, res) => {
  const { type, name, member_ids } = req.body || {};
  const memberIds = [...new Set((member_ids || []).map(Number).filter(n => n && n !== req.user.id))];
  if (type === 'direct') {
    if (memberIds.length !== 1) return res.status(400).json({ error: 'Direct chat needs exactly one other person.' });
    const otherId = memberIds[0];
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(otherId)) return res.status(404).json({ error: 'User not found.' });
    // Reuse an existing direct chat between the two users.
    const existing = db.prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
       JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
       WHERE c.type = 'direct'`
    ).get(req.user.id, otherId);
    if (existing) return res.json({ chat: chatSummary(db.prepare('SELECT * FROM chats WHERE id = ?').get(existing.id), req.user.id) });
    const r = db.prepare('INSERT INTO chats (type, created_by, created_at) VALUES (?, ?, ?)').run('direct', req.user.id, now());
    const chatId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(chatId, req.user.id, now());
    db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(chatId, otherId, now());
    return res.json({ chat: chatSummary(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId), req.user.id) });
  }
  if (type === 'group') {
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group needs a name.' });
    if (memberIds.length < 1) return res.status(400).json({ error: 'Add at least one person to the group.' });
    for (const id of memberIds) {
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'A selected user was not found.' });
    }
    const r = db.prepare('INSERT INTO chats (type, name, created_by, created_at) VALUES (?, ?, ?, ?)').run('group', name.trim().slice(0, 40), req.user.id, now());
    const chatId = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(chatId, req.user.id, now());
    for (const id of memberIds) db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(chatId, id, now());
    const chat = chatSummary(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId), req.user.id);
    broadcastToChat(chatId, { type: 'chat-created', chat }, req.user.id);
    return res.json({ chat });
  }
  return res.status(400).json({ error: 'Invalid chat type.' });
});

app.post('/api/chats/:id/members', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || chat.type !== 'group') return res.status(400).json({ error: 'Only group chats have members to add.' });
  const addId = Number(req.body.user_id);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(addId)) return res.status(404).json({ error: 'User not found.' });
  db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(chatId, addId, now());
  res.json({ ok: true });
});

app.delete('/api/chats/:id/members/:userId', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat || !isMember(chatId, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  if (targetId !== req.user.id && chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only the group creator can remove other people.' });
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Messages API
// ---------------------------------------------------------------------------
app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = Number(req.query.before) || 0;
  const search = String(req.query.search || '').trim();
  let rows;
  if (search) {
    rows = db.prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 AND body LIKE ? ORDER BY id DESC LIMIT ?`
    ).all(chatId, `%${search}%`, limit);
  } else if (before) {
    rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, before, limit);
  } else {
    rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
  }
  rows.reverse();
  res.json({ messages: rows.map(r => serializeMessage(r, req.user.id)) });
});

app.post('/api/chats/:id/messages', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    next();
  });
}, (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const replyTo = req.body.reply_to ? Number(req.body.reply_to) : null;
  let type = 'text';
  let filePath = null;
  if (req.file) {
    const isImage = req.file.mimetype.startsWith('image/');
    const isAudio = req.file.mimetype.startsWith('audio/');
    if (!isImage && !isAudio) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Only images and voice notes can be uploaded.' }); }
    type = isImage ? 'image' : 'audio';
    filePath = req.file.path;
  }
  if (type === 'text' && !body) return res.status(400).json({ error: 'Message is empty.' });
  if (replyTo) {
    const target = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(replyTo, chatId);
    if (!target) return res.status(400).json({ error: 'Reply target not found in this chat.' });
  }
  const r = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, type, body, file_path, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(chatId, req.user.id, type, type === 'text' ? body : (body || null), filePath, replyTo, now());
  const messageId = Number(r.lastInsertRowid);
  // Create receipt rows for every other member; mark delivered for those online now.
  for (const memberId of chatMembers(chatId)) {
    if (memberId === req.user.id) continue;
    const delivered = onlineUsers.has(memberId) ? 1 : 0;
    db.prepare('INSERT INTO message_status (message_id, user_id, delivered, read) VALUES (?, ?, ?, 0)').run(messageId, memberId, delivered);
  }
  const msg = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId), req.user.id);
  broadcastToChat(chatId, { type: 'message', message: msg });
  res.json({ message: msg });
});

app.put('/api/messages/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });
  if (msg.deleted) return res.status(400).json({ error: 'Message was deleted.' });
  if (msg.type !== 'text') return res.status(400).json({ error: 'Only text messages can be edited.' });
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Message is empty.' });
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), id);
  const updated = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id), req.user.id);
  broadcastToChat(msg.chat_id, { type: 'message-edited', message: updated });
  res.json({ message: updated });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own messages.' });
  if (msg.file_path) { try { fs.unlinkSync(msg.file_path); } catch { /* already gone */ } }
  db.prepare('UPDATE messages SET deleted = 1, body = NULL, file_path = NULL WHERE id = ?').run(id);
  broadcastToChat(msg.chat_id, { type: 'message-deleted', message_id: id, chat_id: msg.chat_id });
  res.json({ ok: true });
});

app.post('/api/chats/:id/read', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return res.status(403).json({ error: 'Not a member of this chat.' });
  db.prepare(
    `UPDATE message_status SET delivered = 1, read = 1 WHERE user_id = ? AND message_id IN
     (SELECT id FROM messages WHERE chat_id = ? AND sender_id != ?)`
  ).run(req.user.id, chatId, req.user.id);
  broadcastToChat(chatId, { type: 'read', chat_id: chatId, user_id: req.user.id }, req.user.id);
  res.json({ ok: true });
});

// Fallback route for the SPA (Express 5 needs a named wildcard).
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------------------------------------------------------------------
// WebSocket: presence, typing, live message fan-out
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// userId -> Set of sockets
const onlineUsers = new Map();

function broadcastToChat(chatId, payload, exceptUserId = null) {
  const data = JSON.stringify(payload);
  for (const memberId of chatMembers(chatId)) {
    if (memberId === exceptUserId) continue;
    const sockets = onlineUsers.get(memberId);
    if (sockets) for (const ws of sockets) { if (ws.readyState === 1) ws.send(data); }
  }
}
function broadcastPresence() {
  const online = [...onlineUsers.keys()];
  const data = JSON.stringify({ type: 'presence', online });
  for (const sockets of onlineUsers.values()) {
    for (const ws of sockets) { if (ws.readyState === 1) ws.send(data); }
  }
}
function setDeliveredFor(userId) {
  // Anything waiting for this user is now delivered to at least one device.
  db.prepare(
    `UPDATE message_status SET delivered = 1 WHERE user_id = ? AND delivered = 0 AND message_id IN
     (SELECT id FROM messages WHERE sender_id != ?)`
  ).run(userId, userId);
}

wss.on('connection', (ws, req) => {
  const user = getSessionUser(req);
  if (!user) { ws.close(4401, 'Not logged in'); return; }
  const userId = user.id;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(ws);
  setDeliveredFor(userId);
  broadcastPresence();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type === 'typing' && data.chat_id) {
      const chatId = Number(data.chat_id);
      if (!isMember(chatId, userId)) return;
      broadcastToChat(chatId, { type: 'typing', chat_id: chatId, user_id: userId, name: user.display_name, is_typing: !!data.is_typing }, userId);
    }
    if (data.type === 'read' && data.chat_id) {
      const chatId = Number(data.chat_id);
      if (!isMember(chatId, userId)) return;
      db.prepare(
        `UPDATE message_status SET delivered = 1, read = 1 WHERE user_id = ? AND message_id IN
         (SELECT id FROM messages WHERE chat_id = ? AND sender_id != ?)`
      ).run(userId, chatId, userId);
      broadcastToChat(chatId, { type: 'read', chat_id: chatId, user_id: userId }, userId);
    }
  });

  ws.on('close', () => {
    const set = onlineUsers.get(userId);
    if (set) { set.delete(ws); if (set.size === 0) onlineUsers.delete(userId); }
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
    broadcastPresence();
  });
});

// Drop dead sockets so presence stays accurate.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Chat app listening on http://localhost:${PORT}`);
});
