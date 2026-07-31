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
    duelActive: false,
    duelId: null,
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
  // EKRAN 2.5: Yerleşim — tam ekran, piksel piksel üretilen ada
  // ==================================================================
  let mySelectedRegion = null;
  let regionsById = {};

  // Bölge bonusları bu koordinatlarla eşleştirilir (0-1 arası oran, ekran boyutundan bağımsız).
  // Bu konumlar oyuncuya ÖNCEDEN gösterilmiyor — sadece dokunulan yere en yakın bölge bulunuyor.
  const REGION_POSITIONS = {
    orman: { fx: 0.30, fy: 0.32 },
    dag: { fx: 0.58, fy: 0.35 },
    nehir: { fx: 0.64, fy: 0.62 },
    ova: { fx: 0.30, fy: 0.68 },
    kale: { fx: 0.46, fy: 0.52 },
    tarla: { fx: 0.68, fy: 0.30 },
  };

  function nearestRegionId(fx, fy) {
    let bestId = null;
    let bestDist = Infinity;
    for (const [id, pos] of Object.entries(REGION_POSITIONS)) {
      const dx = pos.fx - fx;
      const dy = pos.fy - fy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestId = id;
      }
    }
    return bestId;
  }

  // ---- Piksel piksel prosedürel ada üretimi (canvas üzerine düşük çözünürlükte çizilir,
  //      CSS "image-rendering: pixelated" ile büyütülünce blok blok piksel sanatı görünümü verir) ----
  function generateIslandCanvas() {
    const canvas = $('#island-canvas');
    const wrapW = window.innerWidth;
    const wrapH = window.innerHeight;
    const cols = 72;
    const rows = Math.max(36, Math.round(cols * (wrapH / wrapW)));
    canvas.width = cols;
    canvas.height = rows;

    const ctx = canvas.getContext('2d');
    const seed = Math.random() * 1000;

    const cx = cols / 2, cy = rows / 2;
    const maxR = Math.min(cols, rows) / 2 * 0.82;

    // Dağ ve göl için rastgele merkezler (her oyunda farklı bir ada!)
    const mountainCenters = [
      { x: cols * (0.5 + Math.random() * 0.16 - 0.08), y: rows * (0.35 + Math.random() * 0.1 - 0.05), r: Math.min(cols, rows) * 0.14 },
      { x: cols * (0.28 + Math.random() * 0.1 - 0.05), y: rows * (0.55 + Math.random() * 0.1 - 0.05), r: Math.min(cols, rows) * 0.1 },
    ];
    const forestCenter = { x: cols * 0.30, y: rows * 0.30, r: Math.min(cols, rows) * 0.16 };
    const lakeCenter = { x: cols * 0.64, y: rows * 0.62, r: Math.min(cols, rows) * 0.075 };

    const grid = [];
    for (let y = 0; y < rows; y++) {
      const row = [];
      for (let x = 0; x < cols; x++) {
        const dx = (x - cx) / maxR;
        const dy = (y - cy) / maxR;
        let d = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const noise = 0.22 * Math.sin(angle * 5 + seed) + 0.10 * Math.sin(angle * 11 + seed * 2);
        d -= noise;
        row.push(d);
      }
      grid.push(row);
    }

    function inBlob(x, y, center) {
      const dx = x - center.x, dy = y - center.y;
      return Math.sqrt(dx * dx + dy * dy) < center.r;
    }

    const COLORS = {
      water: '#0d1f3a',
      shallow: '#16385f',
      sand: '#c9a662',
      grass: '#4a7638',
      grass2: '#436a32',
      forest: '#33562a',
      mountain: '#7c766a',
      mountainDark: '#5c574c',
      lake: '#1f5083',
    };

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = grid[y][x];
        let color;
        if (d > 1.0) {
          color = COLORS.water;
        } else if (d > 0.92) {
          color = COLORS.shallow;
        } else if (d > 0.84) {
          color = COLORS.sand;
        } else {
          // kara parçası
          if (inBlob(x, y, lakeCenter)) {
            color = COLORS.lake;
          } else if (mountainCenters.some((m) => inBlob(x, y, m))) {
            color = ((x + y) % 3 === 0) ? COLORS.mountainDark : COLORS.mountain;
          } else if (inBlob(x, y, forestCenter)) {
            color = COLORS.forest;
          } else {
            color = ((x * 3 + y * 7 + Math.round(seed)) % 5 === 0) ? COLORS.grass2 : COLORS.grass;
          }
        }
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  function handleCanvasTap(clientX, clientY) {
    if (mySelectedRegion) return;
    const canvas = $('#island-canvas');
    const rect = canvas.getBoundingClientRect();
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    const regionId = nearestRegionId(fx, fy);
    if (!regionId) return;
    selectRegion(regionId);
  }

  // ==================================================================
  // Harita kontrolcüsü: pinch-zoom, sürükleyerek gezinme, dokunuş algılama
  // ==================================================================
  const mapCtl = {
    zoom: 1, panX: 0, panY: 0,
    minZoom: 1, maxZoom: 3.5,
    pointers: new Map(),
    pinchStartDist: 0, pinchStartZoom: 1, pinchStartPan: { x: 0, y: 0 }, pinchMid: { x: 0, y: 0 },
    singleStart: null, singleMoved: 0,
    gesturesReady: false,
  };

  function applyMapTransform() {
    $('#map-content').style.transform = `translate(${mapCtl.panX}px, ${mapCtl.panY}px) scale(${mapCtl.zoom})`;
  }

  function clampPan() {
    const wrap = $('#map-viewport');
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    const contentW = vw * mapCtl.zoom, contentH = vh * mapCtl.zoom;
    const minX = Math.min(0, vw - contentW);
    const minY = Math.min(0, vh - contentH);
    mapCtl.panX = Math.max(minX, Math.min(0, mapCtl.panX));
    mapCtl.panY = Math.max(minY, Math.min(0, mapCtl.panY));
  }

  function zoomBy(factor) {
    const wrap = $('#map-viewport');
    const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2;
    const oldZoom = mapCtl.zoom;
    const newZoom = Math.max(mapCtl.minZoom, Math.min(mapCtl.maxZoom, oldZoom * factor));
    const ratio = newZoom / oldZoom;
    mapCtl.panX = cx - (cx - mapCtl.panX) * ratio;
    mapCtl.panY = cy - (cy - mapCtl.panY) * ratio;
    mapCtl.zoom = newZoom;
    clampPan();
    applyMapTransform();
  }

  function setupMapGestures() {
    if (mapCtl.gesturesReady) return;
    mapCtl.gesturesReady = true;
    const wrap = $('#map-viewport');

    wrap.addEventListener('pointerdown', (e) => {
      mapCtl.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      wrap.setPointerCapture(e.pointerId);
      if (mapCtl.pointers.size === 1) {
        mapCtl.singleStart = { x: e.clientX, y: e.clientY };
        mapCtl.singleMoved = 0;
      } else if (mapCtl.pointers.size === 2) {
        const pts = [...mapCtl.pointers.values()];
        mapCtl.pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        mapCtl.pinchStartZoom = mapCtl.zoom;
        mapCtl.pinchStartPan = { x: mapCtl.panX, y: mapCtl.panY };
        mapCtl.pinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      }
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!mapCtl.pointers.has(e.pointerId)) return;
      mapCtl.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mapCtl.pointers.size === 2) {
        const pts = [...mapCtl.pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const scaleFactor = dist / mapCtl.pinchStartDist;
        const newZoom = Math.max(mapCtl.minZoom, Math.min(mapCtl.maxZoom, mapCtl.pinchStartZoom * scaleFactor));
        const rect = wrap.getBoundingClientRect();
        const localMidX = mapCtl.pinchMid.x - rect.left;
        const localMidY = mapCtl.pinchMid.y - rect.top;
        const ratio = newZoom / mapCtl.pinchStartZoom;
        mapCtl.panX = localMidX - (localMidX - mapCtl.pinchStartPan.x) * ratio;
        mapCtl.panY = localMidY - (localMidY - mapCtl.pinchStartPan.y) * ratio;
        mapCtl.zoom = newZoom;
        clampPan();
        applyMapTransform();
      } else if (mapCtl.pointers.size === 1) {
        const start = mapCtl.singleStart;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        mapCtl.singleMoved = Math.max(mapCtl.singleMoved, Math.abs(dx), Math.abs(dy));
        if (mapCtl.zoom > 1.02) {
          mapCtl.panX += e.movementX || 0;
          mapCtl.panY += e.movementY || 0;
          clampPan();
          applyMapTransform();
        }
      }
    });

    function endPointer(e) {
      const wasSingle = mapCtl.pointers.size === 1;
      const moved = mapCtl.singleMoved;
      mapCtl.pointers.delete(e.pointerId);
      if (mapCtl.pointers.size === 0) {
        if (wasSingle && moved <= 8 && !$('#placement-overlay').hidden) {
          handleCanvasTap(e.clientX, e.clientY);
        }
        mapCtl.singleStart = null;
        mapCtl.singleMoved = 0;
      }
    }
    wrap.addEventListener('pointerup', endPointer);
    wrap.addEventListener('pointercancel', endPointer);

    // Masaüstünde fare tekerleği ile yakınlaştırma
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const oldZoom = mapCtl.zoom;
      const newZoom = Math.max(mapCtl.minZoom, Math.min(mapCtl.maxZoom, oldZoom * (e.deltaY < 0 ? 1.12 : 0.89)));
      const ratio = newZoom / oldZoom;
      mapCtl.panX = localX - (localX - mapCtl.panX) * ratio;
      mapCtl.panY = localY - (localY - mapCtl.panY) * ratio;
      mapCtl.zoom = newZoom;
      clampPan();
      applyMapTransform();
    }, { passive: false });
  }

  $('#btn-zoom-in').addEventListener('click', () => zoomBy(1.3));
  $('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));

  function selectRegion(regionId) {
    mySelectedRegion = regionId;
    const region = regionsById[regionId];
    const pos = REGION_POSITIONS[regionId];

    const flag = document.createElement('div');
    flag.className = 'settle-flag';
    flag.style.left = `${pos.fx * 100}%`;
    flag.style.top = `${pos.fy * 100}%`;
    flag.textContent = '📍';
    $('#flag-layer').appendChild(flag);

    socket.emit('placeSettlement', { roomCode: state.roomCode, regionId });

    const revealHtml = region
      ? `<span class="region-reveal">${region.icon} <b>${escapeHtml(region.name)}</b> — ${escapeHtml(region.desc)}</span>`
      : '';
    $('#placement-status').innerHTML = `Buraya yerleştin! Rakibinin seçmesi bekleniyor...<br>${revealHtml}`;
  }

  socket.on('placementStart', ({ regions }) => {
    mySelectedRegion = null;
    regionsById = {};
    regions.forEach((r) => { regionsById[r.id] = r; });
    $$('.settle-flag').forEach((f) => f.remove());
    $$('.castle-marker').forEach((m) => m.remove());

    $('#placement-status').textContent = 'Haritada bir yere dokun.';
    $('#placement-overlay').hidden = false;
    $('#battle-hud-top').hidden = true;
    $('#battle-hud-bottom').hidden = true;
    $('#hud-panel-me').hidden = true;
    $('#hud-panel-opp').hidden = true;
    $('#log-scroll').hidden = true;
    showScreen('#screen-world');

    setupMapGestures();
    mapCtl.zoom = 1; mapCtl.panX = 0; mapCtl.panY = 0;
    applyMapTransform();
    generateIslandCanvas();
  });

  socket.on('placementUpdate', ({ players }) => {
    const meEntry = players.find((p) => p.id === state.myId);
    if (meEntry && !meEntry.placed) {
      $('#placement-status').textContent = 'Haritada bir yere dokun.';
    }
  });

  socket.on('returnToLobby', () => {
    const wasRematch = !$('#gameover-modal').hidden;
    mySelectedRegion = null;
    $$('.settle-flag').forEach((f) => f.remove());
    $$('.castle-marker').forEach((m) => m.remove());
    $('#gameover-modal').hidden = true;
    const btn = $('#btn-ready');
    btn.dataset.ready = 'false';
    btn.textContent = '🛡️ Hazırım';
    showScreen('#screen-lobby');
    toast(wasRematch ? '🔄 Aynı odada yeni sefer için lobiye dönüldü.' : 'Rakibin ayrıldı, lobiye dönüldü.');
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
    state.endsAt = endsAt;
    state.duration = duration;

    $('#placement-overlay').hidden = true;
    $$('.settle-flag').forEach((f) => f.remove());
    buildCastleMarkers(players);

    $('#battle-hud-top').hidden = false;
    $('#battle-hud-bottom').hidden = false;
    $('#hud-panel-me').hidden = false;
    $('#hud-panel-opp').hidden = false;
    showScreen('#screen-world');

    renderPlayers(players);
    startClock();
    startPalaceLoop();
    $('#round-info').textContent = 'Kalene dokun, danışmanın soru sorsun!';
  });

  // Kaleleri, oyuncuların yerleştiği bölge konumlarına göre haritaya ekler
  function buildCastleMarkers(players) {
    const oppId = Object.keys(players).find((id) => id !== state.myId);
    const me = players[state.myId];
    const opp = players[oppId];
    const layer = $('#flag-layer');

    if (me) {
      const pos = REGION_POSITIONS[me.regionId] || { fx: 0.5, fy: 0.4 };
      layer.appendChild(buildMarkerEl('me', me.name, pos, true));
    }
    if (opp) {
      state.oppName = opp.name;
      const pos = REGION_POSITIONS[opp.regionId] || { fx: 0.5, fy: 0.6 };
      layer.appendChild(buildMarkerEl('opp', opp.name, pos, false));
    }

    // Saraya tıklama: yalnızca kendi kalem için (dinamik oluşturulduğu için burada bağlanır)
    const myPalaceBtn = $('#palace-btn-me');
    if (myPalaceBtn) {
      myPalaceBtn.addEventListener('click', () => {
        if (state.myAnswering) return;
        if (Date.now() < state.myCooldownUntil) return;
        socket.emit('requestQuestion', { roomCode: state.roomCode });
      });
    }
  }

  // Kale işaretçisi artık sadece ikon + isim etiketi — istatistikler sabit panellerde
  function buildMarkerEl(prefix, name, pos, isMine) {
    const marker = document.createElement('div');
    marker.id = `castle-marker-${prefix}`;
    marker.className = `castle-marker ${isMine ? 'mine' : 'theirs'}`;
    marker.style.left = `${pos.fx * 100}%`;
    marker.style.top = `${pos.fy * 100}%`;

    const palaceHtml = isMine
      ? `<button id="palace-btn-me" class="palace-btn" title="Kalene tıkla, danışmanın soru sorsun">
           <svg viewBox="0 0 64 64" class="palace-ring">
             <circle cx="32" cy="32" r="28" class="ring-bg"></circle>
             <circle cx="32" cy="32" r="28" class="ring-fg" id="me-palace-ring-fg"></circle>
           </svg>
           <span class="palace-emoji">🏰</span>
           <span class="palace-label" id="me-palace-label" hidden>Kalene Tıkla</span>
         </button>`
      : `<div class="palace-btn palace-btn-readonly" aria-hidden="true"><span class="palace-emoji">🏯</span></div>`;

    marker.innerHTML = `
      ${palaceHtml}
      <span class="castle-name-tag">${isMine ? '🔵' : '🔴'} ${escapeHtml(name)}</span>
    `;
    return marker;
  }

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
      $('#btn-raid-label').textContent = me.raidReady ? 'Saldır' : `${me.soldiers}/8`;

      $('#me-speed-tag').textContent = `⚡ ${me.speed.toFixed(2)}x`;
      if (me.cooldownUntil !== state.myCooldownUntil) {
        state.lastCooldownSpan = Math.max(1, me.cooldownUntil - Date.now());
        state.myCooldownUntil = me.cooldownUntil;
      }
      state.myAnswering = !!me.answering || !!me.inDuel;
      updatePalaceButton();
    }

    if (opp) {
      $('#opp-speed-tag').textContent = `⚡ ${opp.speed.toFixed(2)}x`;
      if (opp.inDuel) {
        $('#opp-status').textContent = `⚔️ ${state.oppName} düelloda!`;
      } else if (opp.answering) {
        $('#opp-status').textContent = `${state.oppName} bir soruyla uğraşıyor...`;
      } else if (!opp.cooldownReady) {
        $('#opp-status').textContent = 'Yavaşlamış, hazırlanıyor...';
      } else {
        $('#opp-status').textContent = 'Hazır bekliyor...';
      }
    }
  }

  function renderSide(prefix, p) {
    const maxVillagers = 60; // bar ölçeklemesi için tavan referans
    const maxSoldiers = 20;
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
      $(`#${prefix}-name`).closest('.hud-stat-panel').style.opacity = '0.5';
      const marker = $(`#castle-marker-${prefix}`);
      if (marker) marker.style.opacity = '0.4';
    }
  }

  const lastNumbers = {};
  function animateNumber(sel, value) {
    const el = $(sel);
    const prev = lastNumbers[sel];
    el.textContent = value;
    if (prev !== undefined && value < prev) {
      const panel = el.closest('.hud-stat-panel');
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
    state.duelActive = false;
    state.duelId = null;
    $('#duel-banner').hidden = true;
    $('#duel-wait-msg').hidden = true;
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

  // ==================================================================
  // Düello (Saldırı) — ikinize aynı anda aynı soru gelir
  // ==================================================================
  socket.on('duelQuestion', (q) => {
    state.currentQuestion = { id: q.duelId, timeLimit: q.timeLimit, startedAt: Date.now() };
    state.duelActive = true;
    state.duelId = q.duelId;

    $('#duel-banner').hidden = false;
    $('#duel-opponent-name').textContent = q.opponentName;
    $('#duel-wait-msg').hidden = true;
    $('#visitor-emoji').textContent = q.role === 'attacker' ? '⚔️' : '🛡️';
    $('#visitor-type').textContent = q.role === 'attacker' ? 'Saldırıyorsun!' : 'Savunuyorsun!';
    $('#visitor-category').textContent = `${q.category} · ${difficultyLabel(q.difficulty)}`;
    $('#question-text').textContent = q.question;
    $('#round-info').textContent = `⚔️ Düello! ${q.opponentName} ile aynı soruyu cevaplıyorsun.`;

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
    if (state.duelActive) {
      socket.emit('duelAnswer', {
        roomCode: state.roomCode,
        duelId: state.duelId,
        answerIndex: index,
      });
    } else {
      socket.emit('answerQuestion', {
        roomCode: state.roomCode,
        questionId: state.currentQuestion.id,
        answerIndex: index,
      });
    }
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

  // Düelloda kendi cevabımın sonucu — ama düello ancak ikisi de cevaplayınca kapanır
  socket.on('duelAnswerReceived', ({ correct, correctIndex }) => {
    clearInterval(state.questionInterval);
    const buttons = $$('.option-btn');
    buttons.forEach((b, idx) => {
      b.disabled = true;
      if (idx === correctIndex) b.classList.add('correct');
      else if (!correct) b.classList.add('wrong');
    });
    $('#duel-wait-msg').hidden = false;
    $('#round-info').textContent = correct ? '✅ Doğru bildin! Rakibin bekleniyor...' : '💀 Yanlış bildin! Rakibin bekleniyor...';
  });

  socket.on('duelResult', ({ attackerName, defenderName, success, winnerRole, winnerName, stolenVillagers, stolenSoldiers }) => {
    state.duelActive = false;
    state.duelId = null;
    state.currentQuestion = null;
    clearInterval(state.questionInterval);
    $('#question-modal').hidden = true;
    $('#duel-wait-msg').hidden = true;
    $('#round-info').textContent = 'Sarayın hazır olunca tekrar tıklayabilirsin.';

    if (!success) {
      toast(`🤝 ${attackerName} ile ${defenderName} düellosu berabere kaldı, kimse bilemedi.`);
      return;
    }
    if (winnerRole === 'attacker') {
      toast(`⚔️ ${winnerName} saldırıyı kazandı! ${stolenVillagers} kaynak${stolenSoldiers ? ` + ${stolenSoldiers} asker` : ''} çaldı.`);
    } else {
      toast(`🛡️ ${winnerName} savunmada önce bildi, saldırıyı püskürtüp karşı hamle yaptı! ${stolenVillagers} kaynak${stolenSoldiers ? ` + ${stolenSoldiers} asker` : ''} çaldı.`);
    }
  });

  // ==================================================================
  // Sabotaj / Saldırı
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

  // ==================================================================
  // Savaş günlüğü aç/kapa
  // ==================================================================
  $('#btn-log-toggle').addEventListener('click', () => {
    $('#log-scroll').hidden = !$('#log-scroll').hidden;
  });
  $('#btn-log-close').addEventListener('click', () => {
    $('#log-scroll').hidden = true;
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
    socket.emit('requestRematch', { roomCode: state.roomCode });
  });

  $('#btn-leave-room').addEventListener('click', () => {
    window.location.href = window.location.pathname;
  });

  // ---------------- Yardımcı ----------------
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
