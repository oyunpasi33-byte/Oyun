// server/gameManager.js
// Odaların (room) yaşam döngüsünü, oyun durumunu, soru akışını,
// hız/soğuma (cooldown) sistemini, sabotaj ve akın (raid) mekaniklerini yöneten modül.
//
// YENİ TEMPO MODELİ:
// - Sorular artık otomatik gelmiyor. Oyuncu kendi sarayına tıklayınca (requestQuestion)
//   bir soru gelir.
// - Her oyuncunun bir "hız" (speed) değeri vardır (0.4x - 2.2x arası).
//   Doğru cevap -> hız artar, bir sonraki soruya kadar bekleme (cooldown) kısalır.
//   Yanlış/süresiz cevap -> hız düşer, bekleme uzar.
//   Böylece iyi bilenler haritada "daha hızlı" ilerliyormuş hissi verir,
//   bilemeyenler yavaşlar. Bu da genel oyun temposunu otomatik ziyaretçi
//   akışına göre belirgin şekilde yavaşlatır.

const { getRandomQuestion } = require('./questions');

// ---- Oyun ayarları (dengeyi buradan yönetebilirsin) ----
const GAME_DURATION_MS = 6 * 60 * 1000;   // Toplam oyun süresi: 6 dakika (yavaş tempo -> biraz uzun)
const BASE_QUESTION_TIME_MS = 20000;      // Soru başına düşünme süresi (eskiden 14s, şimdi 20s)
const SABOTAGE_TIME_REDUCTION_MS = 5000;  // Sabotaj sonrası süre kısaltma
const BASE_COOLDOWN_MS = 4200;            // Hız=1.0 iken iki soru arası temel bekleme
const COOLDOWN_MIN_MS = 1600;             // En hızlı oyuncu için taban bekleme
const COOLDOWN_MAX_MS = 11000;            // En yavaş oyuncu için tavan bekleme
const WRONG_COOLDOWN_PENALTY_MS = 2200;   // Yanlış cevaba ekstra bekleme cezası
const SPEED_MIN = 0.4;
const SPEED_MAX = 2.2;
const SPEED_STEP_UP = 0.15;
const SPEED_STEP_DOWN = 0.25;
const SPEED_SABOTAGE_PENALTY = 0.3;

const RAID_SOLDIER_THRESHOLD = 8;         // Akın yapabilmek için gereken min. asker
const RAID_COOLDOWN_MS = 40000;           // Akın sonrası bekleme süresi (yavaş tempo)
const RAID_SOLDIER_COST = 3;              // Akına çıkarken riske atılan asker sayısı
const STARTING_VILLAGERS = 20;
const STARTING_SOLDIERS = 4;
const STREAK_FOR_SABOTAGE = 3;            // Sabotaj hakkı için gereken art arda doğru sayısı

const ADVISOR_TITLES = ['Saray Bilgini', 'Kütüphane Katibi', 'Yaşlı Vezir', 'Gezgin Alim'];
const DEATH_FLAVORS = [
  'kaynak toplarken vakit kaybetti',
  'yanlış cevabın verdiği şaşkınlıkla geri döndü',
  'yolunu şaşırıp elleri boş döndü',
  'yorgunluktan geri çekildi',
  'sabotaj yüzünden telaşa kapıldı',
];

// Yerleşim fazında seçilebilecek bölgeler. Her biri farklı bir başlangıç avantajı verir.
const REGIONS = [
  { id: 'ova', name: 'Verimli Ova', icon: '🌾', desc: '+3 başlangıç köylüsü', apply: (p) => { p.villagers += 3; } },
  { id: 'orman', name: 'Bereketli Orman', icon: '🌲', desc: '+25 başlangıç ekonomisi', apply: (p) => { p.economy += 25; } },
  { id: 'dag', name: 'Dağ Eteği', icon: '⛰️', desc: '+2 başlangıç askeri', apply: (p) => { p.soldiers += 2; } },
  { id: 'nehir', name: 'Nehir Kıyısı', icon: '🌊', desc: '+0.2x başlangıç hızı', apply: (p) => { p.speed = Math.min(SPEED_MAX, p.speed + 0.2); } },
  { id: 'kale', name: 'Eski Kale Kalıntısı', icon: '🏰', desc: '+1 asker, +10 ekonomi', apply: (p) => { p.soldiers += 1; p.economy += 10; } },
  { id: 'tarla', name: 'Gün Işığı Tarlası', icon: '🌻', desc: '+2 köylü, +0.1x hız', apply: (p) => { p.villagers += 2; p.speed = Math.min(SPEED_MAX, p.speed + 0.1); } },
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function cooldownForSpeed(speed) {
  return Math.round(clamp(BASE_COOLDOWN_MS / speed, COOLDOWN_MIN_MS, COOLDOWN_MAX_MS));
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
      speed: 1.0,
      cooldownUntil: 0,
      placed: false,
      regionId: null,
      regionName: null,
      ready: false,
      alive: true,
      canSabotage: false,
      raidCooldownUntil: 0,
      currentQuestion: null,
      questionTimer: null,
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
    const now = Date.now();
    for (const id of this.order) {
      const p = this.players[id];
      out[id] = {
        id: p.id,
        name: p.name,
        villagers: p.villagers,
        soldiers: p.soldiers,
        economy: p.economy,
        streak: p.streak,
        speed: Math.round(p.speed * 100) / 100,
        cooldownUntil: p.cooldownUntil,
        cooldownReady: now >= p.cooldownUntil,
        answering: !!p.currentQuestion,
        regionName: p.regionName,
        alive: p.alive,
        ready: p.ready,
        canSabotage: p.canSabotage,
        raidReady: p.soldiers >= RAID_SOLDIER_THRESHOLD && now >= p.raidCooldownUntil,
        raidCooldownRemainingMs: Math.max(0, p.raidCooldownUntil - now),
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
      this.startPlacement();
    }
  }

  // ---- Yerleşim fazı: ikinci oyuncu hazır olunca çağrılır ----
  startPlacement() {
    this.status = 'placing';
    this.addLog('🗺️ Bölgeler açıldı! Her iki kumandan da yerleşeceği bölgeyi seçiyor.', 'system');
    this.io.to(this.code).emit('placementStart', {
      regions: REGIONS.map(r => ({ id: r.id, name: r.name, icon: r.icon, desc: r.desc })),
    });
  }

  placeSettlement(socketId, regionId) {
    const p = this.players[socketId];
    if (!p || this.status !== 'placing' || p.placed) return;
    const region = REGIONS.find(r => r.id === regionId);
    if (!region) return;

    p.placed = true;
    p.regionId = region.id;
    p.regionName = region.name;
    region.apply(p);

    this.addLog(`📍 ${p.name}, ${region.icon} ${region.name} bölgesine yerleşti.`, 'system');
    this.io.to(this.code).emit('placementUpdate', {
      players: this.order.map(id => ({
        id,
        placed: this.players[id].placed,
        regionName: this.players[id].regionName,
        regionIcon: this.players[id].regionId ? REGIONS.find(r => r.id === this.players[id].regionId).icon : null,
      })),
    });

    if (this.order.length === 2 && this.order.every(id => this.players[id].placed)) {
      this.startGame();
    }
  }

  // Yerleşim ya da lobi aşamasında bir oyuncu ayrılırsa odayı lobiye sıfırlar
  backToLobby() {
    this.status = 'lobby';
    for (const id of this.order) {
      const p = this.players[id];
      p.ready = false;
      p.placed = false;
      p.regionId = null;
      p.regionName = null;
    }
    this.io.to(this.code).emit('returnToLobby');
    this.broadcastLobby();
  }

  startGame() {
    this.status = 'playing';
    this.endsAt = Date.now() + GAME_DURATION_MS;
    this.addLog('⚔️ Yerleşim tamamlandı! Sarayınıza tıklayarak kaynak toplamaya başlayabilirsiniz.', 'system');
    this.io.to(this.code).emit('gameStarted', {
      players: this.publicPlayersState(),
      endsAt: this.endsAt,
      duration: GAME_DURATION_MS,
    });
    this.gameEndTimeout = setTimeout(() => this.endGame('time'), GAME_DURATION_MS);
  }

  // Oyuncu kendi sarayına tıkladığında çağrılır.
  requestQuestion(socketId) {
    const p = this.players[socketId];
    if (!p || this.status !== 'playing' || !p.alive) return;
    if (p.currentQuestion) return; // zaten cevap bekleyen bir sorusu var
    const now = Date.now();
    if (now < p.cooldownUntil) {
      this.io.to(socketId).emit('questionOnCooldown', { remainingMs: p.cooldownUntil - now });
      return;
    }
    this.spawnQuestion(socketId);
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
    timeLimit = Math.max(8000, timeLimit);
    p.timeReductionMs = 0;

    p.currentQuestion = {
      id: questionId,
      idx: q._idx,
      question: q.question,
      options: q.options,
      correct: q.correct,
      difficulty: q.difficulty,
      category: q.category,
      advisor: randomFrom(ADVISOR_TITLES),
      startedAt: Date.now(),
      timeLimit,
    };

    this.io.to(socketId).emit('newQuestion', {
      id: questionId,
      question: q.question,
      options: q.options,
      difficulty: q.difficulty,
      category: q.category,
      advisor: p.currentQuestion.advisor,
      timeLimit,
    });

    // Rakibe kısa bir "düşünüyor" bildirimi gönder
    const oppId = this.opponentIdOf(socketId);
    if (oppId) {
      this.io.to(oppId).emit('opponentThinking', {});
    }

    this.broadcastState(); // answering:true anlık yansısın (buton kilitlenmesi için)

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
    const now = Date.now();

    if (isCorrect) {
      p.streak += 1;
      p.speed = clamp(p.speed + SPEED_STEP_UP, SPEED_MIN, SPEED_MAX);
      const gain = q.difficulty === 'hard' ? 3 : q.difficulty === 'medium' ? 2 : 1;
      p.villagers += gain;
      p.economy += gain * 4;
      if (p.streak > 0 && p.streak % 4 === 0) {
        p.soldiers += 1;
        this.addLog(`🛡️ ${p.name}'in köyünde bir gönüllü asker oldu! (${p.streak} seri doğru)`, 'good');
      }
      if (p.streak >= STREAK_FOR_SABOTAGE) {
        p.canSabotage = true;
      }
      p.cooldownUntil = now + cooldownForSpeed(p.speed);
      this.addLog(`✅ ${p.name}, ${q.advisor}'nin sorusunu doğru bildi ve hızlandı! (Hız: ${p.speed.toFixed(2)}x, +${gain} kaynak)`, 'good');
    } else {
      p.streak = 0;
      p.canSabotage = false;
      p.speed = clamp(p.speed - SPEED_STEP_DOWN, SPEED_MIN, SPEED_MAX);
      p.cooldownUntil = now + cooldownForSpeed(p.speed) + WRONG_COOLDOWN_PENALTY_MS;

      const killSoldierInstead = p.villagers <= 0 && p.soldiers > 0;
      if (killSoldierInstead) {
        p.soldiers = Math.max(0, p.soldiers - 1);
        this.addLog(`💀 ${p.name}'in köyünde kaynak kalmadı! Bir asker ${randomFrom(DEATH_FLAVORS)} ve yavaşladı.`, 'bad');
      } else if (p.villagers > 0) {
        p.villagers -= 1;
        const reason = answerIndex === null ? 'süresi dolduğu için' : 'yanlış cevap verdiği için';
        this.addLog(`💀 ${p.name}, ${reason} bir kaynak kaybetti ve yavaşladı. (Hız: ${p.speed.toFixed(2)}x)`, 'bad');
      } else {
        this.addLog(`🐌 ${p.name} yanlış bildi ve iyice yavaşladı. (Hız: ${p.speed.toFixed(2)}x)`, 'bad');
      }
    }

    p.villagers = Math.max(0, p.villagers);
    p.soldiers = Math.max(0, p.soldiers);

    this.broadcastState();

    this.io.to(socketId).emit('answerResult', {
      correct: isCorrect,
      correctIndex: q.correct,
      chosenIndex: answerIndex,
      cooldownMs: p.cooldownUntil - now,
      speed: p.speed,
    });

    if (p.villagers <= 0 && p.soldiers <= 0) {
      p.alive = false;
      this.addLog(`🏳️ ${p.name}'in köyü tamamen çöktü!`, 'system');
      const oppId = this.opponentIdOf(socketId);
      this.endGame('elimination', oppId);
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
    opp.speed = clamp(opp.speed - SPEED_SABOTAGE_PENALTY, SPEED_MIN, SPEED_MAX);
    opp.cooldownUntil = Math.max(opp.cooldownUntil, Date.now() + cooldownForSpeed(opp.speed));

    this.addLog(`🗡️ ${p.name}, ${opp.name}'e sabotaj yaptı! Sonraki soru zor, süre kısa ve hızı düştü.`, 'sabotage');
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

    const successChance = Math.min(0.85, Math.max(0.35, p.soldiers / (p.soldiers + opp.soldiers + 1) + 0.15));
    const success = Math.random() < successChance;

    if (success) {
      const stolenVillagers = Math.min(opp.villagers, Math.floor(Math.random() * 3) + 2);
      const stolenSoldiers = Math.min(opp.soldiers, Math.random() < 0.4 ? 1 : 0);
      opp.villagers -= stolenVillagers;
      opp.soldiers -= stolenSoldiers;
      p.villagers += stolenVillagers;
      p.soldiers += stolenSoldiers;
      this.addLog(`⚔️ ${p.name} akın düzenledi ve ${opp.name}'den ${stolenVillagers} kaynak${stolenSoldiers ? ` ile ${stolenSoldiers} asker` : ''} çaldı!`, 'raid');
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
    }

    let winnerId = forcedWinnerId;
    if (!winnerId) {
      const [a, b] = this.order;
      const scoreA = this.players[a].villagers + this.players[a].soldiers * 2;
      const scoreB = this.players[b] ? this.players[b].villagers + this.players[b].soldiers * 2 : -1;
      if (scoreA === scoreB) winnerId = null;
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
      if (p) clearTimeout(p.questionTimer);
    }
  }
}

class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
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
