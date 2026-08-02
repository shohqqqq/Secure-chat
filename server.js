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

/**
 * Xonalar faqat RAM'da saqlanadi. Server qayta ishga tushsa yoki
 * xona bo'shab qolsa (ikkala foydalanuvchi ham chiqsa) — butunlay o'chadi.
 * Hech qanday xabar matni serverda saqlanmaydi, faqat shifrlangan holda
 * bir foydalanuvchidan ikkinchisiga uzatiladi (relay).
 *
 * rooms: Map<roomName, {
 *   authHash: string,
 *   members: Set<socketId>,
 *   creatorId: string,        // xonani birinchi yaratgan socket
 *   lastNotifiedAt: number    // Telegram spam bo'lmasligi uchun cooldown
 * }>
 */
const rooms = new Map();

// Telegram bildirishnomasi (ixtiyoriy). Render'da Environment bo'limida
// TELEGRAM_BOT_TOKEN va TELEGRAM_CHAT_ID o'zgaruvchilarini qo'shsangiz ishlaydi.
// Agar sozlanmagan bo'lsa, bu funksiya jim o'tkazib yuboradi — hech narsa buzilmaydi.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NOTIFY_COOLDOWN_MS = 60 * 1000; // xona uchun 1 daqiqada max 1 marta

async function notifyCreatorViaTelegram(roomName){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try{
    const text = `🔔 Secure Line: "${roomName}" xonasida yangi xabar bor. Matn shifrlangani uchun bu yerda ko'rsatilmaydi — saytga kirib ko'ring.`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
  }catch(err){
    console.error('Telegram bildirishnoma yuborilmadi:', err.message);
  }
}

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
  socket.on('join-room', ({ room, authHash }) => {
    if (typeof room !== 'string' || typeof authHash !== 'string' || !room.trim() || !authHash.trim()) {
      socket.emit('join-error', { reason: 'invalid', message: 'Xona nomi yoki parol noto\'g\'ri formatda.' });
      return;
    }

    const roomName = room.trim();
    let r = rooms.get(roomName);

    if (!r) {
      // Xona hali mavjud emas — shu foydalanuvchi uni yaratadi, u "creator" bo'ladi
      r = { authHash, members: new Set(), creatorId: socket.id, lastNotifiedAt: 0 };
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

    // Faqat "yaratuvchi bo'lmagan" tomon yozganda, "yaratuvchi"ga bildirishnoma boradi.
    // Yaratuvchi yozganda hech kimga bildirishnoma yuborilmaydi.
    if (socket.id !== r.creatorId) {
      const now = Date.now();
      if (now - r.lastNotifiedAt > NOTIFY_COOLDOWN_MS) {
        r.lastNotifiedAt = now;
        notifyCreatorViaTelegram(roomName);
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
