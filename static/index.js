/* global io */
(function () {
  var socket = io();
  var selectedMode = '1v1';

  var createBtn = document.getElementById('createRoomBtn');
  var createResult = document.getElementById('createResult');
  var createName = document.getElementById('createName');
  var joinBtn = document.getElementById('joinRoomBtn');
  var joinResult = document.getElementById('joinResult');
  var joinName = document.getElementById('joinName');
  var roomCode = document.getElementById('roomCode');
  var modeOptions = document.querySelectorAll('.mode-option');

  function show(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
  }

  modeOptions.forEach(function (opt) {
    opt.addEventListener('click', function () {
      modeOptions.forEach(function (o) { o.classList.remove('active'); });
      opt.classList.add('active');
      selectedMode = opt.dataset.mode;
    });
  });

  createBtn.addEventListener('click', function () {
    var name = (createName.value || '').trim();
    if (!name) { show(createResult, 'Enter your name first.'); return; }
    localStorage.setItem('ng_name', name);
    createBtn.disabled = true;
    socket.emit('create_room', { mode: selectedMode });
  });

  socket.on('room_created', function (data) {
    show(createResult, 'Room created: ' + data.room_id + '. Redirecting…');
    window.location.href = '/room/' + data.room_id;
  });

  joinBtn.addEventListener('click', function () {
    var name = (joinName.value || '').trim();
    var code = (roomCode.value || '').trim().toUpperCase();
    if (!name) { show(joinResult, 'Enter your name first.'); return; }
    if (!code) { show(joinResult, 'Enter a room code.'); return; }
    localStorage.setItem('ng_name', name);
    window.location.href = '/room/' + code;
  });

  roomCode.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinBtn.click();
  });
})();
