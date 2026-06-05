(function () {
  function boot() {
    var roomRoot = document.getElementById('roomRoot');
    if (!roomRoot) { console.error('Room root not found.'); return; }
    var roomId = roomRoot.dataset.roomId;
    if (!roomId) { console.error('Missing roomId.'); return; }
    var token = localStorage.getItem('ng_token_' + roomId) || '';

    if (typeof window.setupRoomPage !== 'function') {
      console.error('setupRoomPage not defined.');
      return;
    }
    // Name is captured inside the room page overlay — no name argument here.
    window.setupRoomPage(roomId, token);
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
