const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT    = process.env.PORT || 3000;
const MAX_MSG_LEN  = 400;
const MAX_HANDLE   = 24;
const HISTORY_SIZE = 80;   // messages kept in memory
const RATE_WINDOW  = 5000; // ms
const RATE_LIMIT   = 5;    // max messages per window per client

// ─── In-memory message history ────────────────────────────────────────────────
const history = [];

function pushHistory(msg) {
  history.push(msg);
  if (history.length > HISTORY_SIZE) history.shift();
}

// ─── HTTP server (serves the frontend + health check) ────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: wss.clients.size, msgs: history.length }));
  }

  // Serve static files from /public
  let filePath = path.join(__dirname, '..', 'public',
    req.url === '/' ? 'index.html' : req.url
  );

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(data, exclude) {
  const str = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  });
}

function broadcastOnlineCount() {
  const count = wss.clients.size;
  const str = JSON.stringify({ type: 'online', count });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  });
}

function sanitize(str, maxLen) {
  return String(str || '')
    .replace(/[<>&"'`]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]))
    .trim()
    .slice(0, maxLen);
}

wss.on('connection', (ws, req) => {
  ws._handle   = 'anon';
  ws._flag     = '🌍';
  ws._msgTimes = [];

  // Send history + current online count
  ws.send(JSON.stringify({ type: 'history', messages: history }));
  ws.send(JSON.stringify({ type: 'online', count: wss.clients.size }));
  broadcastOnlineCount();

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── Rate limit ──
    const now = Date.now();
    ws._msgTimes = ws._msgTimes.filter(t => now - t < RATE_WINDOW);
    if (ws._msgTimes.length >= RATE_LIMIT) {
      ws.send(JSON.stringify({ type: 'error', text: 'Slow down — too many messages.' }));
      return;
    }
    ws._msgTimes.push(now);

    if (data.type === 'join') {
      ws._handle = sanitize(data.handle, MAX_HANDLE) || 'anon';
      ws._flag   = data.flag || '🌍';

      const joinMsg = {
        type:   'system',
        text:   `${ws._handle} ${ws._flag} joined the channel`,
        ts:     now
      };
      pushHistory(joinMsg);
      broadcast(joinMsg);
      return;
    }

    if (data.type === 'msg') {
      const text = sanitize(data.text, MAX_MSG_LEN);
      if (!text) return;

      const msg = {
        type:   'msg',
        handle: ws._handle,
        flag:   ws._flag,
        text,
        ts:     now,
        id:     Math.random().toString(36).slice(2)
      };

      pushHistory(msg);
      broadcast(msg, ws);          // send to others
      ws.send(JSON.stringify({ ...msg, own: true })); // echo back to sender
      return;
    }
  });

  ws.on('close', () => {
    if (ws._handle !== 'anon') {
      const leaveMsg = {
        type: 'system',
        text: `${ws._handle} left the channel`,
        ts:   Date.now()
      };
      pushHistory(leaveMsg);
      broadcast(leaveMsg);
    }
    broadcastOnlineCount();
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`WorldChat MK-II running on port ${PORT}`);
});
