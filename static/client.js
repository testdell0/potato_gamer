/* global io */
(function () {
  var AVATAR_COLORS = ['#e05c8c', '#4d9de0', '#e0893d', '#3dba7d', '#9b6fd4', '#c2a020'];

  function setupRoomPage(roomId, token) {
    var socket = null;        // lazy — connected only after name is submitted
    var myName = '';
    var myPlayer = null;
    var mySecret = null;      // only known locally if set this session
    var secretVisible = false;
    var timerInterval = null;
    var lastState = null;

    var el = {
      nameOverlay:       document.getElementById('nameOverlay'),
      nameInput:         document.getElementById('nameInput'),
      nameSubmitBtn:     document.getElementById('nameSubmitBtn'),
      nameError:         document.getElementById('nameError'),
      status:            document.getElementById('statusBanner'),
      modeBadge:         document.getElementById('modeBadge'),
      timerText:         document.getElementById('timerText'),
      meName:            document.getElementById('meName'),
      meTurnTag:         document.getElementById('meTurnTag'),
      secretInput:       document.getElementById('secretInput'),
      setSecretBtn:      document.getElementById('setSecretBtn'),
      resetSecretBtn:    document.getElementById('resetSecretBtn'),
      eyeBtn:            document.getElementById('eyeBtn'),
      guessInput:        document.getElementById('guessInput'),
      guessBtn:          document.getElementById('guessBtn'),
      targetLabel:       document.getElementById('targetLabel'),
      turnHint:          document.getElementById('turnHint'),
      startBtn:          document.getElementById('startBtn'),
      playersList:       document.getElementById('playersList'),
      playerCount:       document.getElementById('playerCount'),
      guessCardsRow:     document.getElementById('guessCardsRow'),
      newGameBtn:        document.getElementById('newGameBtn'),
      exitBtn:           document.getElementById('exitBtn'),
      winnerOverlay:     document.getElementById('winnerOverlay'),
      winnerText:        document.getElementById('winnerText'),
      overlayNewGame:    document.getElementById('overlayNewGame'),
      overlayExit:       document.getElementById('overlayExit'),
      exitWarningOverlay: document.getElementById('exitWarningOverlay'),
      confirmExitBtn:    document.getElementById('confirmExitBtn'),
      cancelExitBtn:     document.getElementById('cancelExitBtn'),
    };

    // Pre-fill name from room-scoped key so returning players see their name.
    var storedName = localStorage.getItem('ng_name_' + roomId) || '';
    if (storedName) el.nameInput.value = storedName;

    // ---- Exit warning (wired immediately — doesn't need socket) ----
    el.exitBtn.addEventListener('click', function () {
      el.exitWarningOverlay.classList.remove('hidden');
    });
    el.cancelExitBtn.addEventListener('click', function () {
      el.exitWarningOverlay.classList.add('hidden');
    });
    function doExit() {
      if (socket) socket.emit('leave_room', { room_id: roomId });
      window.location.href = '/';
    }
    el.confirmExitBtn.addEventListener('click', doExit);
    el.overlayExit.addEventListener('click', function () {
      el.winnerOverlay.classList.add('hidden');
      el.exitWarningOverlay.classList.remove('hidden');
    });

    // ---- Name overlay ----
    function enterRoom() {
      var name = (el.nameInput.value || '').trim();
      if (!name) {
        el.nameError.textContent = 'Please enter your name.';
        el.nameError.style.display = 'block';
        return;
      }
      myName = name;
      localStorage.setItem('ng_name_' + roomId, name);
      el.nameOverlay.classList.add('hidden');
      setStatus('Connecting…');
      connectSocket();
    }
    el.nameSubmitBtn.addEventListener('click', enterRoom);
    el.nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') enterRoom(); });

    // ---- Socket (lazy) ----
    function connectSocket() {
      socket = io();

      socket.on('connect', function () {
        socket.emit('join_room', { room_id: roomId, name: myName, token: token });
      });

      socket.on('joined', function (data) {
        myPlayer = data.player;
        if (data.token) localStorage.setItem('ng_token_' + data.room_id, data.token);
        myName = data.name || myName;
        el.meName.textContent = myName + ' (P' + data.player + ')';
        setStatus('Joined as ' + myName + '. Set your secret number.');
        wireGameButtons();
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
        setStatus('Disconnected — refresh to reconnect.');
      });
    }

    // ---- Helpers ----
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

    function avatarColor(num) {
      return AVATAR_COLORS[(num - 1) % AVATAR_COLORS.length];
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

    // ---- Rendering ----
    function render(state) {
      if (!state || !state.exists) return;

      el.modeBadge.textContent = state.mode === 'multi'
        ? 'Multiplayer • ' + state.max_players + ' max'
        : '1 v 1';
      el.playerCount.textContent = state.players.length;

      renderPlayers(state);
      renderGuessCards(state);
      renderMyControls(state);

      var allReady = state.players.length >= 2 && state.players.every(function (p) { return p.ready; });
      el.startBtn.disabled = state.started || !allReady;
      el.startBtn.classList.toggle('hidden', state.started);

      if (state.started && state.timer_start_ms) {
        startTimer(state.timer_start_ms);
      } else if (!state.started) {
        stopTimer();
        el.timerText.textContent = '00:00';
      }

      if (state.winner) {
        var w = playerByNum(state, state.winner);
        setStatus((w ? w.name : 'Player ' + state.winner) + ' wins! 🎉');
        el.newGameBtn.disabled = false;
      } else if (state.started) {
        var cur = playerByNum(state, state.current_turn);
        var who = state.current_turn === myPlayer
          ? 'Your turn'
          : (cur ? cur.name : 'Player ' + state.current_turn) + "'s turn";
        setStatus('Game on — ' + who + '.');
        el.newGameBtn.disabled = true;
      } else {
        setStatus(allReady ? 'Everyone ready — click Start Game.' : 'Waiting for all players to set numbers…');
        el.newGameBtn.disabled = true;
      }

      if (!state.started && !state.winner) hideWinner();
    }

    function renderPlayers(state) {
      el.playersList.innerHTML = '';
      state.players.forEach(function (p) {
        var target = playerByNum(state, p.target);
        var row = document.createElement('div');
        row.className = 'player-row-sm';
        if (state.started && p.num === state.current_turn) row.classList.add('active-turn');
        if (state.winner === p.num) row.classList.add('winner');
        if (!p.connected) row.classList.add('offline');

        var av = document.createElement('div');
        av.className = 'avatar-sm';
        av.textContent = initials(p.name);
        av.style.background = avatarColor(p.num);

        var info = document.createElement('div');
        info.className = 'player-info-sm';

        var nameLine = document.createElement('div');
        nameLine.className = 'player-name-sm';
        nameLine.textContent = p.name + (p.num === myPlayer ? ' ✦' : '');

        var targetLine = document.createElement('div');
        targetLine.className = 'player-target-sm muted';
        targetLine.textContent = '↬ ' + (target ? target.name : 'P' + p.target);

        info.appendChild(nameLine);
        info.appendChild(targetLine);

        var badge = document.createElement('span');
        badge.className = 'badge ' + (p.ready ? 'ok' : 'pending');
        badge.textContent = p.ready ? '✓' : '…';

        row.appendChild(av);
        row.appendChild(info);
        row.appendChild(badge);
        el.playersList.appendChild(row);
      });
    }

    function renderGuessCards(state) {
      el.guessCardsRow.innerHTML = '';

      // Group history by player num
      var byPlayer = {};
      (state.history || []).forEach(function (h) {
        if (!byPlayer[h.player]) byPlayer[h.player] = [];
        byPlayer[h.player].push(h);
      });

      state.players.forEach(function (p) {
        var target = playerByNum(state, p.target);
        var card = document.createElement('div');
        card.className = 'guess-card';
        if (p.num === myPlayer) card.classList.add('mine-card');
        if (state.started && p.num === state.current_turn && !state.winner) card.classList.add('active-card');

        // Header
        var header = document.createElement('div');
        header.className = 'guess-card-header';

        var av = document.createElement('div');
        av.className = 'avatar-sm';
        av.textContent = initials(p.name);
        av.style.background = avatarColor(p.num);

        var titleWrap = document.createElement('div');
        titleWrap.className = 'guess-card-title';

        var nameEl = document.createElement('div');
        nameEl.className = 'player-name-sm';
        nameEl.textContent = p.name + (p.num === myPlayer ? ' (you)' : '');

        var tEl = document.createElement('div');
        tEl.className = 'muted';
        tEl.style.fontSize = '0.78rem';
        tEl.textContent = '↬ ' + (target ? target.name : 'P' + p.target);

        titleWrap.appendChild(nameEl);
        titleWrap.appendChild(tEl);
        header.appendChild(av);
        header.appendChild(titleWrap);
        card.appendChild(header);

        var guesses = byPlayer[p.num] || [];
        if (guesses.length === 0) {
          var empty = document.createElement('p');
          empty.className = 'muted';
          empty.style.cssText = 'font-size:0.82rem; margin-top:10px; margin-bottom:0;';
          empty.textContent = 'No guesses yet';
          card.appendChild(empty);
        } else {
          var tbl = document.createElement('table');
          var thead = document.createElement('thead');
          var hrow = document.createElement('tr');
          ['#', 'Guess', 'Result'].forEach(function (h) {
            var th = document.createElement('th');
            th.textContent = h;
            hrow.appendChild(th);
          });
          thead.appendChild(hrow);
          tbl.appendChild(thead);

          var tbody = document.createElement('tbody');
          guesses.forEach(function (g, i) {
            var tr = document.createElement('tr');
            if (g.outcome && g.outcome.includes('🎉')) tr.classList.add('win-row');
            [String(i + 1), g.guess, g.outcome].forEach(function (c) {
              var td = document.createElement('td');
              td.textContent = c;
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          tbl.appendChild(tbody);
          card.appendChild(tbl);
        }

        el.guessCardsRow.appendChild(card);
      });
    }

    function renderMyControls(state) {
      var me = myPlayer ? playerByNum(state, myPlayer) : null;
      el.meName.textContent = me ? (me.name + ' (P' + me.num + ')') : (myName || '—');

      var iAmReady = !!(me && me.ready);

      // Secret field — server truth (iAmReady) drives the visual state.
      // If rejoining with secret already set (mySecret=null), still show locked state.
      if (iAmReady) {
        el.secretInput.disabled = true;
        el.secretInput.value = (secretVisible && mySecret) ? mySecret : '••••';
        el.setSecretBtn.classList.add('hidden');
        el.resetSecretBtn.classList.remove('hidden');
        // Eye only available when we have the local value (not when reconnected with pre-set secret)
        el.eyeBtn.classList.toggle('hidden', !mySecret);
      } else {
        el.secretInput.disabled = false;
        if (!mySecret) el.secretInput.value = '';
        el.setSecretBtn.classList.remove('hidden');
        el.resetSecretBtn.classList.add('hidden');
        el.eyeBtn.classList.add('hidden');
        secretVisible = false;
      }

      // No changes to secret after game starts
      el.setSecretBtn.disabled = iAmReady || state.started;
      el.resetSecretBtn.disabled = !iAmReady || state.started;

      // Target label
      if (me && me.target) {
        var t = playerByNum(state, me.target);
        el.targetLabel.textContent = t ? t.name : ('Player ' + me.target);
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
        el.turnHint.textContent = 'Your turn — guess your target\'s number!';
      } else {
        var cur = playerByNum(state, state.current_turn);
        el.turnHint.textContent = 'Waiting for ' + (cur ? cur.name : 'Player ' + state.current_turn) + '…';
      }
    }

    function showWinner(winnerNum) {
      var name = 'Player ' + winnerNum;
      if (lastState) { var w = playerByNum(lastState, winnerNum); if (w) name = w.name; }
      el.winnerText.textContent = (winnerNum === myPlayer ? 'You win!' : name + ' wins!') + ' 🎉';
      el.winnerOverlay.classList.remove('hidden');
    }

    function hideWinner() {
      el.winnerOverlay.classList.add('hidden');
    }

    // ---- Game buttons (wired after joined — need socket + myPlayer) ----
    var buttonsWired = false;
    function wireGameButtons() {
      if (buttonsWired) return;
      buttonsWired = true;

      el.setSecretBtn.addEventListener('click', function () {
        var val = (el.secretInput.value || '').trim();
        if (!isValidFourDigit(val)) { setStatus('Enter a valid 4-digit number (1000–9999).'); return; }
        mySecret = val;
        secretVisible = false;
        socket.emit('set_secret', { room_id: roomId, secret: val });
      });

      el.resetSecretBtn.addEventListener('click', function () {
        socket.emit('reset_secret', { room_id: roomId });
        mySecret = null;
        secretVisible = false;
      });

      el.eyeBtn.addEventListener('click', function () {
        if (!mySecret) return;
        secretVisible = !secretVisible;
        el.secretInput.value = secretVisible ? mySecret : '••••';
      });

      el.secretInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') el.setSecretBtn.click();
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

      function doNewGame() {
        socket.emit('new_game', { room_id: roomId });
        mySecret = null;
        secretVisible = false;
        hideWinner();
        stopTimer();
        el.timerText.textContent = '00:00';
      }
      el.newGameBtn.addEventListener('click', doNewGame);
      el.overlayNewGame.addEventListener('click', doNewGame);
    }
  }

  window.setupRoomPage = setupRoomPage;
})();
