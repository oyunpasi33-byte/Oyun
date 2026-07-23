// client/js/app.js
// Tüm istemci mantığı: socket bağlantısı, ekran geçişleri, oyun durumu render'ı.
// Modüler bir "state + render" deseni kullanılır: sunucudan gelen her olay
// yerel state'i günceller, ardından ilgili render fonksiyonu çağrılır.

(function () {
  'use strict';

  const socket = io();

  // ---------------- Yerel durum ----------------
  const state = {
    myId: null,
    roomCode: null,
    myName: '',
    oppName: 'Rakip',
    duration: 6 * 60 * 1000,
    endsAt: null,
    clockInterval: null,
    currentQuestion: null, // { id, timeLimit, startedAt }
    questionInterval: null,
    myCooldownUntil: 0,
    myAnswering: false,
    palaceInterval: null,
  };

  // ---------------- DOM yardımcıları ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showScreen(id) {
    $$('.screen').forEach((el) => el.classList.remove('active'));
    $(id).classList.add('active');
  }

  function showError(msg) {
    const el = $('#landing-error');
    el.textContent = msg;
    el.hidden = false;
  }

  function toast(message) {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  const ERROR_MESSAGES = {
    ODA_DOLU: 'Bu oda zaten dolu.',
    ODA_BULUNAMADI: 'Böyle bir oda bulunamadı. Kodu kontrol et.',
    OYUN_BASLADI: 'Bu odadaki oyun zaten başladı.',
  };

  // ==================================================================
  // EKRAN 1: Giriş — sekme geçişleri + oda kurma/katılma
  // ==================================================================
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
      $('#landing-error').hidden = true;
    });
  });

  $('#btn-create-room').addEventListener('click', () => {
    const name = $('#name-create').value.trim();
    if (!name) return showError('Lütfen bir kumandan adı gir.');
    state.myName = name;
    socket.emit('createRoom', { playerName: name });
  });

  $('#btn-join-room').addEventListener('click', () => {
    const name = $('#name-join').value.trim();
    const code = $('#code-join').value.trim().toUpperCase();
    if (!name) return showError('Lütfen bir kumandan adı gir.');
    if (!code) return showError('Lütfen oda kodunu gir.');
    state.myName = name;
    socket.emit('joinRoom', { roomCode: code, playerName: name });
  });

  // URL'de ?room=KOD varsa otomatik olarak "Odaya Katıl" sekmesini aç ve kodu doldur
  (function checkUrlRoomParam() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      $('.tab-btn[data-tab="join"]').click();
      $('#code-join').value = roomParam.toUpperCase();
    }
  })();

  // ==================================================================
  // Sunucu olayları: oda oluşturma / katılma
  // ==================================================================
  socket.on('roomCreated', ({ roomCode, playerId }) => enterLobby(roomCode, playerId));
  socket.on('roomJoined', ({ roomCode, playerId }) => enterLobby(roomCode, playerId));
  socket.on('roomError', ({ message }) => showError(ERROR_MESSAGES[message] || 'Bir hata oluştu.'));

  function enterLobby(roomCode, playerId) {
    state.roomCode = roomCode;
    state.myId = playerId;
    $('#room-code-display').textContent = roomCode;
    showScreen('#screen-lobby');
    history.replaceState(null, '', `?room=${roomCode}`);
  }

  $('#btn-copy-link').addEventListener('click', async () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Davet linki kopyalandı!');
    } catch (e) {
      toast(`Link: ${url}`);
    }
  });

  $('#btn-ready').addEventListener('click', () => {
    const btn = $('#btn-ready');
    const nowReady = btn.dataset.ready !== 'true';
    btn.dataset.ready = String(nowReady);
    btn.textContent = nowReady ? '✅ Hazır!' : '🛡️ Hazırım';
    socket.emit('playerReady', { roomCode: state.roomCode, ready: nowReady });
  });

  // ==================================================================
  // EKRAN 2.5: Yerleşim / kaydırılabilir bölge haritası
  // ==================================================================
  let mySelectedRegion = null;

  // Sunucu sadece bölge id/isim/açıklama gönderir; haritadaki konumları burada eşleştiriyoruz.
  const REGION_POSITIONS = {
    orman: { left: 180, top: 150 },
    dag: { left: 740, top: 130 },
    nehir: { left: 770, top: 500 },
    ova: { left: 150, top: 500 },
    kale: { left: 450, top: 320 },
    tarla: { left: 360, top: 430 },
  };

  socket.on('placementStart', ({ regions }) => {
    mySelectedRegion = null;
    const map = $('#region-map');
    map.innerHTML = '';
    regions.forEach((r) => {
      const pos = REGION_POSITIONS[r.id] || { left: 450, top: 320 };
      const pin = document.createElement('button');
      pin.className = 'region-pin';
      pin.dataset.regionId = r.id;
      pin.style.left = `${pos.left}px`;
      pin.style.top = `${pos.top}px`;
      pin.innerHTML = `
        <span class="pin-icon">${r.icon}</span>
        <span class="pin-name">${escapeHtml(r.name)}</span>
        <span class="pin-desc">${escapeHtml(r.desc)}</span>
      `;
      pin.addEventListener('click', () => {
        if (mySelectedRegion) return;
        mySelectedRegion = r.id;
        $$('.region-pin').forEach((t) => (t.disabled = true));
        pin.classList.add('selected');
        socket.emit('placeSettlement', { roomCode: state.roomCode, regionId: r.id });
        $('#placement-status').textContent = `📍 ${r.name} bölgesine yerleştin. Rakibinin seçmesi bekleniyor...`;
      });
      map.appendChild(pin);
    });
    $('#placement-status').textContent = 'Haritayı kaydır, yerleşmek istediğin bölgeye dokun.';
    showScreen('#screen-placement');

    // Haritayı ortalayarak başlat, oyuncu istediği yöne kaydırabilsin
    const wrap = $('#region-map-wrap');
    requestAnimationFrame(() => {
      wrap.scrollLeft = (map.offsetWidth - wrap.clientWidth) / 2;
      wrap.scrollTop = (map.offsetHeight - wrap.clientHeight) / 2;
    });
  });

  socket.on('placementUpdate', ({ players }) => {
    const oppEntry = players.find((p) => p.id !== state.myId);
    const meEntry = players.find((p) => p.id === state.myId);
    if (mySelectedRegion && oppEntry && !oppEntry.placed) {
      $('#placement-status').textContent = 'Bölgeni seçtin. Rakibinin seçmesi bekleniyor...';
    } else if (meEntry && !meEntry.placed) {
      $('#placement-status').textContent = 'Haritayı kaydır, yerleşmek istediğin bölgeye dokun.';
    }
  });

  socket.on('returnToLobby', () => {
    mySelectedRegion = null;
    const btn = $('#btn-ready');
    btn.dataset.ready = 'false';
    btn.textContent = '🛡️ Hazırım';
    showScreen('#screen-lobby');
    toast('Rakibin ayrıldı, lobiye dönüldü.');
  });

  // ==================================================================
  // EKRAN 2: Lobi güncellemesi
  // ==================================================================
  socket.on('lobbyUpdate', ({ players }) => {
    const box = $('#lobby-players');
    box.innerHTML = '';
    players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'lobby-player-row' + (p.ready ? ' is-ready' : '');
      const you = p.id === state.myId ? ' (Sen)' : '';
      row.innerHTML = `<span>${escapeHtml(p.name)}${you}</span><span class="ready-pill">${p.ready ? 'HAZIR' : 'Bekliyor'}</span>`;
      box.appendChild(row);
    });
    if (players.length < 2) {
      $('#lobby-hint').textContent = 'Arkadaşının katılmasını bekliyorsun...';
    } else {
      $('#lobby-hint').textContent = 'İkiniz de "Hazırım" deyince bölge seçim ekranına geçilir.';
    }
  });

  // ==================================================================
  // EKRAN 3: Oyun başlangıcı
  // ==================================================================
  socket.on('gameStarted', ({ players, endsAt, duration }) => {
    setupNames(players);
    state.endsAt = endsAt;
    state.duration = duration;
    showScreen('#screen-game');
    renderPlayers(players);
    startClock();
    startPalaceLoop();
    $('#round-info').textContent = 'Sarayına tıkla, danışmanın soru sorsun!';
  });

  // Saraya tıklama: soru iste
  $('#palace-btn-me').addEventListener('click', () => {
    if (state.myAnswering) return;
    if (Date.now() < state.myCooldownUntil) return;
    socket.emit('requestQuestion', { roomCode: state.roomCode });
  });

  socket.on('questionOnCooldown', ({ remainingMs }) => {
    toast(`⏳ Sarayın henüz hazır değil, ${Math.ceil(remainingMs / 1000)} sn bekle.`);
  });

  // Saray butonunun soğuma halkasını her karede günceller
  function startPalaceLoop() {
    clearInterval(state.palaceInterval);
    state.palaceInterval = setInterval(updatePalaceButton, 120);
  }

  function updatePalaceButton() {
    const btn = $('#palace-btn-me');
    const ring = $('#me-palace-ring-fg');
    const label = $('#me-palace-label');
    const CIRCUMFERENCE = 145;
    const now = Date.now();

    if (state.myAnswering) {
      btn.classList.add('answering');
      btn.classList.remove('cooling');
      btn.disabled = true;
      label.textContent = 'Soru cevaplanıyor...';
      ring.style.strokeDashoffset = '0';
      return;
    }

    btn.classList.remove('answering');
    const remaining = state.myCooldownUntil - now;
    if (remaining > 0) {
      btn.classList.add('cooling');
      btn.disabled = true;
      const totalWindow = state.lastCooldownSpan || remaining;
      const pct = Math.max(0, Math.min(1, remaining / totalWindow));
      ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
      label.textContent = `Hazırlanıyor (${Math.ceil(remaining / 1000)}sn)`;
    } else {
      btn.classList.remove('cooling');
      btn.disabled = false;
      ring.style.strokeDashoffset = '0';
      label.textContent = 'Saraya Tıkla';
    }
  }

  function setupNames(players) {
    const oppId = Object.keys(players).find((id) => id !== state.myId);
    if (players[state.myId]) {
      $('#me-name').textContent = players[state.myId].name;
      $('#me-region').textContent = players[state.myId].regionName ? `📍 ${players[state.myId].regionName}` : '';
    }
    if (oppId) {
      state.oppName = players[oppId].name;
      $('#opp-name').textContent = players[oppId].name;
      $('#opp-region').textContent = players[oppId].regionName ? `📍 ${players[oppId].regionName}` : '';
    }
  }

  function startClock() {
    clearInterval(state.clockInterval);
    state.clockInterval = setInterval(() => {
      const remaining = Math.max(0, state.endsAt - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      $('#game-clock').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      if (remaining <= 0) clearInterval(state.clockInterval);
    }, 250);
  }

  // ==================================================================
  // Oyun durumu render'ı (köylü/asker/ekonomi barları)
  // ==================================================================
  socket.on('gameStateUpdate', ({ players }) => renderPlayers(players));

  function renderPlayers(players) {
    const oppId = Object.keys(players).find((id) => id !== state.myId);
    const me = players[state.myId];
    const opp = players[oppId];
    if (me) renderSide('me', me);
    if (opp) renderSide('opp', opp);

    if (me) {
      const sabBtn = $('#btn-sabotage');
      sabBtn.disabled = !me.canSabotage;
      const raidBtn = $('#btn-raid');
      raidBtn.disabled = !me.raidReady;
      raidBtn.textContent = me.raidReady ? '⚔️ Akına Çık' : `⚔️ Akın (${me.soldiers}/8 asker)`;

      $('#me-speed-tag').textContent = `⚡ ${me.speed.toFixed(2)}x`;
      if (me.cooldownUntil !== state.myCooldownUntil) {
        state.lastCooldownSpan = Math.max(1, me.cooldownUntil - Date.now());
        state.myCooldownUntil = me.cooldownUntil;
      }
      state.myAnswering = !!me.answering;
      updatePalaceButton();
    }

    if (opp) {
      $('#opp-speed-tag').textContent = `⚡ ${opp.speed.toFixed(2)}x`;
      if (opp.answering) {
        $('#opp-status').textContent = `${state.oppName} bir soruyla uğraşıyor...`;
      } else if (!opp.cooldownReady) {
        $('#opp-status').textContent = 'Yavaşlamış, hazırlanıyor...';
      } else {
        $('#opp-status').textContent = 'Hazır bekliyor...';
      }
    }
  }

  function renderSide(prefix, p) {
    const maxVillagers = 40; // bar ölçeklemesi için tavan referans
    const maxSoldiers = 16;
    const vPct = Math.min(100, (p.villagers / maxVillagers) * 100);
    const sPct = Math.min(100, (p.soldiers / maxSoldiers) * 100);

    animateNumber(`#${prefix}-villagers-num`, p.villagers);
    animateNumber(`#${prefix}-soldiers-num`, p.soldiers);
    $(`#${prefix}-villagers-bar`).style.width = `${vPct}%`;
    $(`#${prefix}-soldiers-bar`).style.width = `${sPct}%`;
    $(`#${prefix}-economy-num`).textContent = p.economy;

    const streakEl = $(`#${prefix}-streak`);
    if (p.streak >= 2) {
      streakEl.hidden = false;
      $(`#${prefix}-streak-count`).textContent = p.streak;
    } else {
      streakEl.hidden = true;
    }

    if (!p.alive) {
      $(`#panel-${prefix === 'me' ? 'me' : 'opp'}`).style.opacity = '0.5';
    }
  }

  const lastNumbers = {};
  function animateNumber(sel, value) {
    const el = $(sel);
    const prev = lastNumbers[sel];
    el.textContent = value;
    if (prev !== undefined && value < prev) {
      const panel = el.closest('.castle-panel');
      if (panel) {
        panel.classList.remove('shake');
        void panel.offsetWidth; // reflow ile animasyonu yeniden tetikle
        panel.classList.add('shake');
      }
    }
    lastNumbers[sel] = value;
  }

  // ==================================================================
  // Rakip bildirimi (rakip kendi sarayına tıklayıp soru aldığında bilgi ver)
  // ==================================================================
  socket.on('opponentThinking', () => {
    $('#opp-status').textContent = `${state.oppName} bir soruyla uğraşıyor...`;
  });

  // ==================================================================
  // Soru modalı
  // ==================================================================
  const ADVISOR_EMOJI = {
    'Saray Bilgini': '🧙',
    'Kütüphane Katibi': '🧑‍🏫',
    'Yaşlı Vezir': '👴',
    'Gezgin Alim': '🥷',
  };

  socket.on('newQuestion', (q) => {
    state.currentQuestion = { id: q.id, timeLimit: q.timeLimit, startedAt: Date.now() };
    $('#visitor-emoji').textContent = ADVISOR_EMOJI[q.advisor] || '❓';
    $('#visitor-type').textContent = q.advisor;
    $('#visitor-category').textContent = `${q.category} · ${difficultyLabel(q.difficulty)}`;
    $('#question-text').textContent = q.question;
    $('#round-info').textContent = `${q.advisor} sana bir soru soruyor!`;

    const optionsBox = $('#question-options');
    optionsBox.innerHTML = '';
    q.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.textContent = opt;
      btn.addEventListener('click', () => submitAnswer(idx, btn));
      optionsBox.appendChild(btn);
    });

    $('#question-modal').hidden = false;
    startQuestionTimer(q.timeLimit);
  });

  function difficultyLabel(d) {
    return d === 'easy' ? 'Kolay' : d === 'medium' ? 'Orta' : 'Zor';
  }

  function startQuestionTimer(timeLimitMs) {
    clearInterval(state.questionInterval);
    const ring = $('#timer-ring-fg');
    const CIRCUMFERENCE = 119; // 2*PI*19 yaklaşık, style.css'teki stroke-dasharray ile eşleşir
    const secondsLabel = $('#timer-seconds');
    const start = Date.now();

    state.questionInterval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, timeLimitMs - elapsed);
      const pct = remaining / timeLimitMs;
      ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
      secondsLabel.textContent = Math.ceil(remaining / 1000);
      if (pct < 0.3) ring.style.stroke = '#A23B2E';
      if (remaining <= 0) clearInterval(state.questionInterval);
    }, 100);
  }

  function submitAnswer(index, btnEl) {
    if (!state.currentQuestion) return;
    $$('.option-btn').forEach((b) => (b.disabled = true));
    socket.emit('answerQuestion', {
      roomCode: state.roomCode,
      questionId: state.currentQuestion.id,
      answerIndex: index,
    });
  }

  socket.on('answerResult', ({ correct, correctIndex }) => {
    clearInterval(state.questionInterval);
    const buttons = $$('.option-btn');
    buttons.forEach((b, idx) => {
      b.disabled = true;
      if (idx === correctIndex) b.classList.add('correct');
      else if (!correct) b.classList.add('wrong');
    });
    toast(correct ? '✅ Doğru cevap! Hızlandın.' : '💀 Yanlış cevap, yavaşladın...');
    setTimeout(() => {
      $('#question-modal').hidden = true;
      state.currentQuestion = null;
      $('#round-info').textContent = 'Sarayın hazır olunca tekrar tıklayabilirsin.';
    }, 1100);
  });

  // ==================================================================
  // Sabotaj / Akın
  // ==================================================================
  $('#btn-sabotage').addEventListener('click', () => {
    socket.emit('triggerSabotage', { roomCode: state.roomCode });
  });
  $('#btn-raid').addEventListener('click', () => {
    socket.emit('triggerRaid', { roomCode: state.roomCode });
  });

  socket.on('sabotaged', ({ by }) => {
    toast(`🗡️ ${by} sana sabotaj yaptı! Bir sonraki soru zor ve süre kısa.`);
  });

  socket.on('raidDenied', ({ reason }) => {
    toast(`⚠️ ${reason}`);
  });

  socket.on('raidResult', ({ attacker, defender, success, stolenVillagers, stolenSoldiers, lostSoldiers }) => {
    if (success) {
      toast(`⚔️ ${attacker}, ${defender}'den ${stolenVillagers} köylü çaldı!`);
    } else {
      toast(`🛡️ ${defender}, ${attacker}'in akınını püskürttü!`);
    }
  });

  // ==================================================================
  // Savaş günlüğü
  // ==================================================================
  socket.on('logEntry', (entry) => {
    const body = $('#log-body');
    const line = document.createElement('div');
    line.className = `log-line ${entry.type}`;
    const time = new Date(entry.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `[${time}] ${entry.message}`;
    body.prepend(line);
    while (body.children.length > 50) body.removeChild(body.lastChild);
  });

  // ==================================================================
  // Rakip ayrıldı
  // ==================================================================
  socket.on('opponentLeft', ({ name }) => {
    toast(`🚪 ${name} oyundan ayrıldı.`);
  });

  // ==================================================================
  // Oyun sonu
  // ==================================================================
  socket.on('gameOver', ({ winnerId, winnerName, players, reason }) => {
    clearInterval(state.clockInterval);
    clearInterval(state.questionInterval);
    clearInterval(state.palaceInterval);
    $('#question-modal').hidden = true;

    const iAmWinner = winnerId === state.myId;
    const isDraw = !winnerId;

    $('#gameover-emblem').textContent = isDraw ? '🤝' : iAmWinner ? '🏆' : '🏳️';
    $('#gameover-title').textContent = isDraw ? 'Berabere!' : iAmWinner ? 'Zafer Senin!' : 'Kalen Düştü...';
    $('#gameover-sub').textContent = reasonText(reason, iAmWinner, isDraw);

    const statsBox = $('#gameover-stats');
    statsBox.innerHTML = '';
    Object.values(players).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'gameover-stat-row';
      const you = p.id === state.myId ? ' (Sen)' : '';
      row.innerHTML = `<span>${escapeHtml(p.name)}${you}</span><span>👤 ${p.villagers} · 🗡️ ${p.soldiers}</span>`;
      statsBox.appendChild(row);
    });

    $('#gameover-modal').hidden = false;
  });

  function reasonText(reason, iAmWinner, isDraw) {
    if (isDraw) return 'İki kale de eşit güçte kaldı.';
    if (reason === 'elimination') return iAmWinner ? 'Rakibinin kalesi tamamen çöktü!' : 'Kalen tamamen çöktü.';
    if (reason === 'opponent_left') return iAmWinner ? 'Rakibin oyunu terk etti.' : '';
    return iAmWinner ? 'Süre doldu, en güçlü kale sensin!' : 'Süre doldu, rakibin daha güçlüydü.';
  }

  $('#btn-play-again').addEventListener('click', () => {
    window.location.href = window.location.pathname;
  });

  // ---------------- Yardımcı ----------------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
