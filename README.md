# Chat — real-time messaging web app

A WhatsApp-style texting app that real people can use together: accounts,
one-to-one chats, group chats, photos, voice notes, read receipts, typing
indicators, and online presence. Everything is stored on your own server —
no third-party services, no API keys, no paid anything.

## Features

- **Accounts** — sign up with a username, display name, and password.
  Passwords are hashed with scrypt and never sent to the browser.
- **Contacts** — search for people by username or name, add them as contacts.
- **One-to-one and group chats** — create groups, add/remove members, leave a group.
- **Messages** — text, photos, and voice notes (recorded in the browser).
  Reply to a message, edit your own text messages, delete for everyone.
- **Read receipts** — ✓ sent, ✓✓ delivered, blue ✓✓ read.
- **Typing indicators** and **online / last seen** presence.
- **Chat list** sorted by most recent message, with unread counts.
- **Search** within a chat, and message timestamps with day dividers.
- **Profiles** — display name and avatar photo (initials if no photo).
- **Real time** over WebSocket, with automatic polling fallback if the
  socket drops, and reconnection.
- **Mobile-first** design that works well in a phone browser.

## Run it locally

Requirements: **Node.js 22.5 or newer** (uses the built-in `node:sqlite`
module — check with `node --version`). No database server, no Docker, no
build step.

```sh
cd chat-app
npm install
npm start
```

Then open http://localhost:3000 in your browser.

- The server listens on port `3000` by default. Change it with the `PORT`
  environment variable: `PORT=8080 npm start`.
- Data lives in a single SQLite file, `chat.db`, created automatically in
  the project folder, plus an `uploads/` folder for photos, voice notes,
  and avatars. Both are git-ignored.
- To use a different database file: `DB_PATH=/path/to/chat.db npm start`.

## Put it online

Anyone who can open the URL can sign up and message each other. Pick one:

### Option 1 — Render (free tier, easiest)

1. Push this folder to a GitHub repository.
2. In Render, create a **Web Service** from that repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variable: `PORT` is set automatically by Render — the app
     reads it, so nothing else is needed.
3. Open the URL Render gives you (e.g. `https://chat-xxxx.onrender.com`)
   and sign up.

Note: on Render's free tier the server sleeps when idle and its local disk
is ephemeral, so `chat.db` and uploads can be lost on redeploys/restarts.
For a permanent setup, attach a Render **Persistent Disk** mounted at the
project folder, or use Option 2.

### Option 2 — A VPS (e.g. Ubuntu server, permanent storage)

1. Install Node.js 22+ on the server (e.g. via
   [NodeSource](https://github.com/nodesource/distributions) or `nvm`).
2. Copy this folder to the server, e.g. `/opt/chat-app`.
3. Run:
   ```sh
   cd /opt/chat-app
   npm install
   PORT=3000 npm start
   ```
4. Keep it running after you log out with a process manager:
   ```sh
   npm install -g pm2
   pm2 start server.js --name chat-app
   pm2 save
   ```
5. Point your domain at the server (or use its IP) and, for HTTPS, put a
   reverse proxy in front of it (nginx/Caddy) and open port 3000 only to
   the proxy. Browsers require HTTPS for the microphone, so voice notes
   need HTTPS in production.

### Option 3 — Railway / Fly.io / similar

Same idea as Render: a Node.js web service, build `npm install`, start
`npm start`, with the platform-provided `PORT`. Attach a persistent volume
for the project folder if you want messages and uploads to survive
restarts.

## How other people join

1. Send them the URL of the deployed app.
2. They open it and **Sign up** with a username, display name, and password.
3. They search for your username (top-right **✚** → search), add you, and
   start chatting. Groups work the same way: **👥 New group**, pick
   contacts, name the group.

There is no admin account and no invitation system — anyone with the URL
can sign up. If you want the app private to a small circle, only share the
URL with those people.

## Project layout

```
chat-app/
  server.js        Express + WebSocket server, REST API, SQLite schema
  package.json     Dependencies: express, ws, multer (nothing else)
  public/
    index.html     App shell
    style.css      WhatsApp-inspired styling
    app.js         All frontend logic (auth, chats, realtime, voice notes)
  uploads/         User-uploaded photos, voice notes, avatars (created at runtime)
  chat.db          SQLite database (created at runtime)
```

## Notes & limits

- Messages are stored on your server and are visible to the people in
  each chat. They are **not end-to-end encrypted** (unlike WhatsApp) —
  the server operator can read the database. Do not use it for sensitive
  information unless you trust whoever hosts it.
- Voice notes need a browser with microphone permission; on a phone this
  means opening the app over HTTPS (or `localhost` while testing).
- Sessions last 30 days (cookie). Logging out deletes the session.
