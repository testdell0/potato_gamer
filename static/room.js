(function () {
  function boot() {
    var roomRoot = document.getElementById('roomRoot');
    if (!roomRoot) { console.error('Room root not found.'); return; }
    var roomId = roomRoot.dataset.roomId;
    if (!roomId) { console.error('Missing roomId.'); return; }

    var name = localStorage.getItem('ng_name') || '';
    var token = localStorage.getItem('ng_token_' + roomId) || '';

    if (typeof window.setupRoomPage !== 'function') {
      console.error('setupRoomPage is not defined.');
      return;
    }
    window.setupRoomPage(roomId, name, token);
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
