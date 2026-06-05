import os
import random
import string
import sqlite3
import time
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, redirect, url_for, abort
from flask_socketio import SocketIO, join_room, emit, leave_room

DB_PATH = os.environ.get('DB_PATH', 'game.db')
ADMIN_KEY = os.environ.get('ADMIN_KEY', 'changeme')

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# FIXED: Use threading mode instead of eventlet, added debug logging
socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False, async_mode='threading')

# ---------- SQLite ----------
def db_connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    print("Initializing database...")
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS rooms (
            room_id TEXT PRIMARY KEY,
            created_at TEXT,
            started INTEGER DEFAULT 0,
            current_turn INTEGER DEFAULT 1,
            timer_start_ms INTEGER DEFAULT NULL
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS players (
            room_id TEXT,
            player_num INTEGER,
            token TEXT,
            last_seen TEXT,
            PRIMARY KEY (room_id, player_num)
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS secrets (
            room_id TEXT,
            player_num INTEGER,
            secret TEXT,
            PRIMARY KEY (room_id, player_num)
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS history (
            room_id TEXT,
            player_num INTEGER,
            idx INTEGER,
            guess TEXT,
            outcome TEXT,
            ts TEXT,
            PRIMARY KEY (room_id, player_num, idx)
        )
    ''')
    conn.commit()
    conn.close()
    print("Database initialized successfully")

init_db()

rooms_runtime = {}

def gen_room_code(length=6):
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))

def gen_token(length=32):
    return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(length))

def count_matches(guess: str, secret: str) -> int:
    return sum(1 for i in range(4) if guess[i] == secret[i])

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/room/<room_id>')
def room(room_id):
    return render_template('room.html', room_id=room_id)

# Admin routes

def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        key = request.args.get('key') or request.headers.get('X-Admin-Key')
        if key != ADMIN_KEY:
            abort(403)
        return f(*args, **kwargs)
    return wrapper

@app.route('/admin')
@admin_required
def admin():
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('''
      SELECT r.room_id, r.created_at, r.started, r.current_turn,
             (SELECT COUNT(*) FROM secrets s WHERE s.room_id=r.room_id) AS secrets_set,
             (SELECT COUNT(*) FROM history h WHERE h.room_id=r.room_id) AS guesses,
             (SELECT GROUP_CONCAT(p.player_num || ':' || COALESCE(p.token,'')) FROM players p WHERE p.room_id=r.room_id) AS players
      FROM rooms r ORDER BY r.created_at DESC
    ''')
    rows = cur.fetchall()
    conn.close()
    return render_template('admin.html', rows=rows)

@app.route('/admin/kill/<room_id>')
@admin_required
def admin_kill(room_id):
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('DELETE FROM secrets WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM history WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM players WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM rooms WHERE room_id=?', (room_id,))
    conn.commit()
    conn.close()
    rooms_runtime.pop(room_id, None)
    return redirect(url_for('admin', key=ADMIN_KEY))

@app.route('/admin/reset/<room_id>')
@admin_required
def admin_reset(room_id):
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('DELETE FROM secrets WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM history WHERE room_id=?', (room_id,))
    cur.execute('UPDATE rooms SET started=0, current_turn=1, timer_start_ms=NULL WHERE room_id=?', (room_id,))
    conn.commit()
    conn.close()
    rooms_runtime.setdefault(room_id, {'players': {1: None, 2: None}, 'finished': {1: False, 2: False}})
    rooms_runtime[room_id]['finished'] = {1: False, 2: False}
    return redirect(url_for('admin', key=ADMIN_KEY))

# SocketIO events

@socketio.on('connect')
def on_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def on_disconnect():
    print(f"Client disconnected: {request.sid}")
    sid = request.sid
    for room_id, rt in list(rooms_runtime.items()):
        changed = False
        for p in (1, 2):
            if rt['players'].get(p) == sid:
                rt['players'][p] = None
                changed = True
        if changed:
            emit('system', {'message': 'A player disconnected.'}, room=room_id)
            emit('state', public_state(room_id), room=room_id)

@socketio.on('create_room')
def on_create_room(_data):
    room_id = gen_room_code()
    print(f"Creating room: {room_id}")
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('INSERT OR REPLACE INTO rooms(room_id, created_at, started, current_turn, timer_start_ms) VALUES(?,?,?,?,?)',
                (room_id, datetime.utcnow().isoformat(), 0, 1, None))
    conn.commit()
    conn.close()
    rooms_runtime[room_id] = {'players': {1: None, 2: None}, 'finished': {1: False, 2: False}}
    emit('room_created', {'room_id': room_id})
    print(f"Room created: {room_id}")

@socketio.on('join_room')
def on_join_room(data):
    room_id = (data.get('room_id') or '').upper()
    desired_player = int(data.get('player', 0))
    token = data.get('token') or ''
    
    print(f"Join room request: room={room_id}, player={desired_player}, token={'***' if token else 'None'}")
    
    if not room_id:
        print("ERROR: Missing room_id")
        emit('error', {'message': 'Missing room_id'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT room_id FROM rooms WHERE room_id=?', (room_id,))
    if not cur.fetchone():
        conn.close()
        print(f"ERROR: Room not found: {room_id}")
        emit('error', {'message': 'Room not found.'})
        return

    rooms_runtime.setdefault(room_id, {'players': {1: None, 2: None}, 'finished': {1: False, 2: False}})
    rt = rooms_runtime[room_id]

    # Handle reconnection with token
    if token:
        cur.execute('SELECT player_num FROM players WHERE room_id=? AND token=?', (room_id, token))
        trow = cur.fetchone()
        if trow:
            pn = trow['player_num']
            rt['players'][pn] = request.sid
            join_room(room_id)
            cur.execute('UPDATE players SET last_seen=? WHERE room_id=? AND player_num=?',
                        (datetime.utcnow().isoformat(), room_id, pn))
            conn.commit()
            conn.close()
            print(f"Player {pn} rejoined room {room_id}")
            emit('joined', {'room_id': room_id, 'player': pn, 'token': token})
            emit('system', {'message': f'Player {pn} rejoined.'}, room=room_id)
            emit('state', public_state(room_id), room=room_id)
            return

    if desired_player not in (1, 2):
        conn.close()
        print(f"ERROR: Invalid player number: {desired_player}")
        emit('error', {'message': 'Invalid player number.'})
        return

    cur.execute('SELECT token FROM players WHERE room_id=? AND player_num=?', (room_id, desired_player))
    exists = cur.fetchone()
    if exists:
        conn.close()
        print(f"ERROR: Player {desired_player} slot already taken in room {room_id}")
        emit('error', {'message': f'Player {desired_player} slot already taken.'})
        return

    rt['players'][desired_player] = request.sid
    join_room(room_id)
    new_token = gen_token()
    cur.execute('INSERT OR REPLACE INTO players(room_id, player_num, token, last_seen) VALUES(?,?,?,?)',
                (room_id, desired_player, new_token, datetime.utcnow().isoformat()))
    conn.commit()
    conn.close()
    print(f"Player {desired_player} joined room {room_id}")
    emit('joined', {'room_id': room_id, 'player': desired_player, 'token': new_token})
    emit('system', {'message': f'Player {desired_player} joined.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('leave_room')
def on_leave_room(data):
    room_id = data.get('room_id', '')
    player = int(data.get('player', 0))
    print(f"Player {player} leaving room {room_id}")
    if room_id in rooms_runtime:
        rt = rooms_runtime[room_id]
        if rt['players'].get(player) == request.sid:
            rt['players'][player] = None
            leave_room(room_id)
            emit('system', {'message': f'Player {player} left.'}, room=room_id)
            emit('state', public_state(room_id), room=room_id)

@socketio.on('set_secret')
def on_set_secret(data):
    room_id = data.get('room_id', '')
    player = int(data.get('player'))
    secret = str(data.get('secret', '')).strip()
    
    print(f"Set secret: room={room_id}, player={player}, secret=***")
    
    if not (secret.isdigit() and len(secret) == 4 and 1000 <= int(secret) <= 9999):
        print(f"ERROR: Invalid secret format")
        emit('error', {'message': 'Secret must be a 4-digit number between 1000 and 9999.'})
        return
    
    if room_id not in rooms_runtime:
        print(f"ERROR: Room not found in runtime: {room_id}")
        emit('error', {'message': 'Room not found.'})
        return
    
    if rooms_runtime[room_id]['players'].get(player) != request.sid:
        print(f"ERROR: Unauthorized player")
        emit('error', {'message': 'Unauthorized player for setting this secret.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    
    # Check if game has started
    cur.execute('SELECT started FROM rooms WHERE room_id=?', (room_id,))
    row = cur.fetchone()
    if row and row['started'] == 1:
        conn.close()
        print(f"ERROR: Cannot set secret after game start")
        emit('error', {'message': 'Cannot set secret after game has started.'})
        return
    
    cur.execute('INSERT OR REPLACE INTO secrets(room_id, player_num, secret) VALUES(?,?,?)', 
                (room_id, player, secret))
    conn.commit()
    conn.close()

    print(f"Secret set successfully for player {player}")
    emit('secret_ack', {'player': player})
    emit('system', {'message': f'Player {player} has set their number.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('reset_secret')
def on_reset_secret(data):
    room_id = data.get('room_id', '')
    player = int(data.get('player'))
    
    print(f"Reset secret: room={room_id}, player={player}")
    
    if room_id not in rooms_runtime:
        emit('error', {'message': 'Room not found.'})
        return
    
    if rooms_runtime[room_id]['players'].get(player) != request.sid:
        emit('error', {'message': 'Unauthorized player.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started FROM rooms WHERE room_id=?', (room_id,))
    row = cur.fetchone()
    started = row['started'] if row else 0
    
    if started:
        conn.close()
        emit('error', {'message': 'Cannot reset secret after game start.'})
        return

    cur.execute('DELETE FROM secrets WHERE room_id=? AND player_num=?', (room_id, player))
    conn.commit()
    conn.close()
    
    print(f"Secret reset for player {player}")
    emit('system', {'message': f'Player {player} reset their number.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('start_game')
def on_start_game(data):
    room_id = data.get('room_id', '')
    
    print(f"Start game request: room={room_id}")
    
    if room_id not in rooms_runtime:
        print(f"ERROR: Room not found in runtime")
        emit('error', {'message': 'Room not found.'})
        return
    
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT COUNT(*) AS c FROM secrets WHERE room_id=?', (room_id,))
    c_row = cur.fetchone()
    c = c_row['c'] if c_row else 0
    
    print(f"Secrets count: {c}")
    
    if c < 2:
        print(f"ERROR: Not enough secrets set (need 2, have {c})")
        emit('error', {'message': 'Both players must set their numbers.'})
        conn.close()
        return
    
    timer_start_ms = int(time.time() * 1000)
    cur.execute('UPDATE rooms SET started=1, current_turn=1, timer_start_ms=? WHERE room_id=?', 
                (timer_start_ms, room_id))
    conn.commit()
    conn.close()
    
    rooms_runtime[room_id]['finished'] = {1: False, 2: False}
    
    print(f"Game started successfully in room {room_id}")
    emit('game_started', {'current_turn': 1, 'timer_start_ms': timer_start_ms}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('submit_guess')
def on_submit_guess(data):
    room_id = data.get('room_id', '')
    player = int(data.get('player'))
    guess = str(data.get('guess', '')).strip()
    
    print(f"Submit guess: room={room_id}, player={player}, guess={guess}")
    
    if room_id not in rooms_runtime:
        emit('error', {'message': 'Room not found.'})
        return
    
    rt = rooms_runtime[room_id]
    if rt['players'].get(player) != request.sid:
        emit('error', {'message': 'Unauthorized player.'})
        return
    
    if not (guess.isdigit() and len(guess) == 4 and 1000 <= int(guess) <= 9999):
        emit('error', {'message': 'Guess must be a 4-digit number between 1000 and 9999.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started, current_turn, timer_start_ms FROM rooms WHERE room_id=?', (room_id,))
    room_row = cur.fetchone()
    
    if not room_row or room_row['started'] == 0:
        conn.close()
        emit('error', {'message': 'Game has not started.'})
        return
    
    if player != room_row['current_turn']:
        conn.close()
        emit('error', {'message': f"Not your turn. Player {room_row['current_turn']}'s turn."})
        return

    opponent = 2 if player == 1 else 1
    cur.execute('SELECT secret FROM secrets WHERE room_id=? AND player_num=?', (room_id, opponent))
    o = cur.fetchone()
    secret = o['secret'] if o else None
    
    if not secret:
        conn.close()
        emit('error', {'message': 'Opponent secret missing.'})
        return

    matches = count_matches(guess, secret)
    # FIXED: Corrected emoji encoding
    outcome = ('You guessed the number correct! Congratulations 🎉' if matches == 4 
                else f'{matches} correct')

    print(f"Guess result: matches={matches}, outcome={outcome}")

    cur.execute('SELECT COALESCE(MAX(idx),0) AS mx FROM history WHERE room_id=? AND player_num=?', 
                (room_id, player))
    mx_row = cur.fetchone()
    mx = mx_row['mx'] if mx_row else 0
    cur.execute('INSERT INTO history(room_id, player_num, idx, guess, outcome, ts) VALUES(?,?,?,?,?,?)',
                (room_id, player, mx+1, guess, outcome, datetime.utcnow().isoformat()))

    if matches == 4:
        rooms_runtime[room_id]['finished'][player] = True
        cur.execute('UPDATE rooms SET started=0 WHERE room_id=?', (room_id,))
        conn.commit()
        conn.close()
        print(f"Game over! Player {player} wins!")
        emit('guess_result', {'player': player, 'guess': guess, 'outcome': outcome}, room=room_id)
        emit('game_over', {'winner': player, 'message': outcome}, room=room_id)
    else:
        next_turn = opponent
        cur.execute('UPDATE rooms SET current_turn=? WHERE room_id=?', (next_turn, room_id))
        conn.commit()
        conn.close()
        print(f"Turn switched to player {next_turn}")
        emit('guess_result', {'player': player, 'guess': guess, 'outcome': outcome}, room=room_id)
        emit('turn', {'current_turn': next_turn}, room=room_id)
        emit('state', public_state(room_id), room=room_id)

@socketio.on('new_game')
def on_new_game(data):
    room_id = data.get('room_id', '')
    print(f"New game request: room={room_id}")
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('DELETE FROM secrets WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM history WHERE room_id=?', (room_id,))
    cur.execute('UPDATE rooms SET started=0, current_turn=1, timer_start_ms=NULL WHERE room_id=?', (room_id,))
    conn.commit()
    conn.close()
    
    rooms_runtime.setdefault(room_id, {'players': {1: None, 2: None}, 'finished': {1: False, 2: False}})
    rooms_runtime[room_id]['finished'] = {1: False, 2: False}
    
    print(f"New game initialized in room {room_id}")
    emit('system', {'message': 'New game initialized. Set numbers to start.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

# ---------- public state ----------
def public_state(room_id):
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started, current_turn, timer_start_ms FROM rooms WHERE room_id=?', (room_id,))
    r = cur.fetchone()
    started = r['started'] if r else 0
    current_turn = r['current_turn'] if r else 1
    timer_start_ms = r['timer_start_ms'] if r else None

    # FIXED: Properly get readiness data
    cur.execute('SELECT player_num FROM secrets WHERE room_id=?', (room_id,))
    set_players = {row['player_num'] for row in cur.fetchall()}
    readiness_data = {'p1_set': 1 in set_players, 'p2_set': 2 in set_players}

    def history_for(p):
        cur.execute('SELECT idx, guess, outcome FROM history WHERE room_id=? AND player_num=? ORDER BY idx', 
                    (room_id, p))
        return [{'guess': row['guess'], 'outcome': row['outcome']} for row in cur.fetchall()]

    h1 = history_for(1)
    h2 = history_for(2)
    conn.close()

    finished_rt = rooms_runtime.get(room_id, {'finished': {1: False, 2: False}})['finished']
    
    state = {
        'started': bool(started),
        'current_turn': current_turn,
        'finished': finished_rt,
        'history': {1: h1, 2: h2},
        'readiness': readiness_data,
        'timer_start_ms': timer_start_ms,
    }
    
    print(f"Public state for {room_id}: started={state['started']}, readiness={readiness_data}")
    return state

if __name__ == '__main__':
    print("=" * 50)
    print("Starting 4-Digit Guess Game Server")
    print("=" * 50)
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)