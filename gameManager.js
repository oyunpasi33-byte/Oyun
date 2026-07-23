// server/gameManager.js
// Odaların (room) yaşam döngüsünü, oyun durumunu, soru akışını,
// sabotaj ve akın (raid) mekaniklerini yöneten ana modül.

const { getRandomQuestion } = require('./questions');

// ---- Oyun ayarları (dengeyi buradan yönetebilirsin) ----
const GAME_DURATION_MS = 5 * 60 * 1000;   // Toplam oyun süresi: 5 dakika
const BASE_QUESTION_TIME_MS = 14000;      // Normal soru süresi
const SABOTAGE_TIME_REDUCTION_MS = 6000;  // Sabotaj sonrası süre kısaltma
const NEXT_VISITOR_DELAY_MS = 2200;       // Bir sonraki ziyaretçinin gelme gecikmesi
const RAID_SOLDIER_THRESHOLD = 8;         // Akın yapabilmek için gereken min. asker
const RAID_COOLDOWN_MS = 25000;           // Akın sonrası bekleme süresi
const RAID_SOLDIER_COST = 3;              // Akına çıkarken riske atılan asker sayısı
const STARTING_VILLAGERS = 20;
const STARTING_SOLDIERS = 4;
const STREAK_FOR_SABOTAGE = 3;            // Sabotaj hakkı için gereken art arda doğru sayısı

const VISITOR_TYPES = ['Köylü', 'Bilgin', 'Tüccar', 'Gizemli Yolcu', 'Yaşlı Bilge'];
const DEATH_FLAVORS = [
  'korkudan kalp krizi geçirdi',
  'yanlış cevaba dayanamayıp kaçarken düştü',
  'utancından köyü terk etti ve bir daha dönmedi',
  'ejderha gibi bağıran öfkeli bir keçi tarafından kovalandı',
  'yanlış cevabın verdiği şokla bayıldı, kalkamadı',
  'sabotaj oklarına hedef oldu',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = {};   // socketId -> playerState
    this.order = [];     // [socketId1, socketId2]
    this.status = 'lobby'; // lobby | playing | finished
    this.log = [];
    this.gameEndTimeout = null;
    this.endsAt = null;
    this.questionCounter = 0;
  }

  addPlayer(socketId, name) {
    if (this.order.length >= 2) return { error: 'ODA_DOLU' };
    this.players[socketId] = {
      id: socketId,
      name: name && name.trim() ? name.trim().slice(0, 18) : 'Oyuncu',
      villagers: STARTING_VILLAGERS,
      soldiers: STARTING_SOLDIERS,
      economy: 100,
      streak: 0,
      ready: false,
      alive: true,
      canSabotage: false,
      raidCooldownUntil: 0,
      currentQuestion: null,
      questionTimer: null,
      nextVisitorTimer: null,
      forcedDifficulty: null, // sabotaj ile zorlanan bir sonraki soru zorluğu
      timeReductionMs: 0,     // sabotaj ile kısalan süre
    };
    this.order.push(socketId);
    return { ok: true };
  }

  removePlayer(socketId) {
    const p = this.players[socketId];
    if (p) {
      clearTimeout(p.questionTimer);
      clearTimeout(p.nextVisitorTimer);
    }
    delete this.players[socketId];
    this.order = this.order.filter(id => id !== socketId);
  }

  get opponentIdOf() {
    return (socketId) => this.order.find(id => id !== socketId);
  }

  isFull() {
    return this.order.length === 2;
  }

  bothReady() {
    return this.order.length === 2 && this.order.every(id => this.players[id].ready);
  }

  addLog(message, type = 'info') {
    const entry = { message, type, ts: Date.now() };
    this.log.push(entry);
    if (this.log.length > 60) this.log.shift();
    this.io.to(this.code).emit('logEntry', entry);
  }

  publicPlayersState() {
    const out = {};
    for (const id of this.order) {
      const p = this.players[id];
      out[id] = {
        id: p.id,
        name: p.name,
        villagers: p.villagers,
        soldiers: p.soldiers,
        economy: p.economy,
        streak: p.streak,
        alive: p.alive,
        ready: p.ready,
        canSabotage: p.canSabotage,
        raidReady: p.soldiers >= RAID_SOLDIER_THRESHOLD && Date.now() >= p.raidCooldownUntil,
        raidCooldownRemainingMs: Math.max(0, p.raidCooldownUntil - Date.now()),
      };
    }
    return out;
  }

  broadcastState() {
    this.io.to(this.code).emit('gameStateUpdate', {
      status: this.status,
      players: this.publicPlayersState(),
      endsAt: this.endsAt,
    });
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobbyUpdate', {
      players: this.order.map(id => ({ id: this.players[id].id, name: this.players[id].name, ready: this.players[id].ready })),
      full: this.isFull(),
    });
  }

  setReady(socketId, ready) {
    if (!this.players[socketId]) return;
    this.players[socketId].ready = !!ready;
    this.broadcastLobby();
    if (this.bothReady() && this.status === 'lobby') {
      this.startGame();
    }
  }

  startGame() {
    this.status = 'playing';
    this.endsAt = Date.now() + GAME_DURATION_MS;
    this.addLog('⚔️ Oyun başladı! Ziyaretçiler yola çıktı...', 'system');
    this.io.to(this.code).emit('gameStarted', {
      players: this.publicPlayersState(),
      endsAt: this.endsAt,
      duration: GAME_DURATION_MS,
    });
    for (const id of this.order) {
      this.scheduleNextVisitor(id, 800);
    }
    this.gameEndTimeout = setTimeout(() => this.endGame('time'), GAME_DURATION_MS);
  }

  scheduleNextVisitor(socketId, delay = NEXT_VISITOR_DELAY_MS) {
    const p = this.players[socketId];
    if (!p || this.status !== 'playing' || !p.alive) return;
    clearTimeout(p.nextVisitorTimer);
    p.nextVisitorTimer = setTimeout(() => this.spawnQuestion(socketId), delay);
  }

  spawnQuestion(socketId) {
    const p = this.players[socketId];
    if (!p || this.status !== 'playing') return;

    let difficulty = p.forcedDifficulty || 'any';
    p.forcedDifficulty = null;

    const q = getRandomQuestion(difficulty);
    this.questionCounter += 1;
    const questionId = `q${this.questionCounter}`;
    let timeLimit = BASE_QUESTION_TIME_MS - (p.timeReductionMs || 0);
    timeLimit = Math.max(6000, timeLimit);
    p.timeReductionMs = 0;

    p.currentQuestion = {
      id: questionId,
      idx: q._idx,
      question: q.question,
      options: q.options,
      correct: q.correct,
      difficulty: q.difficulty,
      category: q.category,
      visitor: randomFrom(VISITOR_TYPES),
      startedAt: Date.now(),
      timeLimit,
    };

    this.io.to(socketId).emit('newQuestion', {
      id: questionId,
      question: q.question,
      options: q.options,
      difficulty: q.difficulty,
      category: q.category,
      visitor: p.currentQuestion.visitor,
      timeLimit,
    });

    // Rakibe düşman kapıya bir ziyaretçi geldiğine dair kısa bildirim
    const oppId = this.opponentIdOf(socketId);
    if (oppId) {
      this.io.to(oppId).emit('opponentVisitor', { visitor: p.currentQuestion.visitor });
    }

    clearTimeout(p.questionTimer);
    p.questionTimer = setTimeout(() => {
      // Süre doldu, cevapsız kalındı -> yanlış sayılır
      this.resolveAnswer(socketId, null);
    }, timeLimit + 300);
  }

  handleAnswer(socketId, questionId, answerIndex) {
    const p = this.players[socketId];
    if (!p || !p.currentQuestion || p.currentQuestion.id !== questionId) return;
    clearTimeout(p.questionTimer);
    this.resolveAnswer(socketId, answerIndex);
  }

  resolveAnswer(socketId, answerIndex) {
    const p = this.players[socketId];
    if (!p || !p.currentQuestion) return;
    const q = p.currentQuestion;
    p.currentQuestion = null;
    if (!p.alive) return;

    const isCorrect = answerIndex !== null && answerIndex === q.correct;
    const oppId = this.opponentIdOf(socketId);

    if (isCorrect) {
      p.streak += 1;
      const gain = q.difficulty === 'hard' ? 3 : q.difficulty === 'medium' ? 2 : 1;
      p.villagers += gain;
      p.economy += gain * 4;
      if (p.streak > 0 && p.streak % 4 === 0) {
        p.soldiers += 1; // uzun seri: yeni asker yetişir
        this.addLog(`🛡️ ${p.name}'in köyünde bir gönüllü asker oldu! (${p.streak} seri doğru)`, 'good');
      }
      if (p.streak >= STREAK_FOR_SABOTAGE) {
        p.canSabotage = true;
      }
      this.addLog(`✅ ${p.name}, ${q.visitor}'nin sorusunu doğru yanıtladı. Köy sevindi! (+${gain} köylü)`, 'good');
    } else {
      p.streak = 0;
      p.canSabotage = false;
      const killSoldierInstead = p.villagers <= 0 && p.soldiers > 0;
      if (killSoldierInstead) {
        p.soldiers = Math.max(0, p.soldiers - 1);
        this.addLog(`💀 ${p.name}'in köyünde köylü kalmadı! Bir asker ${randomFrom(DEATH_FLAVORS)}.`, 'bad');
      } else if (p.villagers > 0) {
        p.villagers -= 1;
        const reason = answerIndex === null ? 'süresi dolduğu için' : 'yanlış cevap verdiği için';
        this.addLog(`💀 ${p.name}'in köyünde bir köylü ${reason} ${randomFrom(DEATH_FLAVORS)}.`, 'bad');
      }
    }

    p.villagers = Math.max(0, p.villagers);
    p.soldiers = Math.max(0, p.soldiers);

    this.broadcastState();

    // Cevap veren oyuncuya doğru cevabı ve sonucu bildir
    this.io.to(socketId).emit('answerResult', {
      correct: isCorrect,
      correctIndex: q.correct,
      chosenIndex: answerIndex,
    });

    // Ölüm koşulu kontrolü
    if (p.villagers <= 0 && p.soldiers <= 0) {
      p.alive = false;
      this.addLog(`🏳️ ${p.name}'in köyü tamamen çöktü!`, 'system');
      this.endGame('elimination', oppId);
      return;
    }

    if (this.status === 'playing') {
      this.scheduleNextVisitor(socketId);
    }
  }

  triggerSabotage(socketId) {
    const p = this.players[socketId];
    if (!p || !p.canSabotage || this.status !== 'playing') return;
    const oppId = this.opponentIdOf(socketId);
    if (!oppId) return;
    const opp = this.players[oppId];

    p.canSabotage = false;
    p.streak = 0;
    opp.forcedDifficulty = 'hard';
    opp.timeReductionMs = SABOTAGE_TIME_REDUCTION_MS;

    this.addLog(`🗡️ ${p.name}, ${opp.name}'e sabotaj yaptı! Bir sonraki soru daha zor ve süresi kısa olacak.`, 'sabotage');
    this.io.to(oppId).emit('sabotaged', { by: p.name });
    this.broadcastState();
  }

  triggerRaid(socketId) {
    const p = this.players[socketId];
    if (!p || this.status !== 'playing') return;
    const oppId = this.opponentIdOf(socketId);
    if (!oppId) return;
    const opp = this.players[oppId];

    const now = Date.now();
    if (p.soldiers < RAID_SOLDIER_THRESHOLD) {
      this.io.to(socketId).emit('raidDenied', { reason: `Akın için en az ${RAID_SOLDIER_THRESHOLD} asker gerekli.` });
      return;
    }
    if (now < p.raidCooldownUntil) {
      this.io.to(socketId).emit('raidDenied', { reason: 'Akın hazır değil, biraz bekle.' });
      return;
    }

    p.raidCooldownUntil = now + RAID_COOLDOWN_MS;
    p.soldiers = Math.max(0, p.soldiers - RAID_SOLDIER_COST);

    // Başarı ihtimali: kendi askerin ile rakibin askeri arasındaki orana göre
    const successChance = Math.min(0.85, Math.max(0.35, p.soldiers / (p.soldiers + opp.soldiers + 1) + 0.15));
    const success = Math.random() < successChance;

    if (success) {
      const stolenVillagers = Math.min(opp.villagers, Math.floor(Math.random() * 3) + 2);
      const stolenSoldiers = Math.min(opp.soldiers, Math.random() < 0.4 ? 1 : 0);
      opp.villagers -= stolenVillagers;
      opp.soldiers -= stolenSoldiers;
      p.villagers += stolenVillagers;
      p.soldiers += stolenSoldiers;
      this.addLog(`⚔️ ${p.name} akın düzenledi ve ${opp.name}'den ${stolenVillagers} köylü${stolenSoldiers ? ` ile ${stolenSoldiers} asker` : ''} çaldı!`, 'raid');
      this.io.to(this.code).emit('raidResult', { attacker: p.name, defender: opp.name, success: true, stolenVillagers, stolenSoldiers });
    } else {
      const lostSoldiers = Math.min(p.soldiers, 1);
      p.soldiers -= lostSoldiers;
      this.addLog(`🛡️ ${opp.name}, ${p.name}'in akınını püskürttü! Saldırgan asker kaybetti.`, 'bad');
      this.io.to(this.code).emit('raidResult', { attacker: p.name, defender: opp.name, success: false, lostSoldiers });
    }

    if (opp.villagers <= 0 && opp.soldiers <= 0) {
      opp.alive = false;
      this.addLog(`🏳️ ${opp.name}'in köyü akın sonucu tamamen çöktü!`, 'system');
      this.broadcastState();
      this.endGame('elimination', socketId);
      return;
    }

    this.broadcastState();
  }

  endGame(reason, forcedWinnerId = null) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    clearTimeout(this.gameEndTimeout);
    for (const id of this.order) {
      clearTimeout(this.players[id].questionTimer);
      clearTimeout(this.players[id].nextVisitorTimer);
    }

    let winnerId = forcedWinnerId;
    if (!winnerId) {
      const [a, b] = this.order;
      const scoreA = this.players[a].villagers + this.players[a].soldiers * 2;
      const scoreB = this.players[b] ? this.players[b].villagers + this.players[b].soldiers * 2 : -1;
      if (scoreA === scoreB) winnerId = null; // berabere
      else winnerId = scoreA > scoreB ? a : b;
    }

    const result = {
      reason,
      winnerId: winnerId || null,
      winnerName: winnerId ? this.players[winnerId].name : null,
      players: this.publicPlayersState(),
    };

    this.addLog(
      winnerId ? `🏆 Oyun bitti! Kazanan: ${this.players[winnerId].name}` : '🤝 Oyun bitti! Berabere.',
      'system'
    );
    this.io.to(this.code).emit('gameOver', result);
  }

  destroy() {
    clearTimeout(this.gameEndTimeout);
    for (const id of this.order) {
      const p = this.players[id];
      if (p) {
        clearTimeout(p.questionTimer);
        clearTimeout(p.nextVisitorTimer);
      }
    }
  }
}

class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
  }

  createRoom() {
    let code;
    do {
      code = makeRoomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, this.io);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.order.length === 0) {
      room.destroy();
      this.rooms.delete(code);
    }
  }
}

module.exports = { GameManager, Room };
