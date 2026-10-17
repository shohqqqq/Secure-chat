// Secure Line v2: akkauntlar (parol), N a'zoli xonalar, E2E relay, AI proxy.
// Env: ANTHROPIC_API_KEY, TOKEN_SECRET (uzun tasodifiy matn), PORT
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '1mb' }));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 9e6 });

// ---- Oddiy fayl-baza (Render bepul tarifida qayta ishga tushsa o'chib ketadi!) ----
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
let db = { secret: crypto.randomBytes(32).toString('hex'), users: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error(e.message); } };
const SECRET = process.env.TOKEN_SECRET || db.secret;

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sign = (u) => {
  const p = u + '.' + (Date.now() + 30 * 864e5);
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('hex');
};
const verify = (t) => {
  if (typeof t !== 'string') return null;
  const [u, exp, sig] = t.split('.');
  if (!u || !exp || !sig) return null;
  const good = crypto.createHmac('sha256', SECRET).update(u + '.' + exp).digest('hex');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Date.now() > +exp) return null;
  return db.users[u] ? u : null;
};
const authReq = (req) => verify((req.headers.authorization || '').replace('Bearer ', ''));

// Login urinishlarini cheklash (IP bo'yicha, 1 daqiqada 10 ta)
const tries = new Map();
const limited = (ip) => {
  const now = Date.now();
  const a = (tries.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); tries.set(ip, a);
  return a.length > 10;
};

app.get('/api/health', (req, res) => res.send('ok'));

app.post('/api/register', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Ko'p urinish, 1 daqiqa kuting" });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: "Ism: 3-20 ta kichik lotin harf, raqam yoki _" });
  if (typeof password !== 'string' || password.length < 6)
    return res.status(400).json({ error: "Parol kamida 6 belgi bo'lsin" });
  if (db.users[username]) return res.status(409).json({ error: 'Bu ism band' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[username] = { salt, hash: hashPw(password, salt), created: Date.now() };
  save();
  res.json({ token: sign(username), username });
});

app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Ko'p urinish, 1 daqiqa kuting" });
  const { username, password } = req.body || {};
  const u = typeof username === 'string' ? db.users[username] : null;
  if (!u || typeof password !== 'string') return res.status(401).json({ error: "Ism yoki parol noto'g'ri" });
  const h = hashPw(password, u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash)))
    return res.status(401).json({ error: "Ism yoki parol noto'g'ri" });
  res.json({ token: sign(username), username });
});

app.get('/api/user/:name', (req, res) => {
  if (!authReq(req)) return res.status(401).json({ error: 'auth' });
  res.json({ exists: !!db.users[req.params.name] });
});

// ---- AI proxy ----
const hits = new Map();
app.post('/api/ai', async (req, res) => {
  const user = authReq(req);
  if (!user) return res.status(401).json({ error: 'Qayta kiring' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'AI sozlanmagan' });
  const now = Date.now();
  const arr = (hits.get(user) || []).filter(t => now - t < 60000);
  if (arr.length >= 20) return res.status(429).json({ error: "Juda ko'p so'rov" });
  arr.push(now); hits.set(user, arr);

  const msgs = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
  if (!msgs.length || msgs.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string'))
    return res.status(400).json({ error: "Noto'g'ri so'rov" });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 1000,
        system: "Qisqa va aniq javob ber. Foydalanuvchi qaysi tilda yozsa, shu tilda javob ber.",
        messages: msgs
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'AI xatosi' });
    res.json({ text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n') });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Chat (faqat tokenli foydalanuvchilar) ----
const rooms = new Map();
const HISTORY_LIMIT = 500;
const EXPIRY = 7 * 24 * 3600 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [n, r] of rooms) if (r.members.size === 0 && now - r.lastActivity > EXPIRY) rooms.delete(n);
}, 3600 * 1000);

io.use((socket, next) => {
  const u = verify(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('auth'));
  socket.data.user = u;
  next();
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, authHash, max } = {}) => {
    if (![room, authHash].every(v => typeof v === 'string' && v.trim()))
      return socket.emit('join-error', { message: "Ma'lumot noto'g'ri." });
    const user = socket.data.user;

    // Do'st xonasiga faqat ikkala do'stning o'zi kira oladi
    if (room.startsWith('dm:')) {
      const p = room.slice(3).split('&');
      if (p.length !== 2 || !p.includes(user)) return socket.emit('join-error', { message: 'Ruxsat yo\'q.' });
    }

    let r = rooms.get(room);
    if (!r) {
      r = { authHash, max: Math.min(Math.max(parseInt(max) || 2, 2), 50), members: new Map(), history: [], lastActivity: Date.now() };
      rooms.set(room, r);
    }
    if (r.authHash !== authHash) return socket.emit('join-error', { message: "Parol noto'g'ri." });
    if (r.members.size >= r.max) return socket.emit('join-error', { message: "Xona to'lgan." });

    r.members.set(socket.id, user);
    r.lastActivity = Date.now();
    socket.join(room);
    socket.data.room = room;
    socket.emit('joined', { peers: r.members.size });
    socket.emit('chat-history', { messages: r.history });
    socket.to(room).emit('members', { peers: r.members.size });
  });

  socket.on('encrypted-message', (p) => {
    const room = socket.data.room, r = rooms.get(room);
    if (!r || !r.members.has(socket.id)) return;
    if (!p || typeof p.iv !== 'string' || typeof p.data !== 'string') return;
    const stored = { ...p, senderName: r.members.get(socket.id), ts: Date.now() };
    socket.to(room).emit('encrypted-message', stored);
    r.history.push(stored);
    if (r.history.length > HISTORY_LIMIT) r.history.splice(0, r.history.length - HISTORY_LIMIT);
    r.lastActivity = Date.now();
  });

  socket.on('disconnect', () => {
    const room = socket.data.room, r = rooms.get(room);
    if (!r) return;
    r.members.delete(socket.id);
    r.lastActivity = Date.now();
    io.to(room).emit('members', { peers: r.members.size });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Secure Line server :' + PORT));
