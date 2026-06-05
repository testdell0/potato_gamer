
/* global io */
(function(){
  const socket = io();
  const createBtn = document.getElementById('createRoomBtn');
  const createResult = document.getElementById('createResult');
  const joinBtn = document.getElementById('joinRoomBtn');
  const joinResult = document.getElementById('joinResult');

  createBtn.addEventListener('click', function(){ socket.emit('create_room', {}); });
  socket.on('room_created', function({room_id}){
    createResult.textContent = 'Room created: ' + room_id + '. Redirecting...';
    window.location.href = '/room/' + room_id + '?as=1';
  });

  joinBtn.addEventListener('click', function(){
    const code = (document.getElementById('roomCode').value || '').trim().toUpperCase();
    if(!code){ joinResult.textContent = 'Enter a room code.'; return; }
    window.location.href = '/room/' + code + '?as=2';
  });
})();
