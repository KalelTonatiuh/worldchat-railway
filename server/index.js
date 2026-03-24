const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MSG_LEN = 400;
const MAX_HANDLE = 24;
const HISTORY_SIZE = 80;
const RATE_WINDOW = 5000;
const RATE_LIMIT = 5;

const history = [];
function pushHistory(msg) {
  history.push(msg);
  if (history.length > HISTORY_SIZE) history.shift();
}

// ── Link / URL filtering ────────────────────────────────────────────────────
// Catches: http/https/ftp URLs, base64 data URIs, common TLD patterns,
// IP addresses, and obfuscated variants with spaces/dots/brackets
const LINK_PATTERNS = [
  /https?:\/\/\S+/gi,
  /ftp:\/\/\S+/gi,
  /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi,           // base64 data URIs
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|app|dev|co|uk|me|info|biz|xyz|gg|tv|live|chat|link|site|online|web|club|store|shop|page|app)\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/\S*)?\b/g, // IP addresses
  /\b(?:www|http|https|ftp)\s*[\[({]?\s*[.:]\s*[\])}]?\s*\S+/gi, // obfuscated
];

function containsLink(text) {
  return LINK_PATTERNS.some(p => { p.lastIndex = 0; return p.test(text); });
}

// ── Sanitize ────────────────────────────────────────────────────────────────
function sanitize(str, maxLen) {
  return String(str || '')
    .replace(/[<>&"'`]/g, c =>
      ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;', '`':'&#96;' }[c])
    )
    .trim()
    .slice(0, maxLen);
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: wss.clients.size, msgs: history.length }));
  }
  let filePath = path.join(__dirname, '..', 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function broadcast(data, exclude) {
  const str = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(str);
  });
}

function broadcastOnlineCount() {
  const str = JSON.stringify({ type: 'online', count: wss.clients.size });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  ws._handle = 'anon';
  ws._flag = '🌍';
  ws._msgTimes = [];
  ws._verified = false; // bot-check gate

  send(ws, { type: 'history', messages: history });
  send(ws, { type: 'online', count: wss.clients.size });
  broadcastOnlineCount();

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    const now = Date.now();

    // ── Bot check response ────────────────────────────────────────────────
    if (data.type === 'botcheck') {
      // Client sends { type: 'botcheck', answer: N }
      // Server sent a challenge in the 'history' packet; we verify here.
      // The challenge is stored on ws._challenge (set below when joining).
      if (ws._challenge !== undefined && Number(data.answer) === ws._challenge) {
        ws._verified = true;
        send(ws, { type: 'verified' });
      } else {
        send(ws, { type: 'error', text: '⚠ Bot check failed. Refresh to try again.' });
        ws.close();
      }
      return;
    }

    // ── Rate limit ────────────────────────────────────────────────────────
    ws._msgTimes = ws._msgTimes.filter(t => now - t < RATE_WINDOW);
    if (ws._msgTimes.length >= RATE_LIMIT) {
      send(ws, { type: 'error', text: 'Slow down — too many messages.' });
      return;
    }
    ws._msgTimes.push(now);

    // ── Join ──────────────────────────────────────────────────────────────
    if (data.type === 'join') {
      const handle = sanitize(data.handle, MAX_HANDLE) || 'anon';
      const flag = data.flag || '🌍';

      // Generate bot-check challenge (simple arithmetic)
      const a = Math.floor(Math.random() * 9) + 1;
      const b = Math.floor(Math.random() * 9) + 1;
      ws._challenge = a + b;
      ws._pendingHandle = handle;
      ws._pendingFlag = flag;

      send(ws, { type: 'challenge', question: `${a} + ${b}` });
      return;
    }

    // ── Handle change (re-join with new callsign) ─────────────────────────
    if (data.type === 'rename') {
      if (!ws._verified) { send(ws, { type: 'error', text: 'Complete bot check first.' }); return; }
      const oldHandle = ws._handle;
      ws._handle = sanitize(data.handle, MAX_HANDLE) || ws._handle;
      ws._flag = data.flag || ws._flag;
      const msg = {
        type: 'system',
        text: `${oldHandle} is now known as ${ws._handle} ${ws._flag}`,
        ts: now
      };
      pushHistory(msg);
      broadcast(msg);
      // Also tell the renaming client their new identity is confirmed
      send(ws, { type: 'renamed', handle: ws._handle, flag: ws._flag });
      return;
    }

    // ── Chat message ──────────────────────────────────────────────────────
    if (data.type === 'msg') {
      if (!ws._verified) { send(ws, { type: 'error', text: '⚠ Complete bot check first.' }); return; }
      const text = sanitize(data.text, MAX_MSG_LEN);
      if (!text) return;

      if (containsLink(text)) {
        send(ws, { type: 'error', text: '⚠ Links are not allowed in this channel.' });
        return;
      }

      const msg = {
        type: 'msg',
        handle: ws._handle,
        flag: ws._flag,
        text,
        ts: now,
        id: Math.random().toString(36).slice(2)
      };
      pushHistory(msg);
      broadcast(msg, ws);
      send(ws, { ...msg, own: true });
      return;
    }
  });

  ws.on('close', () => {
    if (ws._handle !== 'anon' && ws._verified) {
      const msg = { type: 'system', text: `${ws._handle} left the channel`, ts: Date.now() };
      pushHistory(msg);
      broadcast(msg);
    }
    broadcastOnlineCount();
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`WorldChat MK-II running on port ${PORT}`));
