// Chat frontend — vanilla JS, no build step.
// Talks to the REST API and the /ws WebSocket. If the socket drops, polling
// takes over so messages still arrive (every 4s while a chat is open).

'use strict';

const $ = sel => document.querySelector(sel);
const api = {
  async req(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  get: p => api.req(p),
  post: (p, body) => api.req(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  put: (p, body) => api.req(p, { method: 'PUT', body: JSON.stringify(body || {}) }),
  del: p => api.req(p, { method: 'DELETE' }),
  upload: async (path, formData) => {
    const res = await fetch(path, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts), today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtLastSeen(ts, online) {
  if (online) return 'Online';
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'last seen just now';
  if (diff < 3600000) return `last seen ${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `last seen ${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `last seen ${fmtDay(ts)}`;
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function avatarHtml(user, large) {
  const inner = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user.display_name));
  return `<span class="avatar${large ? ' large' : ''}">${inner}</span>`;
}
function setAvatarBtn(btn, user, large) {
  btn.innerHTML = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user.display_name));
  btn.classList.toggle('large', !!large);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let me = null;
let chats = [];
let contacts = [];
let activeChatId = null;
let activeMessages = [];
let onlineIds = new Set();
let socket = null;
let socketAlive = false;
let pollTimer = null;
let replyTo = null;
let editingId = null;
let typingUsers = new Map(); // chatId -> Map(userId -> {name, timeout})
let chatSearchMode = false;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-displayname').classList.toggle('hidden', mode === 'login');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Sign up';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').classList.add('hidden');
}
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-signup').onclick = () => setAuthMode('signup');
$('#auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#auth-username').value.trim();
  const password = $('#auth-password').value;
  const displayName = $('#auth-displayname').value.trim();
  const err = $('#auth-error');
  err.classList.add('hidden');
  try {
    const path = authMode === 'login' ? '/api/login' : '/api/signup';
    const body = authMode === 'login' ? { username, password } : { username, display_name: displayName, password };
    const { user } = await api.post(path, body);
    me = user;
    enterApp();
  } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
});
$('#btn-logout').onclick = async () => {
  try { await api.post('/api/logout'); } catch { /* ignore */ }
  location.reload();
};

async function boot() {
  try {
    const { user } = await api.get('/api/me');
    me = user;
    enterApp();
  } catch {
    $('#auth-screen').classList.remove('hidden');
    setAuthMode('login');
  }
}

async function enterApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  setAvatarBtn($('#me-avatar'), me);
  $('#me-name').textContent = me.display_name;
  await refreshChats();
  await refreshContacts();
  connectSocket();
  startPollingFallback();
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------
function previewText(m) {
  if (!m) return 'No messages yet';
  if (m.deleted) return '🚫 This message was deleted';
  if (m.type === 'image') return '📷 Photo' + (m.body ? ` · ${m.body}` : '');
  if (m.type === 'audio') return '🎤 Voice message';
  return m.body || '';
}
function renderChatList() {
  const filter = $('#chat-filter').value.trim().toLowerCase();
  const list = $('#chat-list');
  list.innerHTML = '';
  for (const chat of chats) {
    if (filter && !chat.name.toLowerCase().includes(filter) && !previewText(chat.last_message).toLowerCase().includes(filter)) continue;
    const li = document.createElement('li');
    li.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    const other = chat.type === 'direct' ? chat.members.find(m => m.id !== me.id) : null;
    li.innerHTML = `
      ${avatarHtml(other || { display_name: chat.name, avatar: null })}
      <div class="meta">
        <div class="row1"><span class="name">${esc(chat.name)}</span>
        <span class="time">${chat.last_message ? fmtTime(chat.last_message.created_at) : ''}</span></div>
        <div class="row1"><span class="preview">${esc(previewText(chat.last_message))}</span>
        ${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ''}</div>
      </div>`;
    li.onclick = () => openChat(chat.id);
    list.appendChild(li);
  }
  if (!list.children.length) {
    list.innerHTML = '<li style="padding:16px;color:var(--muted)">No chats yet. Tap ✚ to start one.</li>';
  }
}
$('#chat-filter').addEventListener('input', renderChatList);

async function refreshChats() {
  const { chats: fresh } = await api.get('/api/chats');
  chats = fresh;
  renderChatList();
  if (activeChatId) updateChatHeader();
}
async function refreshContacts() {
  const { contacts: fresh } = await api.get('/api/contacts');
  contacts = fresh;
}

// ---------------------------------------------------------------------------
// Conversation view
// ---------------------------------------------------------------------------
function getChat(id) { return chats.find(c => c.id === id); }

async function openChat(chatId) {
  activeChatId = chatId;
  chatSearchMode = false;
  $('#chat-search-bar').classList.add('hidden');
  $('#empty-state').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#app').classList.add('show-chat');
  replyTo = null; editingId = null; renderReplyBar();
  updateChatHeader();
  renderChatList();
  await loadMessages(chatId);
  markRead(chatId);
}
$('#btn-back').onclick = () => {
  activeChatId = null;
  $('#app').classList.remove('show-chat');
  $('#chat-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  renderChatList();
};

function updateChatHeader() {
  const chat = getChat(activeChatId);
  if (!chat) return;
  const other = chat.type === 'direct' ? chat.members.find(m => m.id !== me.id) : null;
  setAvatarBtn($('#chat-avatar'), other || { display_name: chat.name, avatar: null });
  $('#chat-title').textContent = chat.name;
  if (chat.type === 'direct' && other) {
    $('#chat-status').textContent = fmtLastSeen(other.last_seen, onlineIds.has(other.id));
  } else {
    $('#chat-status').textContent = `${chat.members.length} members`;
  }
}

async function loadMessages(chatId, before) {
  const params = new URLSearchParams({ limit: 50 });
  if (before) params.set('before', before);
  if (chatSearchMode) params.set('search', $('#chat-search-input').value.trim());
  const { messages } = await api.get(`/api/chats/${chatId}/messages?${params}`);
  if (chatId !== activeChatId) return;
  if (before) activeMessages = [...messages, ...activeMessages];
  else activeMessages = messages;
  renderMessages(before);
}
function renderMessages(keepScroll) {
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  box.innerHTML = '';
  const oldest = activeMessages[0];
  if (activeMessages.length >= 50) {
    const btn = document.createElement('button');
    btn.className = 'load-more';
    btn.textContent = 'Load older messages';
    btn.onclick = () => loadMessages(activeChatId, oldest.id);
    box.appendChild(btn);
  }
  let lastDay = '';
  for (const m of activeMessages) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div');
      d.className = 'day-divider';
      d.textContent = day;
      box.appendChild(d);
    }
    box.appendChild(messageEl(m));
  }
  if (keepScroll) box.scrollTop = box.scrollHeight - prevHeight;
  else box.scrollTop = box.scrollHeight;
}

function ticksHtml(m) {
  if (!m.ticks || m.sender.id !== me.id) return '';
  if (m.ticks === 'read') return ' <span class="ticks read">✓✓</span>';
  if (m.ticks === 'delivered') return ' <span class="ticks">✓✓</span>';
  return ' <span class="ticks">✓</span>';
}
function messageEl(m) {
  const div = document.createElement('div');
  const mine = m.sender.id === me.id;
  div.className = 'msg ' + (mine ? 'out' : 'in');
  div.dataset.id = m.id;
  const chat = getChat(activeChatId);
  const showName = chat && chat.type === 'group' && !mine;
  let inner = '';
  if (showName) inner += `<div class="sender-name">${esc(m.sender.display_name)}</div>`;
  if (m.reply_to) {
    const q = m.reply_to;
    const qText = q.deleted ? 'Message deleted' : q.type === 'image' ? '📷 Photo' : q.type === 'audio' ? '🎤 Voice message' : (q.body || '');
    inner += `<div class="reply-quote" data-quote="${q.id}"><span class="rq-name">${esc(q.sender_name)}</span><br>${esc(qText)}</div>`;
  }
  if (m.deleted) {
    inner += `<span class="deleted-text">🚫 This message was deleted</span>`;
  } else if (m.type === 'image' && m.file_url) {
    inner += `<img class="attached" src="${esc(m.file_url)}" alt="Photo">`;
    if (m.body) inner += `<div class="msg-text">${esc(m.body)}</div>`;
  } else if (m.type === 'audio' && m.file_url) {
    inner += `<audio controls preload="none" src="${esc(m.file_url)}"></audio>`;
  } else {
    inner += `<div class="msg-text">${esc(m.body || '')}</div>`;
  }
  inner += `<span class="msg-time">${fmtTime(m.created_at)}${m.edited ? ' <span class="edited-label">edited</span>' : ''}${ticksHtml(m)}</span>`;
  inner += `<span class="msg-actions"><button class="msg-menu-btn" title="Message actions">⋯</button></span>`;
  div.innerHTML = inner;
  div.querySelector('.msg-menu-btn').onclick = e => { e.stopPropagation(); showMessageMenu(m, e.currentTarget); };
  const quote = div.querySelector('.reply-quote');
  if (quote) quote.onclick = () => scrollToMessage(Number(quote.dataset.quote));
  const img = div.querySelector('img.attached');
  if (img) img.onclick = () => { $('#lightbox-img').src = img.src; $('#lightbox').classList.remove('hidden'); };
  return div;
}
$('#lightbox-close').onclick = () => $('#lightbox').classList.add('hidden');
$('#lightbox').onclick = e => { if (e.target.id === 'lightbox') $('#lightbox').classList.add('hidden'); };

function scrollToMessage(id) {
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--green)'; setTimeout(() => el.style.outline = '', 1200); }
}

// Floating menu for reply / edit / delete.
const menu = document.createElement('div');
menu.id = 'msg-menu';
menu.style.cssText = 'position:fixed;z-index:70;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);display:none;flex-direction:column;min-width:140px;overflow:hidden';
document.body.appendChild(menu);
function showMessageMenu(m, anchor) {
  menu.innerHTML = '';
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'text-align:left;padding:10px 14px;font-size:.95rem';
    b.onclick = () => { hideMenu(); fn(); };
    menu.appendChild(b);
  };
  if (!m.deleted) add('↩ Reply', () => startReply(m));
  if (!m.deleted && m.sender.id === me.id && m.type === 'text') add('✎ Edit', () => startEdit(m));
  if (!m.deleted && m.sender.id === me.id) add('🗑 Delete for everyone', () => deleteMessage(m));
  const r = anchor.getBoundingClientRect();
  menu.style.display = 'flex';
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - 160)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 160))}px`;
  setTimeout(() => document.addEventListener('click', hideMenu, { once: true }), 0);
}
function hideMenu() { menu.style.display = 'none'; }

function startReply(m) {
  replyTo = m;
  editingId = null;
  renderReplyBar();
  $('#message-input').focus();
}
function startEdit(m) {
  editingId = m.id;
  replyTo = null;
  $('#message-input').value = m.body || '';
  renderReplyBar();
  $('#message-input').focus();
}
async function deleteMessage(m) {
  if (!confirm('Delete this message for everyone?')) return;
  await api.del(`/api/messages/${m.id}`);
  applyLocalDelete(m.id);
}
function renderReplyBar() {
  const rb = $('#reply-bar'), eb = $('#edit-bar');
  if (replyTo) {
    rb.classList.remove('hidden');
    const t = replyTo.deleted ? 'Message deleted' : replyTo.type === 'image' ? '📷 Photo' : replyTo.type === 'audio' ? '🎤 Voice message' : (replyTo.body || '');
    $('#reply-preview-text').textContent = `${replyTo.sender.display_name}: ${t}`;
  } else rb.classList.add('hidden');
  eb.classList.toggle('hidden', !editingId);
  $('#btn-send').textContent = editingId ? '✓' : '➤';
}
$('#reply-cancel').onclick = () => { replyTo = null; renderReplyBar(); };
$('#edit-cancel').onclick = () => { editingId = null; $('#message-input').value = ''; renderReplyBar(); };

function applyLocalDelete(id) {
  activeMessages = activeMessages.map(m => m.id === id ? { ...m, deleted: true, body: null, file_url: null } : m);
  renderMessages(true);
}
function upsertMessage(m) {
  const i = activeMessages.findIndex(x => x.id === m.id);
  if (i >= 0) activeMessages[i] = m; else activeMessages.push(m);
  renderMessages(true);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
$('#composer').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!activeChatId || !text) return;
  if (editingId) {
    const id = editingId;
    editingId = null; input.value = ''; renderReplyBar();
    const { message } = await api.put(`/api/messages/${id}`, { body: text });
    upsertMessage(message);
    return;
  }
  const form = new FormData();
  form.append('body', text);
  if (replyTo) form.append('reply_to', replyTo.id);
  replyTo = null; input.value = ''; renderReplyBar();
  try {
    const { message } = await api.upload(`/api/chats/${activeChatId}/messages`, form);
    upsertMessage(message);
    refreshChats();
  } catch (err) { alert(err.message); }
});
$('#message-input').addEventListener('input', () => sendTyping(true));
$('#message-input').addEventListener('blur', () => sendTyping(false));

$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !activeChatId) return;
  const form = new FormData();
  form.append('file', file);
  form.append('body', $('#message-input').value.trim());
  if (replyTo) form.append('reply_to', replyTo.id);
  replyTo = null; $('#message-input').value = ''; renderReplyBar();
  try {
    const { message } = await api.upload(`/api/chats/${activeChatId}/messages`, form);
    upsertMessage(message);
    refreshChats();
  } catch (err) { alert(err.message); }
});

// Typing notifications (throttled).
let typingSentAt = 0, typingStopTimer = null;
function sendTyping(isTyping) {
  if (!socketAlive || !activeChatId) return;
  const nowMs = Date.now();
  if (isTyping && nowMs - typingSentAt < 2000) return;
  typingSentAt = nowMs;
  socket.send(JSON.stringify({ type: 'typing', chat_id: activeChatId, is_typing: isTyping }));
  clearTimeout(typingStopTimer);
  if (isTyping) typingStopTimer = setTimeout(() => sendTyping(false), 3000);
}

// ---------------------------------------------------------------------------
// Emoji picker
// ---------------------------------------------------------------------------
const EMOJIS = '😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😴 😭 😡 👍 👎 👏 🙏 💪 ❤️ 💔 🔥 ✨ 🎉 🎂 🐶 🐱 🌹 ☀️ 🌙 ⭐ ✅ ❌ ➡️ ⬅️'.split(' ');
const panel = $('#emoji-panel');
for (const em of EMOJIS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = em;
  b.onclick = () => { $('#message-input').value += em; $('#message-input').focus(); };
  panel.appendChild(b);
}
$('#btn-emoji').onclick = () => panel.classList.toggle('hidden');

// ---------------------------------------------------------------------------
// Voice notes (MediaRecorder, no external service)
// ---------------------------------------------------------------------------
let recorder = null, recChunks = [], recStart = 0, recTimer = null;
$('#btn-voice').onclick = async () => {
  if (recorder && recorder.state === 'recording') { stopRecording(false); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => stream.getTracks().forEach(t => t.stop());
    recorder.start();
    recStart = Date.now();
    $('#voice-recording').classList.remove('hidden');
    $('#btn-voice').textContent = '⏹';
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  } catch { alert('Microphone is not available in this browser.'); }
};
function stopRecording(cancel) {
  if (!recorder) return;
  clearInterval(recTimer);
  $('#voice-recording').classList.add('hidden');
  $('#btn-voice').textContent = '🎤';
  if (cancel) { try { recorder.stop(); } catch { /* noop */ } recorder = null; return; }
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    recorder = null;
    if (!activeChatId || blob.size < 100) return;
    const form = new FormData();
    form.append('file', blob, 'voice-note.webm');
    try {
      const { message } = await api.upload(`/api/chats/${activeChatId}/messages`, form);
      upsertMessage(message);
      refreshChats();
    } catch (err) { alert(err.message); }
  };
  recorder.stop();
}
$('#btn-voice-cancel').onclick = () => stopRecording(true);
$('#btn-voice-send').onclick = () => stopRecording(false);

// ---------------------------------------------------------------------------
// Read receipts
// ---------------------------------------------------------------------------
let readDebounce = null;
function markRead(chatId) {
  clearTimeout(readDebounce);
  readDebounce = setTimeout(async () => {
    try {
      await api.post(`/api/chats/${chatId}/read`);
      if (socketAlive) socket.send(JSON.stringify({ type: 'read', chat_id: chatId }));
    } catch { /* ignore */ }
    refreshChats();
  }, 300);
}

// ---------------------------------------------------------------------------
// WebSocket + polling fallback
// ---------------------------------------------------------------------------
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.onopen = () => {
    socketAlive = true;
    $('#connection-status').classList.add('hidden');
    if (activeChatId) loadMessages(activeChatId);
    refreshChats();
  };
  socket.onclose = () => {
    socketAlive = false;
    $('#connection-status').classList.remove('hidden');
    setTimeout(connectSocket, 3000);
  };
  socket.onerror = () => { try { socket.close(); } catch { /* noop */ } };
  socket.onmessage = ev => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'message') {
      if (data.message.chat_id === activeChatId) {
        upsertMessage(data.message);
        markRead(activeChatId);
      }
      refreshChats();
    } else if (data.type === 'message-edited') {
      if (data.message.chat_id === activeChatId) upsertMessage(data.message);
      refreshChats();
    } else if (data.type === 'message-deleted') {
      if (data.chat_id === activeChatId) applyLocalDelete(data.message_id);
      refreshChats();
    } else if (data.type === 'read') {
      if (data.chat_id === activeChatId) loadMessages(activeChatId);
      refreshChats();
    } else if (data.type === 'chat-created') {
      refreshChats();
    } else if (data.type === 'presence') {
      onlineIds = new Set(data.online);
      if (activeChatId) updateChatHeader();
    } else if (data.type === 'typing') {
      showTyping(data);
    }
  };
}
function showTyping(data) {
  if (data.chat_id !== activeChatId || data.user_id === me.id) return;
  const el = $('#typing-indicator');
  if (data.is_typing) {
    el.textContent = `${data.name} is typing…`;
    el.classList.remove('hidden');
    const prev = typingUsers.get(data.user_id);
    if (prev) clearTimeout(prev);
    typingUsers.set(data.user_id, setTimeout(() => {
      typingUsers.delete(data.user_id);
      if (!typingUsers.size) el.classList.add('hidden');
    }, 3500));
  } else {
    const t = typingUsers.get(data.user_id);
    if (t) { clearTimeout(t); typingUsers.delete(data.user_id); }
    if (!typingUsers.size) el.classList.add('hidden');
  }
}
function startPollingFallback() {
  // If the socket is down, poll so messages still arrive.
  pollTimer = setInterval(() => {
    if (socketAlive) return;
    refreshChats();
    if (activeChatId) loadMessages(activeChatId);
  }, 4000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !socketAlive) { refreshChats(); if (activeChatId) loadMessages(activeChatId); }
});

// ---------------------------------------------------------------------------
// Chat search
// ---------------------------------------------------------------------------
$('#btn-chat-search').onclick = () => {
  $('#chat-search-bar').classList.toggle('hidden');
  if (!$('#chat-search-bar').classList.contains('hidden')) $('#chat-search-input').focus();
  else { chatSearchMode = false; if (activeChatId) loadMessages(activeChatId); }
};
$('#chat-search-close').onclick = () => {
  $('#chat-search-bar').classList.add('hidden');
  chatSearchMode = false;
  if (activeChatId) loadMessages(activeChatId);
};
let searchDebounce = null;
$('#chat-search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    chatSearchMode = !!$('#chat-search-input').value.trim();
    if (activeChatId) loadMessages(activeChatId);
  }, 300);
});

// ---------------------------------------------------------------------------
// Modals: new chat, new group, chat info, profile
// ---------------------------------------------------------------------------
function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-overlay').classList.remove('hidden');
  return $('#modal-body');
}
function closeModal() { $('#modal-overlay').classList.add('hidden'); }
$('#modal-close').onclick = closeModal;
$('#modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });

$('#btn-new-chat').onclick = () => {
  const body = openModal('New chat', `
    <input id="user-search" type="search" placeholder="Search people by username or name">
    <div id="user-results"></div>
    <div class="modal-note" style="color:var(--muted);font-size:.85rem">People you add become contacts. Anyone who signs up can be found here.</div>`);
  const input = body.querySelector('#user-search');
  const results = body.querySelector('#user-results');
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      const { users } = await api.get(`/api/users?q=${encodeURIComponent(q)}`);
      results.innerHTML = '';
      if (!users.length) results.innerHTML = '<p style="color:var(--muted)">No one found with that name.</p>';
      for (const u of users) {
        const row = document.createElement('div');
        row.className = 'user-row';
        row.innerHTML = `${avatarHtml(u)}<div class="who"><div>${esc(u.display_name)}</div><div class="uname">@${esc(u.username)}</div></div><button class="btn-primary">Chat</button>`;
        row.querySelector('button').onclick = async () => {
          await api.post('/api/contacts', { contact_id: u.id });
          const { chat } = await api.post('/api/chats', { type: 'direct', member_ids: [u.id] });
          await refreshContacts();
          closeModal();
          await refreshChats();
          openChat(chat.id);
        };
        results.appendChild(row);
      }
    }, 250);
  });
  input.focus();
};

$('#btn-new-group').onclick = async () => {
  await refreshContacts();
  const body = openModal('New group', `
    <input id="group-name" type="text" placeholder="Group name" maxlength="40">
    <div id="group-members"></div>
    <button id="create-group" class="btn-primary">Create group</button>`);
  const list = body.querySelector('#group-members');
  const selected = new Set();
  const renderMembers = () => {
    list.innerHTML = '';
    if (!contacts.length) list.innerHTML = '<p style="color:var(--muted)">Add contacts first (from New chat) to add them to a group.</p>';
    for (const c of contacts) {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `<input type="checkbox" class="member-check" ${selected.has(c.id) ? 'checked' : ''}>${avatarHtml(c)}<div class="who"><div>${esc(c.display_name)}</div><div class="uname">@${esc(c.username)}</div></div>`;
      row.querySelector('input').onchange = e => { e.target.checked ? selected.add(c.id) : selected.delete(c.id); };
      list.appendChild(row);
    }
  };
  renderMembers();
  body.querySelector('#create-group').onclick = async () => {
    const name = body.querySelector('#group-name').value.trim();
    if (!name) { alert('Give the group a name.'); return; }
    if (!selected.size) { alert('Pick at least one person.'); return; }
    try {
      const { chat } = await api.post('/api/chats', { type: 'group', name, member_ids: [...selected] });
      closeModal();
      await refreshChats();
      openChat(chat.id);
    } catch (err) { alert(err.message); }
  };
};

$('#btn-chat-info').onclick = async () => {
  const chat = getChat(activeChatId);
  if (!chat) return;
  const body = openModal(chat.type === 'group' ? 'Group info' : 'Contact info', '');
  const memberRows = chat.members.map(m => `
    <div class="user-row">${avatarHtml(m)}<div class="who"><div>${esc(m.display_name)}</div><div class="uname">@${esc(m.username)}</div></div>
    ${chat.type === 'group' && m.id !== me.id && chat.members.find(x => x.id === me.id) ? `<button data-remove="${m.id}">Remove</button>` : ''}</div>`).join('');
  body.innerHTML = `
    ${chat.type === 'group' ? `<div class="user-row">${avatarHtml({ display_name: chat.name, avatar: null }, true)}<div class="who"><div><b>${esc(chat.name)}</b></div><div class="uname">${chat.members.length} members</div></div></div>` : ''}
    <h3 style="font-size:.95rem">Members</h3>${memberRows}
    <div id="add-member-wrap"></div>
    ${chat.type === 'group' ? '<button id="leave-group" style="color:var(--danger)">Leave group</button>' : ''}`;
  body.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = async () => {
      await api.del(`/api/chats/${chat.id}/members/${btn.dataset.remove}`);
      closeModal(); await refreshChats(); openChat(chat.id);
    };
  });
  const leave = body.querySelector('#leave-group');
  if (leave) leave.onclick = async () => {
    if (!confirm('Leave this group?')) return;
    await api.del(`/api/chats/${chat.id}/members/${me.id}`);
    closeModal(); $('#btn-back').click(); await refreshChats();
  };
  if (chat.type === 'group') {
    const wrap = body.querySelector('#add-member-wrap');
    wrap.innerHTML = '<input id="add-member-search" type="search" placeholder="Add someone by username"><div id="add-member-results"></div>';
    const input = wrap.querySelector('#add-member-search');
    const results = wrap.querySelector('#add-member-results');
    let t = null;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) { results.innerHTML = ''; return; }
        const { users } = await api.get(`/api/users?q=${encodeURIComponent(q)}`);
        results.innerHTML = '';
        for (const u of users.filter(u => !chat.members.some(m => m.id === u.id))) {
          const row = document.createElement('div');
          row.className = 'user-row';
          row.innerHTML = `${avatarHtml(u)}<div class="who"><div>${esc(u.display_name)}</div><div class="uname">@${esc(u.username)}</div></div><button class="btn-primary">Add</button>`;
          row.querySelector('button').onclick = async () => {
            await api.post(`/api/chats/${chat.id}/members`, { user_id: u.id });
            closeModal(); await refreshChats(); openChat(chat.id);
          };
          results.appendChild(row);
        }
      }, 250);
    });
  }
};

$('#me-avatar').onclick = () => {
  const body = openModal('My profile', `
    <div style="display:flex;gap:12px;align-items:center">${avatarHtml(me, true)}
    <div><div><b>${esc(me.display_name)}</b></div><div style="color:var(--muted)">@${esc(me.username)}</div></div></div>
    <input id="profile-name" type="text" value="${esc(me.display_name)}" maxlength="40" placeholder="Display name">
    <label style="font-size:.9rem">Profile photo <input id="profile-avatar" type="file" accept="image/*"></label>
    <button id="save-profile" class="btn-primary">Save</button>`);
  body.querySelector('#save-profile').onclick = async () => {
    const name = body.querySelector('#profile-name').value.trim();
    if (name && name !== me.display_name) {
      const { user } = await api.put('/api/me', { display_name: name });
      me = user;
    }
    const file = body.querySelector('#profile-avatar').files[0];
    if (file) {
      const form = new FormData();
      form.append('avatar', file);
      const { user } = await api.upload('/api/me/avatar', form);
      me = user;
    }
    setAvatarBtn($('#me-avatar'), me);
    $('#me-name').textContent = me.display_name;
    closeModal();
  };
};

boot();
