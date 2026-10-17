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

// Shaxsiy TURN server (metered.ca, oyiga 50GB gacha bepul) uchun sozlama.
// METERED_API_KEY va METERED_DOMAIN Render'ning Environment bo'limida saqlanadi —
// kalit hech qachon brauzerga to'g'ridan-to'g'ri berilmaydi, faqat shu endpoint orqali
// har safar yangi, vaqtinchalik TURN login ma'lumotlari so'raladi.
const METERED_API_KEY = process.env.METERED_API_KEY;
const METERED_DOMAIN = process.env.METERED_DOMAIN; // masalan: yourapp.metered.live

app.get('/api/turn-credentials', async (req, res) => {
  if (!METERED_API_KEY || !METERED_DOMAIN) {
    return res.json({ iceServers: null }); // sozlanmagan — frontend bepul TURN'ga qaytadi
  }
  try {
    const url = `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
    const r = await fetch(url);
    const iceServers = await r.json();
    res.json({ iceServers });
  } catch (err) {
    console.error('TURN kalitlarini olishda xatolik:', err.message);
    res.json({ iceServers: null });
  }
});

/**
 * Xonalar RAM'da saqlanadi (haqiqiy baza emas — server qayta ishga tushsa,
 * masalan uzoq vaqt ishlatilmay qolib Render uni "uxlatib qo'ysa" yoki yangi
 * kod joylashtirilsa — barcha tarix yo'qoladi).
 *
 * Endi xona ikkala kishi ham chiqib ketgandan so'ng DARHOL o'chirilmaydi —
 * shu bilan bir xil xona nomi + parolni qayta kiritsangiz, avvalgi
 * (shifrlangan) yozishmalar tiklanadi. Uzoq muddat ishlatilmagan xonalar
 * xotirani band qilib qolmasligi uchun 7 kundan keyin avtomatik tozalanadi.
 *
 * Har bir xonada faqat 2 ta "rol" bor: A va B (kim birinchi bo'lsa, o'sha
 * bo'sh rolni egallaydi). Bu shaxsni "eslab qolish" emas — shunchaki shu
 * seansda kim qaysi tomonda ekanini bilish uchun, xabarlarni "men"/"u"
 * qilib to'g'ri joylashtirish uchun ishlatiladi.
 *
 * rooms: Map<roomName, {
 *   authHash: string,
 *   roleASocketId: string|null,
 *   roleBSocketId: string|null,
 *   creatorChatId: string|null,   // "A" rolidagi odamning Telegram chat_id'i (ixtiyoriy)
 *   lastNotifiedAt: number,
 *   history: Array<object>,       // shifrlangan xabarlar arxivi (server ularni o'qiy olmaydi)
 *   lastActivity: number
 * }>
 */
const rooms = new Map();
const HISTORY_LIMIT = 500;
const ROOM_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 kun ishlatilmasa, xona o'chadi

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

function assignRole(r, socketId){
  if (!r.roleASocketId) { r.roleASocketId = socketId; return 'A'; }
  if (!r.roleBSocketId) { r.roleBSocketId = socketId; return 'B'; }
  return null; // xona to'lgan
}

function connectedCount(r){
  return (r.roleASocketId ? 1 : 0) + (r.roleBSocketId ? 1 : 0);
}

function freeRole(r, socketId){
  if (r.roleASocketId === socketId) r.roleASocketId = null;
  if (r.roleBSocketId === socketId) r.roleBSocketId = null;
}

// Uzoq vaqt (7 kun) ishlatilmagan, hozir bo'sh turgan xonalarni tozalab turadi —
// xotira cheksiz o'sib ketmasligi uchun.
setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms.entries()) {
    if (connectedCount(r) === 0 && now - r.lastActivity > ROOM_EXPIRY_MS) {
      rooms.delete(name);
    }
  }
}, 60 * 60 * 1000);

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, authHash, notifyChatId }) => {
    if (typeof room !== 'string' || typeof authHash !== 'string' || !room.trim() || !authHash.trim()) {
      socket.emit('join-error', { reason: 'invalid', message: 'Xona nomi yoki parol noto\'g\'ri formatda.' });
      return;
    }

    const roomName = room.trim();
    let r = rooms.get(roomName);

    if (!r) {
      // Xona hali mavjud emas — shu foydalanuvchi uni yaratadi.
      const cleanChatId = (typeof notifyChatId === 'string' && notifyChatId.trim()) ? notifyChatId.trim() : null;
      r = {
        authHash,
        roleASocketId: null,
        roleBSocketId: null,
        creatorChatId: cleanChatId,
        lastNotifiedAt: 0,
        history: [],
        lastActivity: Date.now()
      };
      rooms.set(roomName, r);
    }

    if (r.authHash !== authHash) {
      socket.emit('join-error', { reason: 'wrong-password', message: 'Parol noto\'g\'ri.' });
      return;
    }

    const role = assignRole(r, socket.id);
    if (!role) {
      socket.emit('join-error', { reason: 'full', message: 'Bu xona allaqachon 2 kishi bilan to\'lgan.' });
      return;
    }

    // "A" rolidagi odam har safar qayta ulanganda o'zining Telegram chat_id'ini
    // yangilashi mumkin (bo'sh qoldirsa, avvalgi qiymat saqlanib qoladi).
    if (role === 'A' && typeof notifyChatId === 'string' && notifyChatId.trim()) {
      r.creatorChatId = notifyChatId.trim();
    }

    socket.join(roomName);
    socket.data.room = roomName;
    socket.data.role = role;
    r.lastActivity = Date.now();

    const peers = connectedCount(r);
    socket.emit('joined', { room: roomName, peers, role });

    // Avvalgi (shifrlangan) yozishmalar bo'lsa, shu foydalanuvchiga qayta ko'rsatiladi —
    // server ularning mazmunini bilmaydi, faqat saqlab, qaytarib beradi.
    if (r.history.length > 0) {
      socket.emit('chat-history', { messages: r.history, myRole: role });
    }

    if (peers === 2) {
      io.to(roomName).emit('system', { key: 'both-connected' });
    } else {
      socket.emit('system', { key: 'waiting' });
    }
  });

  // Shifrlangan xabarni (matn yoki ovozli) faqat relay qilamiz —
  // server hech qachon asl mazmunni ko'rmaydi, faqat shifrlangan bloklarni uzatadi
  // va (endi) shu xona tarixiga qo'shib qo'yadi, keyinroq qayta ko'rish uchun.
  socket.on('encrypted-message', (payload) => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r || (r.roleASocketId !== socket.id && r.roleBSocketId !== socket.id)) return;
    if (!payload || typeof payload.iv !== 'string' || typeof payload.data !== 'string') return;

    const stored = { ...payload, senderRole: socket.data.role, ts: Date.now() };
    socket.to(roomName).emit('encrypted-message', stored);

    r.history.push(stored);
    if (r.history.length > HISTORY_LIMIT) {
      r.history.splice(0, r.history.length - HISTORY_LIMIT);
    }
    r.lastActivity = Date.now();

    // Faqat "A" bo'lmagan tomon ("B") yozganda, "A"ga bildirishnoma boradi
    // (agar u o'zining Telegram chat_id'ini bergan bo'lsa).
    if (socket.data.role === 'B' && r.creatorChatId) {
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
    if (!r || (r.roleASocketId !== socket.id && r.roleBSocketId !== socket.id)) return;
    socket.to(roomName).emit('message-read', { id });
  });

  // Ovozli qo'ng'iroq signalizatsiyasi (WebRTC). Server faqat "pochtachi" —
  // SDP/ICE ma'lumotlarini ikkinchi tomonga uzatadi, ovozning o'zi hech qachon
  // serverdan o'tmaydi (brauzerlar to'g'ridan-to'g'ri ulanadi).
  function relayToRoom(socket, event, payload){
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r || (r.roleASocketId !== socket.id && r.roleBSocketId !== socket.id)) return;
    socket.to(roomName).emit(event, payload);
  }
  socket.on('call-offer', (payload) => relayToRoom(socket, 'call-offer', payload));
  socket.on('call-answer', (payload) => relayToRoom(socket, 'call-answer', payload));
  socket.on('call-ice-candidate', (payload) => relayToRoom(socket, 'call-ice-candidate', payload));
  socket.on('call-end', (payload) => relayToRoom(socket, 'call-end', payload));
  socket.on('call-reject', (payload) => relayToRoom(socket, 'call-reject', payload));

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (!roomName) return;
    const r = rooms.get(roomName);
    if (!r) return;

    freeRole(r, socket.id);
    r.lastActivity = Date.now();
    socket.to(roomName).emit('system', { key: 'partner-left' });
    socket.to(roomName).emit('call-end', {});
    // Diqqat: xona bu yerda O'CHIRILMAYDI — tarix saqlanib qoladi, shu bilan
    // xona nomi + parolni qayta kiritganda avvalgi yozishmalar tiklanadi.
  });
});

server.listen(PORT, () => {
  console.log(`Secure duo chat server ${PORT}-portda ishlamoqda`);
});
