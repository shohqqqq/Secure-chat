const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Xabar hajmini cheklaymiz — himoya uchun (ovozli xabarlar uchun biroz kattaroq)
  maxHttpBufferSize: 6e6
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Xonalar faqat RAM'da saqlanadi. Server qayta ishga tushsa yoki
 * xona bo'shab qolsa (ikkala foydalanuvchi ham chiqsa) — butunlay o'chadi.
 * Hech qanday xabar matni serverda saqlanmaydi, faqat shifrlangan holda
 * bir foydalanuvchidan ikkinchisiga uzatiladi (relay).
 *
 * rooms: Map<roomName, { authHash: string, members: Set<socketId> }>
 */
const rooms = new Map();

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
      // Xona hali mavjud emas — shu foydalanuvchi uni yaratadi va parolni belgilaydi
      r = { authHash, members: new Set() };
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
      io.to(roomName).emit('system', { text: 'Suhbatdosh xonaga kirdi. Endi ikkalangiz ham ulangansiz.' });
    } else {
      socket.emit('system', { text: 'Xonaga muvaffaqiyatli kirdingiz. Suhbatdosh kutilmoqda...' });
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
  });

  socket.on('typing', (isTyping) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    socket.to(roomName).emit('typing', !!isTyping);
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;

    r.members.delete(socket.id);
    socket.to(roomName).emit('system', { text: 'Suhbatdosh xonadan chiqib ketdi.' });
    cleanupRoomIfEmpty(roomName);
  });
});

server.listen(PORT, () => {
  console.log(`Secure duo chat server ${PORT}-portda ishlamoqda`);
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, authHash }) => {
    if (typeof room !== 'string' || typeof authHash !== 'string' || !room.trim() || !authHash.trim()) {
      socket.emit('join-error', { reason: 'invalid', message: 'Xona nomi yoki parol noto\'g\'ri formatda.' });
      return;
    }

    const roomName = room.trim();
    let r = rooms.get(roomName);

    if (!r) {
      // Xona hali mavjud emas — shu foydalanuvchi uni yaratadi va parolni belgilaydi
      r = { authHash, members: new Set() };
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
      io.to(roomName).emit('system', { text: 'Suhbatdosh xonaga kirdi. Endi ikkalangiz ham ulangansiz.' });
    } else {
      socket.emit('system', { text: 'Xonaga muvaffaqiyatli kirdingiz. Suhbatdosh kutilmoqda...' });
    }
  });

  // Shifrlangan xabarni faqat relay qilamiz — server matnni hech qachon ko'rmaydi
  socket.on('encrypted-message', ({ iv, data }) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r || !r.members.has(socket.id)) return;

    socket.to(roomName).emit('encrypted-message', {
      iv,
      data,
      ts: Date.now()
    });
  });

  socket.on('typing', (isTyping) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    socket.to(roomName).emit('typing', !!isTyping);
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;

    r.members.delete(socket.id);
    socket.to(roomName).emit('system', { text: 'Suhbatdosh xonadan chiqib ketdi.' });
    cleanupRoomIfEmpty(roomName);
  });
});

server.listen(PORT, () => {
  console.log(`Secure duo chat server ${PORT}-portda ishlamoqda`);
});
