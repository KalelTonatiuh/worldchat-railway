# WorldChat MK-II — Railway Edition

A skeuomorphic worldwide real-time chat. One Node.js server, zero dependencies beyond `ws`.
Deploy to Railway in under 3 minutes.

---

## 🚀 Deploy to Railway (3 minutes)

### Option A — Deploy via GitHub (recommended)

1. **Push this folder to a GitHub repo**
   ```bash
   git init
   git add .
   git commit -m "WorldChat MK-II"
   gh repo create worldchat --public --source=. --push
   ```

2. **Create a Railway project**
   - Go to [railway.com](https://railway.com) → **New Project**
   - Choose **Deploy from GitHub repo**
   - Select your `worldchat` repo
   - Railway auto-detects Node.js and deploys immediately

3. **Add a public domain**
   - In your Railway project → click your service → **Settings → Networking**
   - Click **Generate Domain**
   - That's your live URL — share it with the world

### Option B — Deploy via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
railway domain
```

---

## 📁 Project structure

```
worldchat-railway/
├── server/
│   └── index.js        ← Node.js WebSocket + HTTP server
├── public/
│   └── index.html      ← Frontend (served by the server)
├── package.json
├── railway.json        ← Railway build/deploy config
└── README.md
```

---

## 🔧 How it works

| Layer | Tech |
|---|---|
| Transport | Native WebSockets (`ws` library) |
| Frontend served by | Node.js `http` module (no Express needed) |
| Real-time | WebSocket broadcast to all connected clients |
| Message history | In-memory ring buffer (last 80 messages) |
| Presence | Live client count broadcast on connect/disconnect |
| Rate limiting | 5 messages per 5 seconds per client |
| Deploy | Railway (auto-detects Node, zero config) |

---

## 🔌 WebSocket message protocol

All messages are JSON over WebSocket.

**Client → Server:**
```json
{ "type": "join", "handle": "drifter_77", "flag": "🇲🇽" }
{ "type": "msg",  "text": "hello world" }
```

**Server → Client:**
```json
{ "type": "history",  "messages": [...] }
{ "type": "online",   "count": 12 }
{ "type": "msg",      "handle": "drifter_77", "flag": "🇲🇽", "text": "hello", "ts": 1234567890, "own": true }
{ "type": "system",   "text": "drifter_77 joined the channel", "ts": 1234567890 }
{ "type": "error",    "text": "Slow down — too many messages." }
```

---

## 🛠 Local development

```bash
npm install
npm run dev   # uses --watch for auto-reload
```

Open [http://localhost:3000](http://localhost:3000).

---

## 💡 Notes

- Messages are in-memory only — they reset if the server restarts (Railway free tier sleeps after inactivity). Add a PostgreSQL service on Railway if you want persistence.
- Railway's free tier gives you $5/month of credit — more than enough for a hobby chat server.
- WebSockets work out of the box on Railway — no special config needed.
