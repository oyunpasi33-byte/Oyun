// server/index.js
// Uygulamanın giriş noktası: Express statik dosya sunucusu + Socket.io sunucusu.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GameManager } = require('./gameManager');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // Geliştirme kolaylığı için açık; production'da kısıtlayabilirsin.
});

// client/ klasörünü statik olarak sun (index.html, css, js)
app.use(express.static(path.join(__dirname, '..', 'client')));

const gameManager = new GameManager(io);

// Basit sağlık kontrolü endpoint'i (deploy platformları için faydalı)
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

io.on('connection', (socket) => {
  let currentRoomCode = null;

  socket.on('createRoom', ({ playerName } = {}) => {
    const room = gameManager.createRoom();
    const result = room.addPlayer(socket.id, playerName);
    if (result.error) {
      socket.emit('roomError', { message: result.error });
      return;
    }
    currentRoomCode = room.code;
    socket.join(room.code);
    socket.emit('roomCreated', { roomCode: room.code, playerId: socket.id });
    room.broadcastLobby();
  });

  socket.on('joinRoom', ({ roomCode, playerName } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) {
      socket.emit('roomError', { message: 'ODA_BULUNAMADI' });
      return;
    }
    if (room.status !== 'lobby') {
      socket.emit('roomError', { message: 'OYUN_BASLADI' });
      return;
    }
    const result = room.addPlayer(socket.id, playerName);
    if (result.error) {
      socket.emit('roomError', { message: result.error });
      return;
    }
    currentRoomCode = room.code;
    socket.join(room.code);
    socket.emit('roomJoined', { roomCode: room.code, playerId: socket.id });
    room.broadcastLobby();
  });

  socket.on('playerReady', ({ roomCode, ready } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.setReady(socket.id, ready !== false);
  });

  socket.on('placeSettlement', ({ roomCode, regionId } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.placeSettlement(socket.id, regionId);
  });

  socket.on('requestQuestion', ({ roomCode } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.requestQuestion(socket.id);
  });

  socket.on('answerQuestion', ({ roomCode, questionId, answerIndex } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.handleAnswer(socket.id, questionId, answerIndex);
  });

  socket.on('triggerSabotage', ({ roomCode } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.triggerSabotage(socket.id);
  });

  socket.on('triggerRaid', ({ roomCode } = {}) => {
    const room = gameManager.getRoom(roomCode);
    if (!room) return;
    room.triggerRaid(socket.id);
  });

  socket.on('leaveRoom', () => {
    handleLeave();
  });

  socket.on('disconnect', () => {
    handleLeave();
  });

  function handleLeave() {
    if (!currentRoomCode) return;
    const room = gameManager.getRoom(currentRoomCode);
    if (room) {
      const leavingPlayer = room.players[socket.id];
      room.removePlayer(socket.id);
      if (leavingPlayer) {
        io.to(room.code).emit('opponentLeft', { name: leavingPlayer.name });
        room.addLog(`🚪 ${leavingPlayer.name} oyundan ayrıldı.`, 'system');
      }
      if (room.status === 'playing' && room.order.length < 2) {
        room.endGame('opponent_left', room.order[0] || null);
      } else if (room.status === 'placing') {
        room.backToLobby();
      } else {
        room.broadcastLobby();
      }
      gameManager.removeRoomIfEmpty(room.code);
    }
    currentRoomCode = null;
  }
});

server.listen(PORT, () => {
  console.log(`Kale Yarışması sunucusu http://localhost:${PORT} adresinde çalışıyor`);
});
