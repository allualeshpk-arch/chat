const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(helmet());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

// In-memory queues keyed by interest (simple demo). For scaling, replace with Redis lists.
const waitingQueues = new Map(); // Map<string, Array<socket.id>>

// Map socket.id -> chat metadata
const socketsMeta = new Map(); // { partner: socket.id | null, room: roomId, anonId: string, lastMsgAt: number }

// Basic profanity list (demo)
const profanity = ['damn', 'fuck', 'shit', 'bitch']; // expand or integrate external moderation API

// Rate limit: minimum ms between messages per socket
const MIN_MESSAGE_INTERVAL_MS = 300;

// Utility: remove socket from waitingQueues
function removeFromQueues(socketId) {
  for (const [k, arr] of waitingQueues.entries()) {
    const idx = arr.indexOf(socketId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      if (arr.length === 0) waitingQueues.delete(k);
    }
  }
}

io.on('connection', (socket) => {
  const anonId = `Stranger#${Math.floor(1000 + Math.random() * 9000)}`;
  socketsMeta.set(socket.id, { partner: null, room: null, anonId, lastMsgAt: 0 });

  socket.emit('welcome', { anonId });

  // user requests to find a partner; interest is a single string (empty -> any)
  socket.on('find', ({ interest = '' } = {}) => {
    interest = (interest || '').trim().toLowerCase();
    if (interest.length > 64) interest = interest.slice(0, 64);

    // Try to find a waiting partner in the same interest first
    let partnerId = null;
    const tryQueue = (key) => {
      const arr = waitingQueues.get(key);
      if (arr && arr.length > 0) {
        partnerId = arr.shift();
        if (arr.length === 0) waitingQueues.delete(key);
      }
    };

    tryQueue(interest);
    // If not found and interest isn't empty, also try the 'any' queue
    if (!partnerId && interest !== '') tryQueue('any');

    if (partnerId && io.sockets.sockets.get(partnerId)) {
      // found a partner — create room
      const room = uuidv4();
      socket.join(room);
      io.sockets.sockets.get(partnerId).join(room);

      socketsMeta.get(socket.id).partner = partnerId;
      socketsMeta.get(socket.id).room = room;
      socketsMeta.get(partnerId).partner = socket.id;
      socketsMeta.get(partnerId).room = room;

      const myAnon = socketsMeta.get(socket.id).anonId;
      const partnerAnon = socketsMeta.get(partnerId).anonId;

      // Notify both
      socket.emit('matched', { room, partnerAnon });
      io.to(partnerId).emit('matched', { room, partnerAnon: myAnon });
    } else {
      // No partner -> add to waiting queue for interest (or 'any')
      const key = interest === '' ? 'any' : interest;
      if (!waitingQueues.has(key)) waitingQueues.set(key, []);
      waitingQueues.get(key).push(socket.id);
      socket.emit('waiting', { interest: key });
    }
  });

  socket.on('message', ({ text } = {}) => {
    const meta = socketsMeta.get(socket.id);
    if (!meta || !meta.room || !meta.partner) return;

    const now = Date.now();
    if (now - meta.lastMsgAt < MIN_MESSAGE_INTERVAL_MS) {
      socket.emit('error_msg', { reason: 'You are sending messages too quickly.' });
      return;
    }
    meta.lastMsgAt = now;

    const cleaned = (text || '').slice(0, 2000);
    // naive profanity check
    const containsProfanity = profanity.some(p => cleaned.toLowerCase().includes(p));
    if (containsProfanity) {
      // For demo: still forward, but tag it. In production, handle per policy (block, warn, or send to moderation queue)
      io.to(meta.room).emit('message', { from: meta.anonId, text: cleaned, flagged: true });
    } else {
      io.to(meta.room).emit('message', { from: meta.anonId, text: cleaned });
    }
  });

  socket.on('typing', ({ isTyping } = {}) => {
    const meta = socketsMeta.get(socket.id);
    if (meta && meta.room) {
      socket.to(meta.room).emit('typing', { from: meta.anonId, isTyping: !!isTyping });
    }
  });

  // user ends the chat voluntarily
  socket.on('leave', () => {
    const meta = socketsMeta.get(socket.id);
    if (meta && meta.partner) {
      const partnerSocket = io.sockets.sockets.get(meta.partner);
      if (partnerSocket) {
        partnerSocket.emit('partner_left', { reason: 'other_left' });
        socketsMeta.get(meta.partner).partner = null;
        socketsMeta.get(meta.partner).room = null;
      }
      // leave room
      socket.leave(meta.room);
      socketsMeta.get(socket.id).partner = null;
      socketsMeta.get(socket.id).room = null;
      socket.emit('left');
    } else {
      // if in queue, remove
      removeFromQueues(socket.id);
      socket.emit('left');
    }
  });

  // Report a partner — logs it server-side for now
  socket.on('report', ({ targetAnon, reason } = {}) => {
    // Log reports in console / DB in real app
    console.log(`[REPORT] reporter=${socketsMeta.get(socket.id)?.anonId} target=${targetAnon} reason=${reason}`);
    socket.emit('reported', { ok: true });
  });

  socket.on('disconnect', () => {
    // If waiting, remove from queue
    removeFromQueues(socket.id);
    const meta = socketsMeta.get(socket.id);
    if (meta && meta.partner) {
      const partnerSocket = io.sockets.sockets.get(meta.partner);
      if (partnerSocket) {
        partnerSocket.emit('partner_left', { reason: 'disconnect' });
        socketsMeta.get(meta.partner).partner = null;
        socketsMeta.get(meta.partner).room = null;
      }
    }
    socketsMeta.delete(socket.id);
  });
});

// Simple health/readiness
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});