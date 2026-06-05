/* global io */
(function () {
  function setupRoomPage(roomId, myName, token) {
    var socket = io();
    var myPlayer = null;          // my player_num once joined
    var mySecret = null;          // my secret (kept client-side only)
    var secretVisible = false;
    var timerInterval = null;
    var lastState = null;

    var el = {
      status: document.getElementById('statusBanner'),
      modeBadge: document.getElementById('modeBadge'),
      timerText: document.getElementById('timerText'),
      meName: document.getElementById('meName'),
      meTurnTag: document.getElementById('meTurnTag'),
      secretInput: document.getElementById('secretInput'),
      setSecretBtn: document.getElementById('setSecretBtn'),
      secretDisplay: document.getElementById('secretDisplay'),
      showHideBtn: document.getElementById('showHideBtn'),
      resetSecretBtn: document.getElementById('resetSecretBtn'),
      guessInput: document.getElementById('guessInput'),
      guessBtn: document.getElementById('guessBtn'),
      targetLabel: document.getElementById('targetLabel'),
      turnHint: document.getElementById('turnHint'),
      startBtn: document.getElementById('startBtn'),
      playersList: document.getElementById('playersList'),
      playerCount: document.getElementById('playerCount'),
      historyBody: document.getElementById('historyBody'),
      newGameBtn: document.getElementById('newGameBtn'),
      exitBtn: document.getElementById('exitBtn'),
      winnerOverlay: document.getElementById('winnerOverlay'),
      winnerText: document.getElementById('winnerText'),
      overlayNewGame: document.getElementById('overlayNewGame'),
      overlayExit: document.getElementById('overlayExit'),
    };

    // ---------- helpers ----------
    function setStatus(msg) {
      el.status.textContent = msg;
      el.status.classList.add('show');
    }

    function isValidFourDigit(n) {
      return /^\d{4}$/.test(n) && +n >= 1000 && +n <= 9999;
    }

    function initials(name) {
      var parts = (name || '?').trim().split(/\s+/);
      var s = parts[0][0] || '?';
      if (parts.length > 1) s += parts[parts.length - 1][0];
      return s.toUpperCase();
    }

    function playerByNum(state, num) {
      if (!state || !state.players) return null;
      for (var i = 0; i < state.players.length; i++) {
        if (state.players[i].num === num) return state.players[i];
      }
      return null;
    }

    function formatTimer(ms) {
      if (!ms) return '00:00';
      var s = Math.floor(Math.max(0, Date.now() - ms) / 1000);
      var m = Math.floor(s / 60);
      return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }

    function startTimer(ms) {
      if (timerInterval) clearInterval(timerInterval);
      el.timerText.textContent = formatTimer(ms);
      timerInterval = setInterval(function () { el.timerText.textContent = formatTimer(ms); }, 1000);
    }

    function stopTimer() {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    // ---------- socket lifecycle ----------
    socket.on('connect', function () {
      socket.emit('join_room', { room_id: roomId, name: myName, token: token });
    });

    socket.on('joined', function (data) {
      myPlayer = data.player;
      if (data.token) localStorage.setItem('ng_token_' + data.room_id, data.token);
      if (data.name) {
        myName = data.name;
        el.meName.textContent = data.name + ' (P' + data.player + ')';
      }
      setStatus('Joined as ' + (data.name || ('Player ' + data.player)) + '. Set your secret number.');
    });

    socket.on('error', function (data) {
      setStatus((data && data.message) || 'Error');
    });

    socket.on('system', function (data) {
      if (data && data.message) setStatus(data.message);
    });

    socket.on('state', function (state) {
      lastState = state;
      render(state);
    });

    socket.on('game_started', function (data) {
      if (data.timer_start_ms) startTimer(data.timer_start_ms);
    });

    socket.on('game_over', function (data) {
      stopTimer();
      showWinner(data.winner);
    });

    socket.on('disconnect', function () {
      setStatus('Disconnected from server. Refresh to reconnect.');
    });

    // ---------- rendering ----------
    function render(state) {
      if (!state || !state.exists) return;

      el.modeBadge.textContent = state.mode === 'multi' ? 'Multiplayer • up to ' + state.max_players : '1 v 1';
      el.playerCount.textContent = state.players.length;

      renderPlayers(state);
      renderHistory(state.history);
      renderMyControls(state);

      // Start button: host-agnostic, anyone can start when conditions met.
      var allReady = state.players.length >= 2 && state.players.every(function (p) { return p.ready; });
      el.startBtn.disabled = state.started || !allReady;
      el.startBtn.classList.toggle('hidden', state.started);

      // Timer
      if (state.started && state.timer_start_ms) {
        startTimer(state.timer_start_ms);
      } else if (!state.started) {
        stopTimer();
        el.timerText.textContent = '00:00';
      }

      // Status text
      if (state.winner) {
        var w = playerByNum(state, state.winner);
        setStatus((w ? w.name : ('Player ' + state.winner)) + ' wins! 🎉');
        el.newGameBtn.disabled = false;
      } else if (state.started) {
        var cur = playerByNum(state, state.current_turn);
        var who = state.current_turn === myPlayer ? 'Your turn' : ((cur ? cur.name : 'Player ' + state.current_turn) + "'s turn");
        setStatus('Game on — ' + who + '.');
        el.newGameBtn.disabled = true;
      } else {
        setStatus(allReady ? 'Everyone is ready. Click Start Game.' : 'Waiting for all players to set their numbers…');
        el.newGameBtn.disabled = true;
      }

      if (!state.started && !state.winner) hideWinner();
    }

    function renderPlayers(state) {
      el.playersList.innerHTML = '';
      state.players.forEach(function (p) {
        var target = playerByNum(state, p.target);
        var card = document.createElement('div');
        card.className = 'player-row';
        if (state.started && p.num === state.current_turn) card.classList.add('active-turn');
        if (state.winner === p.num) card.classList.add('winner');
        if (!p.connected) card.classList.add('offline');

        var avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = initials(p.name);

        var info = document.createElement('div');
        info.className = 'player-info';

        var nameLine = document.createElement('div');
        nameLine.className = 'player-name';
        nameLine.textContent = p.name + (p.num === myPlayer ? ' (you)' : '');

        var sub = document.createElement('div');
        sub.className = 'player-sub muted';
        var targetName = target ? target.name : ('Player ' + p.target);
        sub.textContent = '→ targets ' + targetName;

        info.appendChild(nameLine);
        info.appendChild(sub);

        var badges = document.createElement('div');
        badges.className = 'player-badges';
        var readyBadge = document.createElement('span');
        readyBadge.className = 'badge ' + (p.ready ? 'ok' : 'pending');
        readyBadge.textContent = p.ready ? 'Ready' : 'Not set';
        badges.appendChild(readyBadge);
        if (!p.connected) {
          var off = document.createElement('span');
          off.className = 'badge pending';
          off.textContent = 'Offline';
          badges.appendChild(off);
        }

        card.appendChild(avatar);
        card.appendChild(info);
        card.appendChild(badges);
        el.playersList.appendChild(card);
      });
    }

    function renderHistory(history) {
      el.historyBody.innerHTML = '';
      (history || []).forEach(function (h, i) {
        var tr = document.createElement('tr');
        if (myPlayer && h.player === myPlayer) tr.classList.add('mine');
        var cells = [String(i + 1), h.player_name, h.target_name, h.guess, h.outcome];
        cells.forEach(function (c) {
          var td = document.createElement('td');
          td.textContent = c;       // textContent → names are HTML-safe
          tr.appendChild(td);
        });
        el.historyBody.appendChild(tr);
      });
    }

    function renderMyControls(state) {
      var me = myPlayer ? playerByNum(state, myPlayer) : null;
      el.meName.textContent = me ? (me.name + ' (P' + me.num + ')') : (myName || '—');

      var iAmReady = me && me.ready;

      // Secret controls (only before start)
      el.secretInput.disabled = state.started || iAmReady;
      el.setSecretBtn.disabled = state.started || iAmReady;
      el.resetSecretBtn.disabled = state.started || !iAmReady;
      el.showHideBtn.disabled = !mySecret;
      if (iAmReady && mySecret && !secretVisible) {
        el.secretDisplay.textContent = '•••• (hidden)';
      } else if (!iAmReady) {
        el.secretDisplay.textContent = '—';
      }

      // Target label
      if (me && me.target) {
        var t = playerByNum(state, me.target);
        el.targetLabel.textContent = t ? t.name : ('Player ' + me.target);
      } else {
        el.targetLabel.textContent = 'your target';
      }

      // Guess controls
      var myTurn = state.started && !state.winner && state.current_turn === myPlayer;
      el.guessInput.disabled = !myTurn;
      el.guessBtn.disabled = !myTurn;
      el.meTurnTag.classList.toggle('hidden', !myTurn);

      if (state.winner) {
        el.turnHint.textContent = 'Game over.';
      } else if (!state.started) {
        el.turnHint.textContent = 'Waiting for the game to start…';
      } else if (myTurn) {
        el.turnHint.textContent = 'It\'s your turn — guess your target\'s number!';
      } else {
        var cur = playerByNum(state, state.current_turn);
        el.turnHint.textContent = 'Waiting for ' + (cur ? cur.name : 'Player ' + state.current_turn) + '…';
      }
    }

    function showWinner(winnerNum) {
      var name = 'Player ' + winnerNum;
      if (lastState) { var w = playerByNum(lastState, winnerNum); if (w) name = w.name; }
      el.winnerText.textContent = (winnerNum === myPlayer ? 'You win! ' : name + ' wins!') + ' 🎉';
      el.winnerOverlay.classList.remove('hidden');
    }

    function hideWinner() {
      el.winnerOverlay.classList.add('hidden');
    }

    // ---------- user actions ----------
    el.setSecretBtn.addEventListener('click', function () {
      var val = (el.secretInput.value || '').trim();
      if (!isValidFourDigit(val)) { setStatus('Enter a valid 4-digit number (1000–9999).'); return; }
      mySecret = val;
      secretVisible = false;
      el.secretDisplay.textContent = '•••• (hidden)';
      socket.emit('set_secret', { room_id: roomId, secret: val });
    });

    el.resetSecretBtn.addEventListener('click', function () {
      socket.emit('reset_secret', { room_id: roomId });
      mySecret = null;
      secretVisible = false;
      el.secretInput.value = '';
      el.secretDisplay.textContent = '—';
    });

    el.showHideBtn.addEventListener('click', function () {
      if (!mySecret) return;
      secretVisible = !secretVisible;
      el.secretDisplay.textContent = secretVisible ? mySecret : '•••• (hidden)';
    });

    el.startBtn.addEventListener('click', function () {
      socket.emit('start_game', { room_id: roomId });
    });

    function submitGuess() {
      var val = (el.guessInput.value || '').trim();
      if (!isValidFourDigit(val)) { setStatus('Enter a valid 4-digit number (1000–9999).'); return; }
      socket.emit('submit_guess', { room_id: roomId, guess: val });
      el.guessInput.value = '';
    }
    el.guessBtn.addEventListener('click', submitGuess);
    el.guessInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitGuess(); });
    el.secretInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') el.setSecretBtn.click(); });

    function doNewGame() {
      socket.emit('new_game', { room_id: roomId });
      mySecret = null;
      secretVisible = false;
      el.secretInput.value = '';
      el.secretDisplay.textContent = '—';
      hideWinner();
      stopTimer();
      el.timerText.textContent = '00:00';
    }
    el.newGameBtn.addEventListener('click', doNewGame);
    el.overlayNewGame.addEventListener('click', doNewGame);

    function doExit() {
      socket.emit('leave_room', { room_id: roomId });
      window.location.href = '/';
    }
    el.exitBtn.addEventListener('click', doExit);
    el.overlayExit.addEventListener('click', doExit);
  }

  window.setupRoomPage = setupRoomPage;
})();
