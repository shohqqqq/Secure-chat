const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Xabar hajmini cheklaymiz — himoya uchun (ovozli xabar va rasm uchun kattaroq)
  maxHttpBufferSize: 9e6
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Frontend uchun ochiq (maxfiy bo'lmagan) sozlama — faqat bot username, token emas.
app.get('/api/config', (req, res) => {
  res.json({ telegramBotUsername: TELEGRAM_BOT_USERNAME });
});

/**
 * Xonalar faqat RAM'da saqlanadi. Server qayta ishga tushsa yoki
 * xona bo'shab qolsa (ikkala foydalanuvchi ham chiqsa) — butunlay o'chadi.
 * Hech qanday xabar matni serverda saqlanmaydi, faqat shifrlangan holda
 * bir foydalanuvchidan ikkinchisiga uzatiladi (relay).
 *
 * rooms: Map<roomName, {
 *   authHash: string,
 *   members: Set<socketId>,
 *   creatorId: string,          // xonani birinchi yaratgan socket
 *   creatorChatId: string|null, // yaratuvchining shaxsiy Telegram chat_id (ixtiyoriy)
 *   lastNotifiedAt: number      // Telegram spam bo'lmasligi uchun cooldown
 * }>
 */
const rooms = new Map();

// Telegram bildirishnomasi (ixtiyoriy). Sayt bitta umumiy botga ega (TELEGRAM_BOT_TOKEN),
// lekin har bir xona yaratuvchisi o'zining shaxsiy chat_id'ini kiritadi — shu sabab
// bildirishnoma faqat o'sha odamga boradi, boshqa xonalarga aralashmaydi.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || null;
const NOTIFY_COOLDOWN_MS = 60 * 1000; // xona uchun 1 daqiqada max 1 marta

async function notifyCreatorViaTelegram(roomName, chatId){
  if(!TELEGRAM_BOT_TOKEN || !chatId) return;
  try{
    const text = `🔔 Secure Line: "${roomName}" xonasida yangi xabar bor. Matn shifrlangani uchun bu yerda ko'rsatilmaydi — saytga kirib ko'ring.`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  }catch(err){
    console.error('Telegram bildirishnoma yuborilmadi:', err.message);
  }
}

// Foydalanuvchi o'z chat_id'ini bilishi uchun: botga /start yozsa,
// bot shu odamning chat_id'ini avtomatik qaytarib beradi (qo'lda qidirish shart emas).
async function startTelegramSelfServiceBot(){
  if(!TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  const apiBase = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

  while(true){
    try{
      const res = await fetch(`${apiBase}/getUpdates?timeout=25&offset=${offset}`);
      const json = await res.json();
      if(json.ok && Array.isArray(json.result)){
        for(const update of json.result){
          offset = update.update_id + 1;
          const msg = update.message;
          if(msg && msg.chat && typeof msg.text === 'string'){
            const chatId = msg.chat.id;
            const reply = `👋 Sizning chat ID'ingiz: ${chatId}\n\nBuni "Secure Line" saytida xona yaratganda "Telegram Chat ID" maydoniga kiriting — shunda suhbatdoshingiz yozganda sizga shu yerga bildirishnoma keladi.`;
            fetch(`${apiBase}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: reply })
            }).catch(() => {});
          }
        }
      }
    }catch(err){
      console.error('Telegram polling xatosi:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

startTelegramSelfServiceBot();

function roomInfo(roomName) {
  return rooms.get(roomName);
}

function cleanupRoomIfEmpty(roomName) {
  const room = rooms.get(roomName);
  if (room && room.members.size === 0) {
    rooms.delete(roomName);
  }
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, authHash, notifyChatId }) => {
    if (typeof room !== 'string' || typeof authHash !== 'string' || !room.trim() || !authHash.trim()) {
      socket.emit('join-error', { reason: 'invalid', message: 'Xona nomi yoki parol noto\'g\'ri formatda.' });
      return;
    }

    const roomName = room.trim();
    let r = rooms.get(roomName);

    if (!r) {
      // Xona hali mavjud emas — shu foydalanuvchi uni yaratadi, u "creator" bo'ladi.
      // Agar u o'zining Telegram chat_id'ini kiritgan bo'lsa, shu yerga saqlanadi.
      const cleanChatId = (typeof notifyChatId === 'string' && notifyChatId.trim()) ? notifyChatId.trim() : null;
      r = { authHash, members: new Set(), creatorId: socket.id, creatorChatId: cleanChatId, lastNotifiedAt: 0 };
      rooms.set(roomName, r);
    }

    if (r.authHash !== authHash) {
      socket.emit('join-error', { reason: 'wrong-password', message: 'Parol noto\'g\'ri.' });
      return;
    }

    if (r.members.size >= 2) {
      socket.emit('join-error', { reason: 'full', message: 'Bu xona allaqachon 2 kishi bilan to\'lgan.' });
      return;
    }

    // Muvaffaqiyatli kirish
    r.members.add(socket.id);
    socket.join(roomName);
    socket.data.room = roomName;

    socket.emit('joined', { room: roomName, peers: r.members.size });

    if (r.members.size === 2) {
      io.to(roomName).emit('system', { key: 'both-connected' });
    } else {
      socket.emit('system', { key: 'waiting' });
    }
  });

  // Shifrlangan xabarni (matn yoki ovozli) faqat relay qilamiz —
  // server hech qachon asl mazmunni ko'rmaydi, faqat shifrlangan bloklarni uzatadi.
  socket.on('encrypted-message', (payload) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r || !r.members.has(socket.id)) return;
    if (!payload || typeof payload.iv !== 'string' || typeof payload.data !== 'string') return;

    socket.to(roomName).emit('encrypted-message', {
      ...payload,
      ts: Date.now()
    });

    // Faqat "yaratuvchi bo'lmagan" tomon yozganda, "yaratuvchi"ga bildirishnoma boradi
    // (agar u o'zining Telegram chat_id'ini bergan bo'lsa). Yaratuvchi yozganda hech
    // kimga bildirishnoma yuborilmaydi, va boshqa xonalarga bu umuman aralashmaydi.
    if (socket.id !== r.creatorId && r.creatorChatId) {
      const now = Date.now();
      if (now - r.lastNotifiedAt > NOTIFY_COOLDOWN_MS) {
        r.lastNotifiedAt = now;
        notifyCreatorViaTelegram(roomName, r.creatorChatId);
      }
    }
  });

  socket.on('typing', (isTyping) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    socket.to(roomName).emit('typing', !!isTyping);
  });

  // "O'qildi" belgisi: qabul qiluvchi xabarni ochgach, shu signalni jo'natuvchiga qaytaradi.
  // Server bu yerda ham faqat ID'ni relay qiladi, xabar matnini bilmaydi.
  socket.on('message-read', ({ id } = {}) => {
    const roomName = socket.data.room;
    if (!roomName || typeof id !== 'string') return;
    const r = rooms.get(roomName);
    if (!r || !r.members.has(socket.id)) return;
    socket.to(roomName).emit('message-read', { id });
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;

    r.members.delete(socket.id);
    socket.to(roomName).emit('system', { key: 'partner-left' });
    cleanupRoomIfEmpty(roomName);
  });
});

server.listen(PORT, () => {
  console.log(`Secure duo chat server ${PORT}-portda ishlamoqda`);
});
