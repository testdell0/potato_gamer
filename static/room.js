
(function(){
  function boot(){
    var roomRoot = document.getElementById('roomRoot');
    if(!roomRoot){ console.error('Room root not found.'); return; }
    var roomId = roomRoot.dataset.roomId;
    var params = new URLSearchParams(window.location.search);
    var desired = parseInt(params.get('as') || '0', 10);
    if(!roomId || (desired !== 1 && desired !== 2)){ console.error('Missing roomId or desired role.'); return; }
    var token = localStorage.getItem('ng_token_' + roomId) || '';

    if (typeof window.setupRoomPage !== 'function') {
      console.error('setupRoomPage is not defined; attempting to load client.js dynamically');
      var s = document.createElement('script');
      s.src = '/static/client.js'; s.defer = true;
      s.onload = function(){ window.setupRoomPage(roomId, desired, token); };
      s.onerror = function(){ alert('Failed to load client.js. Check static path.'); };
      document.head.appendChild(s);
      return;
    }
    window.setupRoomPage(roomId, desired, token);
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
