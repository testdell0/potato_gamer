/* global io */
(function () {
  function setupRoomPage(roomId, desiredPlayer, token) {
    console.log('Setting up room page:', { roomId, desiredPlayer, token: token ? '***' : 'none' });

    const socket = io();
    let myPlayer = null;
    let mySecret = { 1: null, 2: null };
    let timerInterval = null;

    const el = {
      status: document.getElementById('statusBanner'),
      startBtn: document.getElementById('startBtn'),
      exitBtn: document.getElementById('exitBtn'),
      newGameBtn: document.getElementById('newGameBtn'),
      timerText: document.getElementById('timerText'),
      p1SecretInput: document.getElementById('p1Secret'),
      p1Set: document.getElementById('p1Set'),
      p1ShowHide: document.getElementById('p1ShowHide'),
      p1ResetSecret: document.getElementById('p1ResetSecret'),
      p1SecretDisplay: document.getElementById('p1SecretDisplay'),
      p1Guess: document.getElementById('p1Guess'),
      p1Submit: document.getElementById('p1Submit'),
      p1History: document.getElementById('p1History'),
      p1Card: document.getElementById('p1Card'),
      p1GuessCard: document.getElementById('p1GuessCard'),
      p2SecretInput: document.getElementById('p2Secret'),
      p2Set: document.getElementById('p2Set'),
      p2ShowHide: document.getElementById('p2ShowHide'),
      p2ResetSecret: document.getElementById('p2ResetSecret'),
      p2SecretDisplay: document.getElementById('p2SecretDisplay'),
      p2Guess: document.getElementById('p2Guess'),
      p2Submit: document.getElementById('p2Submit'),
      p2History: document.getElementById('p2History'),
      p2Card: document.getElementById('p2Card'),
      p2GuessCard: document.getElementById('p2GuessCard')
    };

    // Utility functions
    function isValidFourDigit(n) {
      return /^\d{4}$/.test(n) && +n >= 1000 && +n <= 9999;
    }

    function formatTimer(ms) {
      if (!ms) return '00:00';
      const delta = Math.max(0, Date.now() - ms);
      const s = Math.floor(delta / 1000);
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    function startLocalTimer(ms) {
      if (timerInterval) clearInterval(timerInterval);
      el.timerText.textContent = formatTimer(ms);
      timerInterval = setInterval(() => {
        el.timerText.textContent = formatTimer(ms);
      }, 1000);
    }

    function stopLocalTimer() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      el.timerText.textContent = '00:00';
    }

    // Socket event handlers
    socket.on('connect', function () {
      console.log('Socket connected, joining room...');
      socket.emit('join_room', { room_id: roomId, player: desiredPlayer, token });
    });

    socket.on('joined', function (data) {
      console.log('Joined successfully:', data);
      myPlayer = data.player;
      if (data.token) localStorage.setItem('ng_token_' + data.room_id, data.token);
      el.status.textContent = 'Joined as Player ' + data.player + '. Set your number.';
      gateUIForRole(data.player);
      enforceInputState(false);
    });

    socket.on('error', function (data) {
      console.error('Socket error:', data);
      alert((data && data.message) || 'Error');
    });

    socket.on('system', function (data) {
      console.log('System message:', data.message);
      el.status.textContent = data.message;
    });

    socket.on('state', function (state) {
      console.log('State update:', state);
      const ready = state.readiness && state.readiness.p1_set && state.readiness.p2_set;
      el.startBtn.disabled = !ready || state.started;

      if (state.started) {
        el.status.textContent = 'Game started. Player ' + state.current_turn + '\'s turn.';
        enforceInputState(true, state.current_turn, state.finished);
        if (state.timer_start_ms) startLocalTimer(state.timer_start_ms);
      } else {
        el.status.textContent = ready ? 'Both numbers set. Click Start Game.' : 'Waiting for both players to set numbers.';
        enforceInputState(false);
      }

      if (state.history) {
        renderHistory(el.p1History, state.history[1] || []);
        renderHistory(el.p2History, state.history[2] || []);
      }
    });

    socket.on('secret_ack', function (data) {
      console.log('Secret acknowledged for player:', data.player);
    });

    socket.on('game_started', function (data) {
      console.log('Game started:', data);
      el.status.textContent = 'Game started. Player ' + data.current_turn + '\'s turn.';
      if (data.timer_start_ms) startLocalTimer(data.timer_start_ms);
    });

    socket.on('turn', function (data) {
      console.log('Turn changed:', data);
      el.status.textContent = 'Player ' + data.current_turn + '\'s turn.';
      enforceInputState(true, data.current_turn);
    });

    socket.on('guess_result', function (data) {
      console.log('Guess result:', data);
      if (data.player === 1) addHistoryRow(el.p1History, data.guess, data.outcome);
      if (data.player === 2) addHistoryRow(el.p2History, data.guess, data.outcome);
    });

    socket.on('game_over', function (data) {
      console.log('Game over:', data);
      el.status.textContent = 'Player ' + data.winner + ' wins! ' + data.message;
      enforceInputState(false);
      stopLocalTimer();
      el.newGameBtn.disabled = false;
    });

    socket.on('disconnect', function () {
      console.log('Socket disconnected');
      el.status.textContent = 'Disconnected from server. Refresh to reconnect.';
    });

    // Secret handlers
    el.p1Set.addEventListener('click', function () {
      const val = (el.p1SecretInput.value || '').trim();
      if (!isValidFourDigit(val)) {
        alert('Enter a valid 4-digit number (1000–9999).');
        return;
      }
      mySecret[1] = val;
      el.p1SecretDisplay.textContent = '•••• (hidden)';
      el.p1SecretInput.disabled = true;
      el.p1Set.disabled = true;
      el.p1ResetSecret.disabled = false;
      console.log('Setting secret for player 1');
      socket.emit('set_secret', { room_id: roomId, player: 1, secret: val });
    });

    el.p2Set.addEventListener('click', function () {
      const val = (el.p2SecretInput.value || '').trim();
      if (!isValidFourDigit(val)) {
        alert('Enter a valid 4-digit number (1000–9999).');
        return;
      }
      mySecret[2] = val;
      el.p2SecretDisplay.textContent = '•••• (hidden)';
      el.p2SecretInput.disabled = true;
      el.p2Set.disabled = true;
      el.p2ResetSecret.disabled = false;
      console.log('Setting secret for player 2');
      socket.emit('set_secret', { room_id: roomId, player: 2, secret: val });
    });

    el.p1ResetSecret.addEventListener('click', function () {
      console.log('Resetting secret for player 1');
      socket.emit('reset_secret', { room_id: roomId, player: 1 });
      mySecret[1] = null;
      el.p1SecretDisplay.textContent = '—';
      el.p1SecretInput.disabled = false;
      el.p1Set.disabled = false;
      el.p1ResetSecret.disabled = true;
      el.p1SecretInput.value = '';
    });

    el.p2ResetSecret.addEventListener('click', function () {
      console.log('Resetting secret for player 2');
      socket.emit('reset_secret', { room_id: roomId, player: 2 });
      mySecret[2] = null;
      el.p2SecretDisplay.textContent = '—';
      el.p2SecretInput.disabled = false;
      el.p2Set.disabled = false;
      el.p2ResetSecret.disabled = true;
      el.p2SecretInput.value = '';
    });

    el.p1ShowHide.addEventListener('click', function () {
      if (mySecret[1] === null) return;
      var v = el.p1SecretDisplay.dataset.visible === 'true';
      if (!v) {
        el.p1SecretDisplay.textContent = mySecret[1];
        el.p1SecretDisplay.dataset.visible = 'true';
      } else {
        el.p1SecretDisplay.textContent = '•••• (hidden)';
        el.p1SecretDisplay.dataset.visible = 'false';
      }
    });

    el.p2ShowHide.addEventListener('click', function () {
      if (mySecret[2] === null) return;
      var v = el.p2SecretDisplay.dataset.visible === 'true';
      if (!v) {
        el.p2SecretDisplay.textContent = mySecret[2];
        el.p2SecretDisplay.dataset.visible = 'true';
      } else {
        el.p2SecretDisplay.textContent = '•••• (hidden)';
        el.p2SecretDisplay.dataset.visible = 'false';
      }
    });

    el.startBtn.addEventListener('click', function () {
      console.log('Starting game');
      socket.emit('start_game', { room_id: roomId });
    });

    // Guess handlers
    el.p1Submit.addEventListener('click', function () {
      const val = (el.p1Guess.value || '').trim();
      if (!isValidFourDigit(val)) {
        alert('Enter a valid 4-digit number (1000–9999).');
        return;
      }
      console.log('Player 1 submitting guess:', val);
      socket.emit('submit_guess', { room_id: roomId, player: 1, guess: val });
      el.p1Guess.value = '';
    });

    el.p2Submit.addEventListener('click', function () {
      const val = (el.p2Guess.value || '').trim();
      if (!isValidFourDigit(val)) {
        alert('Enter a valid 4-digit number (1000–9999).');
        return;
      }
      console.log('Player 2 submitting guess:', val);
      socket.emit('submit_guess', { room_id: roomId, player: 2, guess: val });
      el.p2Guess.value = '';
    });

    el.exitBtn.addEventListener('click', function () {
      if (myPlayer) {
        socket.emit('leave_room', { room_id: roomId, player: myPlayer });
      }
      window.location.href = '/';
    });

    el.newGameBtn.addEventListener('click', function () {
      console.log('Starting new game');
      socket.emit('new_game', { room_id: roomId });
      stopLocalTimer();
      el.newGameBtn.disabled = true;
    });

    // UI helper functions
    function enforceInputState(enable, currentTurn, finished) {
      finished = finished || { 1: false, 2: false };
      var p1Active = !!(enable && currentTurn === 1 && !finished[1]);
      var p2Active = !!(enable && currentTurn === 2 && !finished[2]);
      el.p1Guess.disabled = !p1Active;
      el.p1Submit.disabled = !p1Active;
      el.p2Guess.disabled = !p2Active;
      el.p2Submit.disabled = !p2Active;
    }

    function renderHistory(tbody, items) {
      tbody.innerHTML = '';
      items.forEach(function (it, idx) {
        addHistoryRow(tbody, it.guess, it.outcome, idx + 1);
      });
    }

    function addHistoryRow(tbody, guess, outcome, idx) {
      var tr = document.createElement('tr');
      var n = idx || (tbody.children.length + 1);
      tr.innerHTML = '<td>' + n + '</td><td>' + guess + '</td><td>' + outcome + '</td>';
      tbody.appendChild(tr);
    }

    function gateUIForRole(player) {
      console.log('Gating UI for player:', player);
      if (player === 1) {
        el.p2Card.classList.add('hidden');
      }
      if (player === 2) {
        el.p1Card.classList.add('hidden');
      }
    }
  }

  window.setupRoomPage = setupRoomPage;
  console.log('client.js loaded, setupRoomPage available');
})();