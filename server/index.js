// WorldChat MK-II — server/index.js
// Features: Turnstile, canvas botcheck, vote-kick, hourly re-verify,
// rename cooldown, msg cooldown, mod/owner system, accounts,
// paste restriction, strong link filter

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT || 3000;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const OWNER_PASSWORD   = process.env.OWNER_PASSWORD   || 'changeme';
const OWNER_HANDLE     = 'KalelTonatiuh';

const MAX_MSG_LEN        = 400;
const MAX_HANDLE         = 24;
const HISTORY_SIZE       = 80;
const RATE_WINDOW_MS     = 5000;
const RATE_LIMIT         = 5;
const MSG_COOLDOWN_MS    = 1500;
const RENAME_COOLDOWN_MS = 30000;
const MUTE_DURATION_MS   = 60 * 60 * 1000;
const VOTE_THRESHOLD     = 3;
const REVERIFY_EVERY_MS  = 60 * 60 * 1000;
const REVERIFY_GRACE_MS  = 2  * 60 * 1000;

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');

// ── In-memory state ───────────────────────────────────────────────────────────
const history  = [];
const accounts = new Map();   // lcHandle → { handle, pwHash, role }
const mods     = new Set();   // lcHandle strings
const bans     = new Set();   // fingerprint strings
const muteList = new Map();   // lcHandle → unmuteAt timestamp
const voteKick = new Map();   // lcHandle → Set<voterLcHandle>

// ── History persistence ───────────────────────────────────────────────────────
function loadHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (Array.isArray(saved)) {
      saved.slice(-HISTORY_SIZE).forEach(m => history.push(m));
      console.log(`Loaded ${history.length} messages from history file.`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not load history:', e.message);
  }
}

let _saveTimer = null;
function saveHistory() {
  // Debounce — write at most once per 2s
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8');
    } catch (e) {
      console.warn('Could not save history:', e.message);
    }
  }, 2000);
}

loadHistory();

// ── Pure helpers ──────────────────────────────────────────────────────────────
function simpleHash(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function sanitize(str, max) {
  return String(str || '')
    .replace(/[<>&"'`]/g, c =>
      ({'<':'&lt;','&':'&amp;','"':'&quot;',"'":'&#39;','`':'&#96;'}[c]))
    .trim()
    .slice(0, max || 9999);
}

function sanitizeHandle(h) {
  return String(h || '').replace(/[^a-zA-Z0-9_\-\.]/g, '').trim().slice(0, MAX_HANDLE);
}

function pushHistory(msg) {
  history.push(msg);
  if (history.length > HISTORY_SIZE) history.shift();
  saveHistory();
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, exclude) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(s);
  });
}

function broadcastOnline() {
  const users = [];
  let n = 0;
  wss.clients.forEach(c => {
    if (c._verified) {
      n++;
      users.push({ handle: sanitize(c._handle), flag: c._flag, role: getRole(c) });
    }
  });
  const s = JSON.stringify({ type: 'online', count: n, users });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

function systemMsg(text) {
  const msg = { type: 'system', text: sanitize(text), ts: Date.now() };
  pushHistory(msg);
  broadcast(msg);
}

function isMuted(handle) {
  const key = handle.toLowerCase();
  const exp = muteList.get(key);
  if (!exp) return false;
  if (Date.now() >= exp) { muteList.delete(key); return false; }
  return true;
}

function fingerprint(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  return simpleHash(ip + '|' + ua);
}

function getRole(ws) {
  const lc = (ws._handle || '').toLowerCase();
  if (lc === OWNER_HANDLE.toLowerCase() && ws._isOwner) return 'owner';
  if (mods.has(lc)) return 'mod';
  const acc = accounts.get(lc);
  return acc ? (acc.role || 'user') : 'guest';
}

function newChallenge() {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  return { a, b, answer: a + b, question: `${a} + ${b}` };
}

// ── Strong link detection ─────────────────────────────────────────────────────
const LOOKALIKES = {
  '\u0430':'a','\u0435':'e','\u043e':'o','\u0440':'p','\u0441':'c',
  '\u0445':'x','\u0456':'i','\u0458':'j','\u04cf':'l','\u0455':'s',
  '\u0443':'y','\u04bb':'h','\u0432':'b','\u03b1':'a','\u03b5':'e',
  '\u03bf':'o','\u03c1':'p','\u03c5':'u','\u03bd':'v','\u03b9':'i',
};
const TLDS = 'com|net|org|io|co|info|biz|app|dev|me|tv|cc|xyz|gg|ai|ly|to|sh|' +
             'online|site|website|tech|club|store|live|chat|link|page|uk|ru|cn|' +
             'de|fr|es|it|jp|br|au|ca|us|eu|nl|se|no|dk|fi|pl|ua|tr|in|id|ph';

function normLookalikes(s) {
  return s.split('').map(c => LOOKALIKES[c] || c).join('');
}

function containsLink(text) {
  const norm      = normLookalikes(text);
  const collapsed = norm.replace(/[\s\/\\]+/g, '');

  if (/https?:?\/?\/?/i.test(collapsed))  return true;
  if (/ftp:?\/?\/?/i.test(collapsed))     return true;
  if (/www\./i.test(collapsed))           return true;
  if (/data:[^;]+;base64,/i.test(norm))   return true;

  // Possible base64-encoded URL
  const b64m = norm.match(/[A-Za-z0-9+/]{40,}={0,2}/);
  if (b64m) {
    try {
      const dec = Buffer.from(b64m[0], 'base64').toString();
      if (/https?:\/\//i.test(dec)) return true;
    } catch(_) {}
  }

  // domain.tld with spaces/slash obfuscation collapsed
  const tldRe = new RegExp(`[a-z0-9][a-z0-9\\-]{1,}[.]\\s*(${TLDS})([/?#\\s]|$)`, 'i');
  const dotNorm = norm
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\.\//g, '.')
    .replace(/\/\./g, '.')
    .replace(/\s+/g, '');

  if (tldRe.test(dotNorm))   return true;
  if (tldRe.test(collapsed)) return true;

  // IP addresses
  if (/\d{1,3}[\s.]*\.[\s.]*\d{1,3}[\s.]*\.[\s.]*\d{1,3}[\s.]*\.[\s.]*\d{1,3}/.test(norm)) return true;

  return false;
}

// ── Turnstile ─────────────────────────────────────────────────────────────────
function verifyTurnstile(token, remoteIp) {
  return new Promise(resolve => {
    if (!TURNSTILE_SECRET) { resolve(true); return; }
    const body = JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: remoteIp });
    const req = https.request({
      hostname: 'challenges.cloudflare.com',
      path:     '/turnstile/v0/siteverify',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).success === true); } catch(_) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html', '.js':'text/javascript',
  '.css':'text/css',   '.png':'image/png', '.ico':'image/x-icon'
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ ok:true, clients: wss.clients.size }));
  }
  const filePath = path.join(__dirname, '..', 'public',
    req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const fp = fingerprint(req);
  if (bans.has(fp)) { ws.close(4003, 'banned'); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket.remoteAddress || '';

  Object.assign(ws, {
    _fp: fp, _ip: ip,
    _handle: 'anon', _flag: '🌍',
    _verified: false, _isOwner: false,
    _account: null, _isRegistered: false,
    _challenge: null, _turnstileOk: false,
    _pendingHandle: null, _pendingFlag: null,
    _msgTimes: [], _lastMsgAt: 0, _lastRenameAt: 0,
    _reverifyTimer: null, _reverifyGrace: null, _awaitingReverify: false,
    _profile: { pronouns: '', bio: '' },
  });

  send(ws, { type: 'online', count: wss.clients.size });

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (!data || typeof data.type !== 'string') return;
    const now = Date.now();

    // ── turnstile ─────────────────────────────────────────────────────────
    if (data.type === 'turnstile') {
      if (ws._turnstileOk) return;
      const ok = await verifyTurnstile(String(data.token || ''), ip);
      if (!ok) { send(ws, { type:'error', text:'Turnstile failed. Please refresh.' }); ws.close(); return; }
      ws._turnstileOk = true;
      if (ws._pendingHandle) {
        ws._challenge = newChallenge();
        send(ws, { type:'challenge', question: ws._challenge.question });
      }
      return;
    }

    // ── join ──────────────────────────────────────────────────────────────
    if (data.type === 'join') {
      if (ws._verified) return;
      ws._pendingHandle = sanitizeHandle(data.handle) || 'anon';
      ws._pendingFlag   = String(data.flag || '🌍');
      if (!ws._turnstileOk) {
        send(ws, { type:'awaiting_turnstile' }); return;
      }
      ws._challenge = newChallenge();
      send(ws, { type:'challenge', question: ws._challenge.question });
      return;
    }

    // ── botcheck ──────────────────────────────────────────────────────────
    if (data.type === 'botcheck') {
      const ans = parseInt(data.answer, 10);

      // Re-verify path
      if (ws._verified && ws._awaitingReverify) {
        if (!ws._challenge || ans !== ws._challenge.answer) {
          send(ws, { type:'error', text:'Re-verification failed.' }); ws.close(); return;
        }
        clearTimeout(ws._reverifyGrace);
        ws._awaitingReverify = false;
        ws._challenge = null;
        send(ws, { type:'reverified' });
        scheduleReverify(ws);
        return;
      }

      // Initial path
      if (ws._verified) return;
      if (!ws._turnstileOk) { send(ws, { type:'error', text:'Complete Turnstile first.' }); return; }
      if (!ws._challenge || ans !== ws._challenge.answer) {
        send(ws, { type:'error', text:'Wrong answer. Refresh and try again.' }); ws.close(); return;
      }
      ws._challenge = null;

      if (bans.has(fp)) { ws.close(4003, 'banned'); return; }
      ws._handle   = ws._pendingHandle || 'anon';
      ws._flag     = ws._pendingFlag   || '🌍';
      ws._verified = true;

      send(ws, { type:'verified' });
      send(ws, { type:'history', messages: history });
      broadcastOnline();
      systemMsg(`${ws._handle} ${ws._flag} joined the channel`);
      scheduleReverify(ws);
      return;
    }

    // ── requires verification ─────────────────────────────────────────────
    if (!ws._verified) { send(ws, { type:'error', text:'Complete verification first.' }); return; }
    if (ws._awaitingReverify) { send(ws, { type:'error', text:'Solve the re-verification challenge first.' }); return; }

    // ── register ──────────────────────────────────────────────────────────
    if (data.type === 'register') {
      const h  = sanitizeHandle(data.handle);
      const pw = String(data.password || '').trim();
      if (!h || pw.length < 4) { send(ws, { type:'reg_err', text:'Handle required; password ≥ 4 chars.' }); return; }
      const key = h.toLowerCase();
      if (accounts.has(key)) { send(ws, { type:'reg_err', text:'Handle already registered.' }); return; }
      accounts.set(key, { handle: h, pwHash: simpleHash(pw), role: 'user' });
      ws._account = key; ws._isRegistered = true;
      send(ws, { type:'registered', handle: h });
      return;
    }

    // ── login ─────────────────────────────────────────────────────────────
    if (data.type === 'login') {
      const h   = sanitizeHandle(data.handle);
      const pw  = String(data.password || '').trim();
      const key = h.toLowerCase();
      const acc = accounts.get(key);
      if (!acc || acc.pwHash !== simpleHash(pw)) { send(ws, { type:'login_err', text:'Invalid credentials.' }); return; }
      if (key === OWNER_HANDLE.toLowerCase()) ws._isOwner = true;
      ws._account = key; ws._isRegistered = true;
      send(ws, { type:'loggedin', handle: acc.handle, role: getRole(ws) });
      return;
    }

    // ── rename ────────────────────────────────────────────────────────────
    if (data.type === 'rename') {
      if (now - ws._lastRenameAt < RENAME_COOLDOWN_MS) {
        const wait = Math.ceil((RENAME_COOLDOWN_MS - (now - ws._lastRenameAt)) / 1000);
        send(ws, { type:'error', text:`Wait ${wait}s before renaming.` }); return;
      }
      const newH = sanitizeHandle(data.handle);
      const newF = String(data.flag || ws._flag);
      if (!newH) { send(ws, { type:'error', text:'Invalid handle.' }); return; }
      if (newH === ws._handle && newF === ws._flag) return;
      const old = ws._handle;
      ws._handle = newH; ws._flag = newF; ws._lastRenameAt = now;
      send(ws, { type:'renamed', handle: newH, flag: newF });
      systemMsg(`${old} is now known as ${newH} ${newF}`);
      return;
    }

    // ── msg ───────────────────────────────────────────────────────────────
    if (data.type === 'msg') {
      if (isMuted(ws._handle)) {
        send(ws, { type:'muted', text:'You have been muted for 1 hour.' }); return;
      }
      if (now - ws._lastMsgAt < MSG_COOLDOWN_MS) {
        send(ws, { type:'error', text:'Slow down.' }); return;
      }
      ws._msgTimes = ws._msgTimes.filter(t => now - t < RATE_WINDOW_MS);
      if (ws._msgTimes.length >= RATE_LIMIT) {
        send(ws, { type:'error', text:'Too many messages — slow down.' }); return;
      }
      const text = sanitize(data.text, MAX_MSG_LEN);
      if (!text) return;
      if (containsLink(text)) {
        send(ws, { type:'error', text:'⚠ Links are not allowed in this channel.' }); return;
      }
      // Accept optional lang tag (2-3 lowercase letters, client-detected)
      const lang = (typeof data.lang === 'string' && /^[a-z]{2,3}$/.test(data.lang))
        ? data.lang.toUpperCase()
        : null;
      ws._msgTimes.push(now); ws._lastMsgAt = now;
      const msg = {
        type: 'msg', handle: sanitize(ws._handle), flag: ws._flag,
        text, lang, ts: now, id: simpleHash(ws._handle + now + text)
      };
      pushHistory(msg);
      const s = JSON.stringify(msg);
      wss.clients.forEach(c => {
        if (c.readyState !== WebSocket.OPEN) return;
        c === ws ? send(c, { ...msg, own: true }) : c.send(s);
      });
      return;
    }

    // ── vote-kick ─────────────────────────────────────────────────────────
    if (data.type === 'votekick') {
      const target = String(data.target || '').toLowerCase();
      if (!target || target === ws._handle.toLowerCase()) return;
      if (!voteKick.has(target)) voteKick.set(target, new Set());
      const votes = voteKick.get(target);
      votes.add(ws._handle.toLowerCase());
      broadcast({ type:'system', text:`Vote to mute ${target}: ${votes.size}/${VOTE_THRESHOLD}`, ts: now });
      if (votes.size >= VOTE_THRESHOLD) {
        muteList.set(target, now + MUTE_DURATION_MS);
        voteKick.delete(target);
        wss.clients.forEach(c => {
          if (c._verified && c._handle.toLowerCase() === target)
            send(c, { type:'muted', text:'You have been muted for 1 hour by community vote.' });
        });
        systemMsg(`${target} has been muted for 1 hour by community vote.`);
      }
      return;
    }

    // ── mod / owner ───────────────────────────────────────────────────────
    const role    = getRole(ws);
    const isMod   = role === 'mod' || role === 'owner';
    const isOwner = role === 'owner';

    // Returns true if the target handle is protected from the acting role
    function isProtected(targetLc) {
      if (targetLc === OWNER_HANDLE.toLowerCase()) return true;   // owner is untouchable
      if (!isOwner && mods.has(targetLc)) return true;            // mods can't act on other mods
      return false;
    }

    if (data.type === 'kick') {
      if (!isMod) { send(ws, { type:'error', text:'No permission.' }); return; }
      const t = String(data.target || '').toLowerCase();
      if (isProtected(t)) { send(ws, { type:'error', text:'You cannot mute that user.' }); return; }
      muteList.set(t, now + MUTE_DURATION_MS);
      wss.clients.forEach(c => {
        if (c._verified && c._handle.toLowerCase() === t)
          send(c, { type:'muted', text:'You have been muted by a moderator for 1 hour.' });
      });
      systemMsg(`${t} was muted by ${ws._handle}.`);
      return;
    }

    if (data.type === 'unmute') {
      if (!isMod) { send(ws, { type:'error', text:'No permission.' }); return; }
      const t = String(data.target || '').toLowerCase();
      if (isProtected(t)) { send(ws, { type:'error', text:'You cannot unmute that user.' }); return; }
      muteList.delete(t);
      systemMsg(`${t} was unmuted by ${ws._handle}.`);
      send(ws, { type:'system', text:`✓ ${t} unmuted.`, ts: now });
      return;
    }

    if (data.type === 'ban') {
      if (!isOwner) { send(ws, { type:'error', text:'No permission.' }); return; }
      const t = String(data.target || '').toLowerCase();
      wss.clients.forEach(c => {
        if (c._verified && c._handle.toLowerCase() === t) {
          bans.add(c._fp);
          send(c, { type:'error', text:'You have been permanently banned.' });
          c.close(4003, 'banned');
        }
      });
      systemMsg(`${t} was banned by ${ws._handle}.`);
      return;
    }

    if (data.type === 'promote') {
      if (!isOwner) { send(ws, { type:'error', text:'No permission.' }); return; }
      const t = String(data.target || '').toLowerCase();
      mods.add(t);
      systemMsg(`${t} was promoted to moderator by ${ws._handle}.`);
      return;
    }

    if (data.type === 'demote') {
      if (!isOwner) { send(ws, { type:'error', text:'No permission.' }); return; }
      const t = String(data.target || '').toLowerCase();
      mods.delete(t);
      systemMsg(`${t} was demoted by ${ws._handle}.`);
      return;
    }

    // ── typing ────────────────────────────────────────────────────────────
    if (data.type === 'typing') {
      // Broadcast to all other verified clients — no rate limiting needed,
      // client already debounces to once per 2s.
      broadcast({ type: 'typing', handle: ws._handle, flag: ws._flag }, ws);
      return;
    }

    // ── profile_update ────────────────────────────────────────────────────
    if (data.type === 'profile_update') {
      const pronouns = sanitize(String(data.pronouns || ''), 30);
      const bio      = sanitize(String(data.bio      || ''), 160);
      // Store on the socket so latecomers can request it via profile_data
      ws._profile = { pronouns, bio };
      // Strip avatar before rebroadcast — clients cache avatars locally only
      broadcast({
        type:     'profile_update',
        handle:   ws._handle,
        flag:     ws._flag,
        pronouns,
        bio,
      }, ws);
      return;
    }

    if (data.type === 'clearhistory') {
      if (!isOwner) { send(ws, { type:'error', text:'No permission.' }); return; }
      history.length = 0;
      // Write empty array immediately — don't debounce
      try {
        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        fs.writeFileSync(HISTORY_FILE, '[]', 'utf8');
      } catch(e) { console.warn('Could not clear history file:', e.message); }
      broadcast({ type:'clearhistory' });
      return;
    }
  });

  ws.on('close', () => {
    clearTimeout(ws._reverifyTimer);
    clearTimeout(ws._reverifyGrace);
    if (ws._verified && ws._handle !== 'anon')
      systemMsg(`${ws._handle} left the channel`);
    broadcastOnline();
  });

  ws.on('error', () => {});
});

// ── Hourly re-verify ──────────────────────────────────────────────────────────
function scheduleReverify(ws) {
  clearTimeout(ws._reverifyTimer);
  ws._reverifyTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws._challenge = newChallenge();
    ws._awaitingReverify = true;
    send(ws, { type:'reverify', question: ws._challenge.question });
    ws._reverifyGrace = setTimeout(() => {
      if (ws._awaitingReverify) { send(ws, { type:'error', text:'Re-verification timed out.' }); ws.close(); }
    }, REVERIFY_GRACE_MS);
  }, REVERIFY_EVERY_MS);
}

// ── Seed owner account ────────────────────────────────────────────────────────
accounts.set(OWNER_HANDLE.toLowerCase(), {
  handle:  OWNER_HANDLE,
  pwHash:  simpleHash(OWNER_PASSWORD),
  role:    'owner'
});

server.listen(PORT, () => console.log(`WorldChat MK-II on port ${PORT}`));
