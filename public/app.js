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
// Stable, varied avatar color per person (overridden when they have a photo).
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}
function avatarHtml(user, large) {
  const inner = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user.display_name));
  const style = user.avatar ? '' : ` style="background:${avatarColor(user.display_name)}"`;
  return `<span class="avatar${large ? ' large' : ''}"${style}>${inner}</span>`;
}
function avatarWrap(user, large) {
  const online = isOnline(user.id);
  return `<span class="avatar-wrap">${avatarHtml(user, large)}${online ? '<span class="dot online"></span>' : ''}</span>`;
}
function setAvatarBtn(btn, user, large) {
  btn.innerHTML = user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user.display_name));
  btn.style.background = user.avatar ? '' : avatarColor(user.display_name);
  btn.classList.toggle('large', !!large);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let me = null;
let chats = [];
let contacts = [];
let directory = [];
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
let sidebarTab = 'chats';
let blockedIds = new Set();
let showArchived = false;

// ---------------------------------------------------------------------------
// Settings (stored on this device) + toast + sounds
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'chat-settings-v1';
let settings = Object.assign(
  { theme: 'light', wallpaper: 'doodle', fontSize: 'medium', sounds: true },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
);
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function applySettings() {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.wallpaper = settings.wallpaper;
  document.body.dataset.font = settings.fontSize;
}
applySettings();
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
let audioCtx = null;
function beep() {
  if (!settings.sounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.2);
  } catch { /* audio unavailable */ }
}
function isOnline(id) { return onlineIds.has(id) && !blockedIds.has(id); }
async function refreshBlocks() {
  try {
    const { blocked } = await api.get('/api/blocks');
    blockedIds = new Set(blocked.map(u => u.id));
  } catch { /* ignore */ }
}

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
  await refreshBlocks();
  await refreshChats();
  await refreshContacts();
  await refreshDirectory();
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
  const archived = chats.filter(c => c.prefs.archived);
  const row = $('#archived-row');
  if (archived.length) {
    row.classList.remove('hidden');
    $('#archived-count').textContent = archived.length;
  } else row.classList.add('hidden');
  const visible = chats.filter(c => showArchived ? c.prefs.archived : !c.prefs.archived);
  for (const chat of visible) {
    if (filter && !chat.name.toLowerCase().includes(filter) && !previewText(chat.last_message).toLowerCase().includes(filter)) continue;
    const li = document.createElement('li');
    li.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    const other = chat.type === 'direct' ? chat.members.find(m => m.id !== me.id) : null;
    const flags = `${chat.prefs.pinned ? '<span class="chat-flags">📌</span>' : ''}${chat.prefs.muted ? '<span class="chat-flags">🔇</span>' : ''}`;
    li.innerHTML = `
      ${avatarWrap(other || { display_name: chat.name, avatar: null, id: -1 })}
      <div class="meta">
        <div class="row1"><span class="name">${flags}${esc(chat.name)}</span>
        <span class="time">${chat.last_message ? fmtTime(chat.last_message.created_at) : ''}</span></div>
        <div class="row1"><span class="preview">${esc(previewText(chat.last_message))}</span>
        ${chat.unread ? `<span class="unread-badge${chat.prefs.muted ? ' muted' : ''}">${chat.unread}</span>` : ''}</div>
      </div>`;
    li.onclick = () => openChat(chat.id);
    list.appendChild(li);
  }
  if (!list.children.length) {
    list.innerHTML = showArchived
      ? '<li style="padding:16px;color:var(--muted)">No archived chats.</li>'
      : '<li style="padding:16px;color:var(--muted)">No chats yet. Tap ✚ to start one.</li>';
  }
}
$('#archived-row').onclick = () => {
  showArchived = !showArchived;
  $('#archived-row').style.background = showArchived ? 'var(--panel)' : '';
  renderChatList();
};
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
async function refreshDirectory() {
  try {
    const { users } = await api.get('/api/directory');
    directory = users;
    renderContacts();
  } catch { /* directory is a nice-to-have; chats still work */ }
}

// ---------------------------------------------------------------------------
// Contacts tab: everyone on Chat, contacts first, with call + message buttons
// ---------------------------------------------------------------------------
function setSidebarTab(tab) {
  sidebarTab = tab;
  $('#tab-chats').classList.toggle('active', tab === 'chats');
  $('#tab-contacts').classList.toggle('active', tab === 'contacts');
  $('#chat-list').classList.toggle('hidden', tab !== 'chats');
  $('#contacts-pane').classList.toggle('hidden', tab !== 'contacts');
  $('.search-box').classList.toggle('hidden', tab !== 'chats');
  if (tab === 'contacts') refreshDirectory();
}
$('#tab-chats').onclick = () => setSidebarTab('chats');
$('#tab-contacts').onclick = () => setSidebarTab('contacts');
$('#contact-filter').addEventListener('input', renderContacts);

function contactRow(u, isContact) {
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `
    ${avatarWrap(u)}
    <div class="who"><div class="cname">${esc(u.display_name)}</div>
    <div class="uname">${isOnline(u.id) ? 'Online' : (u.last_seen ? fmtLastSeen(u.last_seen, false) : `@${esc(u.username)}`)}</div></div>
    <div class="contact-actions">
      <button class="icon-btn" title="Message" data-act="chat">💬</button>
      <button class="icon-btn" title="Voice call" data-act="voice">📞</button>
      <button class="icon-btn" title="Video call" data-act="video">📹</button>
    </div>`;
  row.querySelector('[data-act="chat"]').onclick = () => startChatWith(u);
  row.querySelector('[data-act="voice"]').onclick = () => startCall(u, 'audio');
  row.querySelector('[data-act="video"]').onclick = () => startCall(u, 'video');
  return row;
}
function renderContacts() {
  const list = $('#contacts-list');
  if (!list) return;
  const filter = ($('#contact-filter').value || '').trim().toLowerCase();
  const match = u => !filter || u.display_name.toLowerCase().includes(filter) || u.username.toLowerCase().includes(filter);
  const mine = directory.filter(u => u.is_contact && match(u));
  const everyone = directory.filter(u => !u.is_contact && match(u));
  list.innerHTML = '';
  const section = label => {
    const h = document.createElement('div');
    h.className = 'section-label';
    h.textContent = label;
    list.appendChild(h);
  };
  if (mine.length) { section('My contacts'); mine.forEach(u => list.appendChild(contactRow(u, true))); }
  section(everyone.length ? 'Everyone on Chat' : 'Everyone on Chat');
  if (!everyone.length && !mine.length) {
    list.innerHTML += '<p class="empty-note">No one else is on Chat yet. When someone signs up, they will appear here.</p>';
  } else {
    everyone.forEach(u => list.appendChild(contactRow(u, false)));
  }
  if (!mine.length && !everyone.length && filter) {
    list.innerHTML = '<p class="empty-note">No one matches that search.</p>';
  }
}
async function startChatWith(u) {
  try {
    await api.post('/api/contacts', { contact_id: u.id });
    const { chat } = await api.post('/api/chats', { type: 'direct', member_ids: [u.id] });
    await refreshContacts();
    await refreshDirectory();
    await refreshChats();
    setSidebarTab('chats');
    openChat(chat.id);
  } catch (err) { alert(err.message); }
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
  const showCalls = chat.type === 'direct' && !!other;
  $('#btn-call-voice').style.display = showCalls ? '' : 'none';
  $('#btn-call-video').style.display = showCalls ? '' : 'none';
  if (chat.type === 'direct' && other) {
    $('#chat-status').textContent = fmtLastSeen(other.last_seen, isOnline(other.id));
  } else {
    $('#chat-status').textContent = `${chat.members.length} members`;
  }
}
$('#btn-call-voice').onclick = () => {
  const chat = getChat(activeChatId);
  const other = chat?.members.find(m => m.id !== me.id);
  if (other) startCall(other, 'audio');
};
$('#btn-call-video').onclick = () => {
  const chat = getChat(activeChatId);
  const other = chat?.members.find(m => m.id !== me.id);
  if (other) startCall(other, 'video');
};

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
  // If I turned read receipts off, I can't see other people's blue ticks either.
  if (m.ticks === 'read' && me.read_receipts === false) return ' <span class="ticks">✓✓</span>';
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
  if (m.forwarded) inner += `<div class="forwarded-label">➦ Forwarded</div>`;
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
  inner += `<span class="msg-time">${fmtTime(m.created_at)}${m.edited ? ' <span class="edited-label">edited</span>' : ''}${m.starred ? '<span class="starred-mark">★</span>' : ''}${ticksHtml(m)}</span>`;
  inner += `<span class="msg-actions"><button class="msg-menu-btn" title="Message actions">⋯</button></span>`;
  if (m.reactions && m.reactions.length) {
    const groups = {};
    for (const r of m.reactions) (groups[r.emoji] = groups[r.emoji] || []).push(r);
    inner += '<div class="reactions">' + Object.entries(groups).map(([emoji, rs]) => {
      const mine = rs.some(r => r.user_id === me.id);
      const names = rs.map(r => r.display_name).join(', ');
      return `<button class="reaction-chip${mine ? ' mine' : ''}" data-emoji="${esc(emoji)}" title="${esc(names)}">${esc(emoji)} ${rs.length}</button>`;
    }).join('') + '</div>';
  }
  div.innerHTML = inner;
  div.querySelectorAll('.reaction-chip').forEach(chip => {
    chip.onclick = e => { e.stopPropagation(); toggleReaction(m, chip.dataset.emoji); };
  });
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

// Floating menus (message actions, chat actions) + reaction picker.
const menu = document.createElement('div');
menu.className = 'float-menu';
document.body.appendChild(menu);
const chatMenu = document.createElement('div');
chatMenu.className = 'float-menu';
document.body.appendChild(chatMenu);
const reactionPicker = document.createElement('div');
reactionPicker.className = 'reaction-picker';
document.body.appendChild(reactionPicker);
function closeFloatMenus() {
  menu.classList.remove('open');
  chatMenu.classList.remove('open');
  reactionPicker.classList.remove('open');
}
function placeFloat(el, anchorRect) {
  el.classList.add('open');
  const w = el.offsetWidth || 200, h = el.offsetHeight || 200;
  el.style.top = `${Math.min(anchorRect.bottom + 4, innerHeight - h - 8)}px`;
  el.style.left = `${Math.max(8, Math.min(anchorRect.left, innerWidth - w - 8))}px`;
}
document.addEventListener('click', e => {
  if (!e.target.closest('.float-menu') && !e.target.closest('.reaction-picker') && !e.target.closest('.msg-menu-btn') && !e.target.closest('#btn-chat-menu')) closeFloatMenus();
});
function showMessageMenu(m, anchor) {
  closeFloatMenus();
  menu.innerHTML = '';
  const add = (label, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.onclick = () => { closeFloatMenus(); fn(); };
    menu.appendChild(b);
  };
  if (!m.deleted) {
    add('😀 React', () => showReactionPicker(m, anchor));
    add('↩ Reply', () => startReply(m));
    add('➦ Forward', () => openForwardDialog(m));
    if (m.type === 'text' && m.body) add('📋 Copy', () => copyMessage(m));
    add(m.starred ? '☆ Unstar' : '★ Star', () => toggleStar(m));
    if (m.sender.id === me.id) add('ℹ️ Info', () => showMessageInfo(m));
    if (m.sender.id === me.id && m.type === 'text') add('✎ Edit', () => startEdit(m));
    if (m.sender.id === me.id) add('🗑 Delete for everyone', () => deleteMessage(m), true);
  } else if (m.sender.id === me.id) {
    add('🗑 Delete for everyone', () => deleteMessage(m), true);
  }
  placeFloat(menu, anchor.getBoundingClientRect());
}
function hideMenu() { closeFloatMenus(); }

const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🙏', '👍', '🔥'];
function showReactionPicker(m, anchor) {
  reactionPicker.innerHTML = '';
  for (const emoji of REACTION_EMOJIS) {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.onclick = () => { closeFloatMenus(); toggleReaction(m, emoji); };
    reactionPicker.appendChild(b);
  }
  placeFloat(reactionPicker, anchor.getBoundingClientRect());
}
async function toggleReaction(m, emoji) {
  try {
    const mine = (m.reactions || []).find(r => r.user_id === me.id);
    if (mine && mine.emoji === emoji) {
      const { message } = await api.del(`/api/messages/${m.id}/reactions`);
      upsertMessage(message);
    } else {
      const { message } = await api.post(`/api/messages/${m.id}/reactions`, { emoji });
      upsertMessage(message);
    }
  } catch (err) { toast(err.message); }
}
async function toggleStar(m) {
  try {
    if (m.starred) await api.del(`/api/messages/${m.id}/star`);
    else await api.post(`/api/messages/${m.id}/star`);
    activeMessages = activeMessages.map(x => x.id === m.id ? { ...x, starred: !m.starred } : x);
    renderMessages(true);
    toast(m.starred ? 'Removed from starred' : 'Starred');
  } catch (err) { toast(err.message); }
}
async function copyMessage(m) {
  try {
    await navigator.clipboard.writeText(m.body || '');
    toast('Copied');
  } catch { toast('Copy is not available here'); }
}
async function showMessageInfo(m) {
  try {
    const { info } = await api.get(`/api/messages/${m.id}/info`);
    const rows = info.map(i => `
      <div class="user-row">${avatarHtml(i.user)}<div class="who"><div>${esc(i.user.display_name)}</div>
      <div class="uname">${i.read ? '✓✓ Read' : i.delivered ? '✓✓ Delivered' : '✓ Sent'}</div></div></div>`).join('');
    openModal('Message info', rows || '<p style="color:var(--muted)">No one else is in this chat yet.</p>', true);
  } catch (err) { toast(err.message); }
}
function openForwardDialog(m) {
  const body = openModal('Forward to…', '', true);
  const list = document.createElement('div');
  const selected = new Set();
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const other = chat.type === 'direct' ? chat.members.find(x => x.id !== me.id) : null;
    row.innerHTML = `<input type="checkbox" class="member-check">${avatarHtml(other || { display_name: chat.name, avatar: null, id: -1 })}<div class="who"><div>${esc(chat.name)}</div></div>`;
    row.querySelector('input').onchange = e => { e.target.checked ? selected.add(chat.id) : selected.delete(chat.id); };
    list.appendChild(row);
  }
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.textContent = 'Forward';
  btn.onclick = async () => {
    if (!selected.size) { toast('Pick at least one chat'); return; }
    try {
      await api.post(`/api/messages/${m.id}/forward`, { chat_ids: [...selected] });
      closeModal();
      await refreshChats();
      toast('Forwarded');
    } catch (err) { toast(err.message); }
  };
  body.append(list, btn);
}

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
      } else if (data.message.sender.id !== me.id) {
        beep();
      }
      refreshChats();
    } else if (data.type === 'message-edited') {
      if (data.message.chat_id === activeChatId) upsertMessage(data.message);
      refreshChats();
    } else if (data.type === 'message-updated') {
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
      renderChatList();
      renderContacts();
    } else if (data.type === 'typing') {
      showTyping(data);
    } else if (typeof data.type === 'string' && data.type.startsWith('call:')) {
      handleCallSignal(data);
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
function openModal(title, bodyHtml, wide) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  document.querySelector('.modal').classList.toggle('wide', !!wide);
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

// ---------------------------------------------------------------------------
// Chat options menu, settings, starred messages, richer chat info
// ---------------------------------------------------------------------------
async function setChatPref(chatId, patch, label) {
  try {
    const { prefs } = await api.put(`/api/chats/${chatId}/prefs`, patch);
    const chat = getChat(chatId);
    if (chat) chat.prefs = prefs;
    renderChatList();
    if (label) toast(label);
  } catch (err) { toast(err.message); }
}
$('#btn-chat-menu').onclick = () => {
  const chat = getChat(activeChatId);
  if (!chat) return;
  closeFloatMenus();
  chatMenu.innerHTML = '';
  const add = (label, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.onclick = () => { closeFloatMenus(); fn(); };
    chatMenu.appendChild(b);
  };
  add('ℹ️ Chat info', () => $('#btn-chat-info').click());
  add(chat.prefs.pinned ? '📌 Unpin chat' : '📌 Pin chat',
    () => setChatPref(chat.id, { pinned: !chat.prefs.pinned }, chat.prefs.pinned ? 'Unpinned' : 'Pinned'));
  add(chat.prefs.muted ? '🔔 Unmute' : '🔇 Mute',
    () => setChatPref(chat.id, { muted: !chat.prefs.muted }, chat.prefs.muted ? 'Unmuted' : 'Muted'));
  add(chat.prefs.archived ? '📦 Unarchive' : '📦 Archive chat',
    () => setChatPref(chat.id, { archived: !chat.prefs.archived }, chat.prefs.archived ? 'Unarchived' : 'Archived'));
  add(chat.type === 'group' ? '🚪 Leave group' : '🗑 Delete chat', async () => {
    if (!confirm(chat.type === 'group' ? 'Leave this group?' : 'Delete this chat? This removes it from your list.')) return;
    try {
      await api.del(`/api/chats/${chat.id}`);
      $('#btn-back').click();
      await refreshChats();
    } catch (err) { toast(err.message); }
  }, true);
  placeFloat(chatMenu, $('#btn-chat-menu').getBoundingClientRect());
};

async function openStarredView() {
  const body = openModal('Starred messages', '<p style="color:var(--muted)">Loading…</p>', true);
  try {
    const { messages } = await api.get('/api/starred');
    if (!messages.length) { body.innerHTML = '<p style="color:var(--muted)">No starred messages yet. Tap ⋯ on any message and choose Star.</p>'; return; }
    body.innerHTML = '';
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.style.cursor = 'pointer';
      const text = m.deleted ? 'Message deleted' : m.type === 'image' ? '📷 Photo' : m.type === 'audio' ? '🎤 Voice message' : (m.body || '');
      row.innerHTML = `${avatarHtml(m.sender)}<div class="who"><div>${esc(m.sender.display_name)} <span style="color:var(--muted);font-weight:400">· ${esc(m.chat_name)}</span></div><div class="uname">${esc(text)}</div></div><span style="color:var(--muted);font-size:.75rem">${fmtTime(m.created_at)}</span>`;
      row.onclick = async () => {
        closeModal();
        await openChat(m.chat_id);
        setTimeout(() => scrollToMessage(m.id), 350);
      };
      body.appendChild(row);
    }
  } catch (err) { body.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

function switchRow(label, desc, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = `<div><div class="s-label">${label}</div>${desc ? `<div class="s-desc">${desc}</div>` : ''}</div>
    <label class="switch"><input type="checkbox" ${checked ? 'checked' : ''}><span class="track"></span></label>`;
  row.querySelector('input').onchange = e => onChange(e.target.checked);
  return row;
}

async function openSettings() {
  const body = openModal('Settings', '', true);
  body.innerHTML = `
    <div class="settings-section">
      <h3>Profile</h3>
      <div class="profile-head">${avatarHtml(me, true)}
        <div class="who"><div style="font-weight:700">${esc(me.display_name)}</div>
        <div style="color:var(--muted);font-size:.85rem">@${esc(me.username)}</div>
        <div style="color:var(--muted);font-size:.85rem">${esc(me.about || 'No about yet')}</div></div></div>
      <input id="set-name" type="text" value="${esc(me.display_name)}" maxlength="40" placeholder="Display name">
      <textarea id="set-about" rows="2" maxlength="140" placeholder="About (e.g. Available, At work…)">${esc(me.about || '')}</textarea>
      <label style="font-size:.9rem">Profile photo <input id="set-avatar" type="file" accept="image/*"></label>
      <button id="set-save-profile" class="btn-primary">Save profile</button>
    </div>
    <div class="settings-section">
      <h3>Appearance</h3>
      <div class="setting-row"><div><div class="s-label">Theme</div></div>
        <div class="seg" id="set-theme">
          <button data-val="light">Light</button><button data-val="dark">Dark</button>
        </div></div>
      <div class="setting-row"><div><div class="s-label">Chat wallpaper</div></div>
        <div class="wall-swatches" id="set-wallpaper">
          <button class="swatch" data-val="doodle" title="Doodle" style="background:#e9e2d8;background-image:radial-gradient(rgba(7,94,84,.25) 1px,transparent 1px);background-size:10px 10px"></button>
          <button class="swatch" data-val="plain" title="Plain" style="background:#e9e2d8"></button>
          <button class="swatch" data-val="sage" title="Sage" style="background:#dfe8dd"></button>
          <button class="swatch" data-val="sky" title="Sky" style="background:#dde7f0"></button>
          <button class="swatch" data-val="sand" title="Sand" style="background:#efe6d8"></button>
        </div></div>
      <div class="setting-row"><div><div class="s-label">Message text size</div></div>
        <div class="seg" id="set-font">
          <button data-val="small">Small</button><button data-val="medium">Medium</button><button data-val="large">Large</button>
        </div></div>
    </div>
    <div class="settings-section">
      <h3>Notifications</h3>
      <div id="set-sounds"></div>
    </div>
    <div class="settings-section">
      <h3>Privacy</h3>
      <div class="setting-row"><div><div class="s-label">Last seen</div><div class="s-desc">Who can see when you were last online</div></div>
        <select id="set-lastseen">
          <option value="everyone">Everyone</option>
          <option value="contacts">My contacts</option>
          <option value="nobody">Nobody</option>
        </select></div>
      <div id="set-receipts"></div>
      <button id="set-starred" class="btn-ghost">★ Starred messages</button>
      <div id="set-blocked"></div>
    </div>
    <div class="settings-section">
      <h3>Account</h3>
      <input id="set-cur-pass" type="password" placeholder="Current password" autocomplete="current-password">
      <input id="set-new-pass" type="password" placeholder="New password (min 4 characters)" autocomplete="new-password">
      <button id="set-change-pass" class="btn-primary">Change password</button>
      <button id="set-logout" class="btn-danger">Log out</button>
    </div>
    <div class="settings-section">
      <p style="color:var(--muted);font-size:.85rem">Chat v1.1 · Messages are stored on the Chat server. Your login stays active on this device for a year unless you log out.</p>
    </div>`;

  const markSeg = (root, val) => root.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === val));
  const themeSeg = body.querySelector('#set-theme');
  markSeg(themeSeg, settings.theme);
  themeSeg.querySelectorAll('button').forEach(b => b.onclick = () => { settings.theme = b.dataset.val; saveSettings(); applySettings(); markSeg(themeSeg, settings.theme); });
  const wallSeg = body.querySelector('#set-wallpaper');
  markSeg(wallSeg, settings.wallpaper);
  wallSeg.querySelectorAll('button').forEach(b => b.onclick = () => { settings.wallpaper = b.dataset.val; saveSettings(); applySettings(); markSeg(wallSeg, settings.wallpaper); });
  const fontSeg = body.querySelector('#set-font');
  markSeg(fontSeg, settings.fontSize);
  fontSeg.querySelectorAll('button').forEach(b => b.onclick = () => { settings.fontSize = b.dataset.val; saveSettings(); applySettings(); markSeg(fontSeg, settings.fontSize); });

  body.querySelector('#set-sounds').appendChild(switchRow('Message sounds', 'Play a sound when a new message arrives', settings.sounds, v => { settings.sounds = v; saveSettings(); }));
  body.querySelector('#set-receipts').appendChild(switchRow('Read receipts', 'When off, people only see "delivered" for messages you read, and you won\'t see blue ticks either', me.read_receipts !== false, async v => {
    try { const { user } = await api.put('/api/me', { read_receipts: v }); me = user; toast('Saved'); }
    catch (err) { toast(err.message); }
  }));
  body.querySelector('#set-lastseen').value = me.last_seen_visibility || 'everyone';
  body.querySelector('#set-lastseen').onchange = async e => {
    try { const { user } = await api.put('/api/me', { last_seen_visibility: e.target.value }); me = user; toast('Saved'); }
    catch (err) { toast(err.message); }
  };
  body.querySelector('#set-starred').onclick = openStarredView;
  body.querySelector('#set-save-profile').onclick = async () => {
    const name = body.querySelector('#set-name').value.trim();
    const about = body.querySelector('#set-about').value;
    try {
      const { user } = await api.put('/api/me', { display_name: name, about });
      me = user;
      const file = body.querySelector('#set-avatar').files[0];
      if (file) {
        const form = new FormData();
        form.append('avatar', file);
        const r = await api.upload('/api/me/avatar', form);
        me = r.user;
      }
      setAvatarBtn($('#me-avatar'), me);
      $('#me-name').textContent = me.display_name;
      toast('Profile saved');
      openSettings();
    } catch (err) { toast(err.message); }
  };
  body.querySelector('#set-change-pass').onclick = async () => {
    const cur = body.querySelector('#set-cur-pass').value;
    const next = body.querySelector('#set-new-pass').value;
    try {
      await api.post('/api/change-password', { current_password: cur, new_password: next });
      toast('Password changed');
      body.querySelector('#set-cur-pass').value = '';
      body.querySelector('#set-new-pass').value = '';
    } catch (err) { toast(err.message); }
  };
  body.querySelector('#set-logout').onclick = async () => {
    try { await api.post('/api/logout'); } catch { /* ignore */ }
    location.reload();
  };
  // Blocked list
  const blockedWrap = body.querySelector('#set-blocked');
  try {
    const { blocked } = await api.get('/api/blocks');
    if (blocked.length) {
      const h = document.createElement('div');
      h.innerHTML = '<div class="s-label" style="margin-top:6px">Blocked people</div>';
      blockedWrap.appendChild(h);
      for (const u of blocked) {
        const row = document.createElement('div');
        row.className = 'user-row';
        row.innerHTML = `${avatarHtml(u)}<div class="who"><div>${esc(u.display_name)}</div><div class="uname">@${esc(u.username)}</div></div><button class="btn-ghost">Unblock</button>`;
        row.querySelector('button').onclick = async () => {
          await api.del(`/api/blocks/${u.id}`);
          await refreshBlocks();
          await refreshDirectory();
          toast('Unblocked');
          openSettings();
        };
        blockedWrap.appendChild(row);
      }
    }
  } catch { /* ignore */ }
}
$('#btn-settings').onclick = openSettings;

// Richer chat info (replaces the basic info popup).
$('#btn-chat-info').onclick = async () => {
  const chat = getChat(activeChatId);
  if (!chat) return;
  const body = openModal(chat.type === 'group' ? 'Group info' : 'Contact info', '', true);
  const other = chat.type === 'direct' ? chat.members.find(m => m.id !== me.id) : null;
  const prefs = chat.prefs;
  let html = '';
  if (chat.type === 'group') {
    html += `<div class="profile-head">${avatarHtml({ display_name: chat.name, avatar: null }, true)}
      <div class="who"><div style="font-weight:700">${esc(chat.name)}</div><div style="color:var(--muted);font-size:.85rem">${chat.members.length} members</div></div></div>
      <input id="info-rename" type="text" value="${esc(chat.name)}" maxlength="40" placeholder="Group name">
      <button id="info-save-name" class="btn-primary">Save group name</button>`;
  } else if (other) {
    const blocked = blockedIds.has(other.id);
    html += `<div class="profile-head">${avatarHtml(other, true)}
      <div class="who"><div style="font-weight:700">${esc(other.display_name)}</div>
      <div style="color:var(--muted);font-size:.85rem">@${esc(other.username)}</div>
      <div style="color:var(--muted);font-size:.85rem">${esc(other.about || '')}</div>
      <div style="color:var(--muted);font-size:.85rem">${fmtLastSeen(other.last_seen, isOnline(other.id))}</div></div></div>
      <div style="display:flex;gap:8px">
        <button id="info-call-voice" class="btn-ghost" style="flex:1">📞 Voice call</button>
        <button id="info-call-video" class="btn-ghost" style="flex:1">📹 Video call</button>
      </div>
      <button id="info-block" class="btn-danger">${blocked ? 'Unblock this person' : 'Block this person'}</button>`;
  }
  html += '<div id="info-toggles"></div>';
  if (chat.type === 'group') {
    html += '<h3 style="font-size:.95rem">Members</h3><div id="info-members"></div><div id="add-member-wrap"></div>';
    html += '<button id="leave-group" class="btn-danger">Leave group</button>';
  }
  body.innerHTML = html;
  const toggles = body.querySelector('#info-toggles');
  toggles.appendChild(switchRow(prefs.muted ? 'Muted' : 'Mute notifications', '', prefs.muted, v => setChatPref(chat.id, { muted: v })));
  toggles.appendChild(switchRow(prefs.pinned ? 'Pinned' : 'Pin chat', '', prefs.pinned, v => setChatPref(chat.id, { pinned: v })));
  toggles.appendChild(switchRow(prefs.archived ? 'Archived' : 'Archive chat', '', prefs.archived, v => setChatPref(chat.id, { archived: v })));
  if (other) {
    body.querySelector('#info-call-voice').onclick = () => { closeModal(); startCall(other, 'audio'); };
    body.querySelector('#info-call-video').onclick = () => { closeModal(); startCall(other, 'video'); };
    body.querySelector('#info-block').onclick = async () => {
      const blocked = blockedIds.has(other.id);
      if (blocked) {
        await api.del(`/api/blocks/${other.id}`);
        toast('Unblocked');
      } else {
        if (!confirm(`Block ${other.display_name}? They won't be able to message you.`)) return;
        await api.post('/api/blocks', { user_id: other.id });
        toast('Blocked');
      }
      await refreshBlocks();
      await refreshDirectory();
      closeModal();
      await refreshChats();
    };
  }
  if (chat.type === 'group') {
    body.querySelector('#info-save-name').onclick = async () => {
      const name = body.querySelector('#info-rename').value.trim();
      if (!name) return;
      try {
        const { chat: updated } = await api.put(`/api/chats/${chat.id}`, { name });
        Object.assign(chat, updated);
        updateChatHeader(); renderChatList(); toast('Group renamed');
      } catch (err) { toast(err.message); }
    };
    const membersEl = body.querySelector('#info-members');
    for (const m of chat.members) {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `${avatarHtml(m)}<div class="who"><div>${esc(m.display_name)}</div><div class="uname">@${esc(m.username)}${m.id === me.id ? ' (you)' : ''}</div></div>${m.id !== me.id ? '<button class="btn-ghost">Remove</button>' : ''}`;
      const rm = row.querySelector('button');
      if (rm) rm.onclick = async () => {
        try {
          await api.del(`/api/chats/${chat.id}/members/${m.id}`);
          closeModal(); await refreshChats(); openChat(chat.id);
        } catch (err) { toast(err.message); }
      };
      membersEl.appendChild(row);
    }
    body.querySelector('#leave-group').onclick = async () => {
      if (!confirm('Leave this group?')) return;
      await api.del(`/api/chats/${chat.id}/members/${me.id}`);
      closeModal(); $('#btn-back').click(); await refreshChats();
    };
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

// ---------------------------------------------------------------------------
// Voice & video calls (WebRTC peer-to-peer, signaled over the /ws socket)
// ---------------------------------------------------------------------------
const CALL_STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let call = null; // { pc, stream, peer, kind, state, timer, startAt, muted, cameraOff }

function callSend(payload) {
  if (socketAlive) socket.send(JSON.stringify(payload));
}
function setCallStatus(text) { $('#call-status').textContent = text; }
function showCallOverlay(peer, kind) {
  $('#call-overlay').classList.remove('hidden');
  $('#call-name').textContent = peer.display_name;
  setAvatarBtn($('#call-avatar'), peer, true);
  $('#call-avatar').style.background = peer.avatar ? '' : avatarColor(peer.display_name);
  $('#local-video').classList.toggle('hidden', kind !== 'video');
  $('#remote-video').classList.toggle('hidden', kind !== 'video');
  $('#btn-call-accept').classList.add('hidden');
  $('#btn-call-decline').classList.add('hidden');
  $('#btn-call-end').classList.remove('hidden');
  $('#call-timer').classList.add('hidden');
}
function hideCallOverlay() {
  $('#call-overlay').classList.add('hidden');
  $('#remote-video').srcObject = null;
  $('#remote-audio').srcObject = null;
  $('#local-video').srcObject = null;
}
function startCallTimer() {
  call.startAt = Date.now();
  $('#call-timer').classList.remove('hidden');
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.startAt) / 1000);
    $('#call-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function cleanupCall() {
  if (!call) return;
  clearInterval(call.timer);
  try { call.pc.close(); } catch { /* noop */ }
  if (call.stream) call.stream.getTracks().forEach(t => t.stop());
  call = null;
  hideCallOverlay();
  resetCallButtons();
}
function resetCallButtons() {
  $('#btn-call-mute').textContent = '🎤';
  $('#btn-call-camera').textContent = '📹';
}
async function makePeerConnection(peer, kind) {
  const pc = new RTCPeerConnection(CALL_STUN);
  pc.onicecandidate = e => {
    if (e.candidate) callSend({ type: 'call:ice', to: peer.id, candidate: e.candidate });
  };
  pc.ontrack = e => {
    const stream = e.streams[0];
    if (kind === 'video') $('#remote-video').srcObject = stream;
    else $('#remote-audio').srcObject = stream;
  };
  pc.onconnectionstatechange = () => {
    if (!call) return;
    if (pc.connectionState === 'connected') { setCallStatus('Connected'); startCallTimer(); }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setCallStatus('Connection lost…');
  };
  return pc;
}

async function startCall(peer, kind) {
  if (call) { alert('You are already on a call.'); return; }
  if (!socketAlive) { alert('Calls need a live connection — please try again in a moment.'); return; }
  if (!onlineIds.has(peer.id)) {
    if (!confirm(`${peer.display_name} appears offline. Call anyway? They will see it when they come online.`)) return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: true } : { audio: true });
  } catch {
    alert('Camera/microphone is not available. Check browser permissions and try again.');
    return;
  }
  call = { peer, kind, state: 'calling', stream, pc: null, timer: null, muted: false, cameraOff: false };
  showCallOverlay(peer, kind);
  setCallStatus(kind === 'video' ? 'Video calling…' : 'Calling…');
  $('#local-video').srcObject = stream;
  const pc = await makePeerConnection(peer, kind);
  call.pc = pc;
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    callSend({ type: 'call:offer', to: peer.id, kind, offer });
  } catch {
    alert('Could not start the call.');
    endCall();
  }
}

async function handleCallSignal(data) {
  if (data.type === 'call:offer') {
    if (call) { callSend({ type: 'call:busy', to: data.from }); return; }
    const peer = { id: data.from, display_name: data.from_name || 'Someone', avatar: null };
    const known = directory.find(u => u.id === data.from) || contacts.find(u => u.id === data.from);
    if (known) { peer.display_name = known.display_name; peer.avatar = known.avatar; }
    call = { peer, kind: data.kind || 'audio', state: 'incoming', stream: null, pc: null, timer: null, offer: data.offer, muted: false, cameraOff: false };
    showCallOverlay(peer, call.kind);
    setCallStatus(data.kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…');
    $('#btn-call-accept').classList.remove('hidden');
    $('#btn-call-decline').classList.remove('hidden');
    $('#btn-call-end').classList.add('hidden');
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    return;
  }
  if (!call) return;
  if (data.type === 'call:answer' && call.pc) {
    await call.pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(() => {});
    setCallStatus('Connecting…');
  } else if (data.type === 'call:ice' && call.pc && data.candidate) {
    await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
  } else if (data.type === 'call:decline') {
    setCallStatus('Declined');
    setTimeout(cleanupCall, 1200);
  } else if (data.type === 'call:busy') {
    setCallStatus('Busy — on another call');
    setTimeout(cleanupCall, 1500);
  } else if (data.type === 'call:end') {
    setCallStatus('Call ended');
    setTimeout(cleanupCall, 800);
  }
}

async function acceptCall() {
  if (!call || call.state !== 'incoming') return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(call.kind === 'video' ? { audio: true, video: true } : { audio: true });
  } catch {
    alert('Camera/microphone is not available. Check browser permissions and try again.');
    declineCall();
    return;
  }
  call.stream = stream;
  call.state = 'active';
  $('#local-video').srcObject = stream;
  $('#btn-call-accept').classList.add('hidden');
  $('#btn-call-decline').classList.add('hidden');
  $('#btn-call-end').classList.remove('hidden');
  setCallStatus('Connecting…');
  const pc = await makePeerConnection(call.peer, call.kind);
  call.pc = pc;
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  await pc.setRemoteDescription(new RTCSessionDescription(call.offer)).catch(() => {});
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  callSend({ type: 'call:answer', to: call.peer.id, answer });
}
function declineCall() {
  if (!call) return;
  const peerId = call.peer.id;
  const wasIncoming = call.state === 'incoming';
  cleanupCall();
  if (wasIncoming) callSend({ type: 'call:decline', to: peerId });
}
function endCall() {
  if (!call) return;
  const peerId = call.peer.id;
  cleanupCall();
  callSend({ type: 'call:end', to: peerId });
}
$('#btn-call-accept').onclick = acceptCall;
$('#btn-call-decline').onclick = declineCall;
$('#btn-call-end').onclick = endCall;
$('#btn-call-mute').onclick = () => {
  if (!call || !call.stream) return;
  call.muted = !call.muted;
  call.stream.getAudioTracks().forEach(t => { t.enabled = !call.muted; });
  $('#btn-call-mute').textContent = call.muted ? '🔇' : '🎤';
};
$('#btn-call-camera').onclick = () => {
  if (!call || !call.stream) return;
  call.cameraOff = !call.cameraOff;
  call.stream.getVideoTracks().forEach(t => { t.enabled = !call.cameraOff; });
  $('#btn-call-camera').textContent = call.cameraOff ? '🚫' : '📹';
};

boot();
