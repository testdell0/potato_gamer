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

# Room sizing per mode
MODE_MAX_PLAYERS = {'1v1': 2, 'multi': 6}
MIN_PLAYERS = 2

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# Threading async mode pairs with simple-websocket; runs under gunicorn gthread worker.
socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False, async_mode='threading')

# ---------- SQLite ----------
def db_connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    # Reduce "database is locked" errors under concurrent gthreads.
    conn.execute('PRAGMA busy_timeout = 5000')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn

def ensure_column(cur, table, column, decl):
    """Add a column if an older DB schema is missing it (lightweight migration)."""
    cur.execute(f'PRAGMA table_info({table})')
    cols = {row['name'] for row in cur.fetchall()}
    if column not in cols:
        cur.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')

def init_db():
    print("Initializing database...")
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS rooms (
            room_id TEXT PRIMARY KEY,
            created_at TEXT,
            mode TEXT DEFAULT '1v1',
            max_players INTEGER DEFAULT 2,
            started INTEGER DEFAULT 0,
            current_turn INTEGER DEFAULT 1,
            winner INTEGER DEFAULT NULL,
            timer_start_ms INTEGER DEFAULT NULL
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS players (
            room_id TEXT,
            player_num INTEGER,
            name TEXT,
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
            target INTEGER,
            guess TEXT,
            outcome TEXT,
            ts TEXT,
            PRIMARY KEY (room_id, player_num, idx)
        )
    ''')
    # Migrations for DBs created by the original 2-player prototype.
    ensure_column(cur, 'rooms', 'mode', "TEXT DEFAULT '1v1'")
    ensure_column(cur, 'rooms', 'max_players', 'INTEGER DEFAULT 2')
    ensure_column(cur, 'rooms', 'winner', 'INTEGER DEFAULT NULL')
    ensure_column(cur, 'players', 'name', 'TEXT')
    ensure_column(cur, 'history', 'target', 'INTEGER')
    conn.commit()
    conn.close()
    print("Database initialized successfully")

init_db()

# room_id -> { 'players': { player_num: sid }, 'finished': bool }
rooms_runtime = {}

def gen_room_code(length=6):
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))

def gen_token(length=32):
    return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(length))

def count_matches(guess: str, secret: str) -> int:
    return sum(1 for i in range(4) if guess[i] == secret[i])

def clean_name(raw, fallback):
    name = (raw or '').strip()
    if not name:
        return fallback
    return name[:20]

def valid_four_digit(s):
    s = str(s).strip()
    return s.isdigit() and len(s) == 4 and 1000 <= int(s) <= 9999

# ---------- ring / turn helpers ----------
def player_nums(conn, room_id):
    cur = conn.cursor()
    cur.execute('SELECT player_num FROM players WHERE room_id=? ORDER BY player_num', (room_id,))
    return [row['player_num'] for row in cur.fetchall()]

def ring_target(nums, player):
    """Each player targets the next player in the ring; the last wraps to the first."""
    if player not in nums:
        return None
    i = nums.index(player)
    return nums[(i + 1) % len(nums)]

def next_in_ring(nums, player):
    if player not in nums:
        return nums[0] if nums else player
    i = nums.index(player)
    return nums[(i + 1) % len(nums)]

def player_for_sid(room_id, sid):
    rt = rooms_runtime.get(room_id)
    if not rt:
        return None
    for pn, s in rt['players'].items():
        if s == sid:
            return pn
    return None

def next_free_slot(conn, room_id, max_players):
    taken = set(player_nums(conn, room_id))
    for n in range(1, max_players + 1):
        if n not in taken:
            return n
    return None

# ---------- routes ----------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/room/<room_id>')
def room(room_id):
    return render_template('room.html', room_id=room_id)

# ---------- admin ----------
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
      SELECT r.room_id, r.created_at, r.mode, r.max_players, r.started, r.current_turn, r.winner,
             (SELECT COUNT(*) FROM players p WHERE p.room_id=r.room_id) AS player_count,
             (SELECT COUNT(*) FROM secrets s WHERE s.room_id=r.room_id) AS secrets_set,
             (SELECT COUNT(*) FROM history h WHERE h.room_id=r.room_id) AS guesses,
             (SELECT GROUP_CONCAT(p.player_num || ':' || COALESCE(p.name,'?')) FROM players p WHERE p.room_id=r.room_id) AS players
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
    cur.execute('UPDATE rooms SET started=0, current_turn=1, winner=NULL, timer_start_ms=NULL WHERE room_id=?', (room_id,))
    conn.commit()
    conn.close()
    rooms_runtime.setdefault(room_id, {'players': {}, 'finished': False})
    rooms_runtime[room_id]['finished'] = False
    return redirect(url_for('admin', key=ADMIN_KEY))

# ---------- socketio ----------
@socketio.on('connect')
def on_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    print(f"Client disconnected: {sid}")
    for room_id, rt in list(rooms_runtime.items()):
        changed = False
        for pn, s in list(rt['players'].items()):
            if s == sid:
                rt['players'][pn] = None
                changed = True
        if changed:
            emit('system', {'message': 'A player disconnected.'}, room=room_id)
            emit('state', public_state(room_id), room=room_id)

@socketio.on('create_room')
def on_create_room(data):
    data = data or {}
    mode = data.get('mode') if data.get('mode') in MODE_MAX_PLAYERS else '1v1'
    max_players = MODE_MAX_PLAYERS[mode]
    room_id = gen_room_code()
    print(f"Creating room {room_id} (mode={mode}, max={max_players})")
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('''INSERT OR REPLACE INTO rooms(room_id, created_at, mode, max_players, started, current_turn, winner, timer_start_ms)
                   VALUES(?,?,?,?,?,?,?,?)''',
                (room_id, datetime.utcnow().isoformat(), mode, max_players, 0, 1, None, None))
    conn.commit()
    conn.close()
    rooms_runtime[room_id] = {'players': {}, 'finished': False}
    emit('room_created', {'room_id': room_id, 'mode': mode})

@socketio.on('join_room')
def on_join_room(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    token = data.get('token') or ''
    name = data.get('name') or ''

    if not room_id:
        emit('error', {'message': 'Missing room code.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT room_id, max_players, started FROM rooms WHERE room_id=?', (room_id,))
    rrow = cur.fetchone()
    if not rrow:
        conn.close()
        emit('error', {'message': 'Room not found.'})
        return

    max_players = rrow['max_players']
    started = rrow['started']
    rt = rooms_runtime.setdefault(room_id, {'players': {}, 'finished': False})

    # Reconnect via token.
    if token:
        cur.execute('SELECT player_num, name FROM players WHERE room_id=? AND token=?', (room_id, token))
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
            emit('joined', {'room_id': room_id, 'player': pn, 'token': token, 'name': trow['name']})
            emit('system', {'message': f'{trow["name"]} rejoined.'}, room=room_id)
            emit('state', public_state(room_id), room=room_id)
            return

    # New player can only join before the game starts.
    if started:
        conn.close()
        emit('error', {'message': 'Game already started. Cannot join now.'})
        return

    slot = next_free_slot(conn, room_id, max_players)
    if slot is None:
        conn.close()
        emit('error', {'message': 'Room is full.'})
        return

    safe_name = clean_name(name, f'Player {slot}')
    new_token = gen_token()
    rt['players'][slot] = request.sid
    join_room(room_id)
    cur.execute('INSERT OR REPLACE INTO players(room_id, player_num, name, token, last_seen) VALUES(?,?,?,?,?)',
                (room_id, slot, safe_name, new_token, datetime.utcnow().isoformat()))
    conn.commit()
    conn.close()
    print(f"{safe_name} joined room {room_id} as player {slot}")
    emit('joined', {'room_id': room_id, 'player': slot, 'token': new_token, 'name': safe_name})
    emit('system', {'message': f'{safe_name} joined.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('leave_room')
def on_leave_room(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    rt = rooms_runtime.get(room_id)
    if not rt:
        return
    pn = player_for_sid(room_id, request.sid)
    if pn is not None:
        rt['players'][pn] = None
        leave_room(room_id)
        emit('system', {'message': f'Player {pn} left.'}, room=room_id)
        emit('state', public_state(room_id), room=room_id)

@socketio.on('set_secret')
def on_set_secret(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    secret = str(data.get('secret', '')).strip()

    pn = player_for_sid(room_id, request.sid)
    if pn is None:
        emit('error', {'message': 'You are not in this room.'})
        return
    if not valid_four_digit(secret):
        emit('error', {'message': 'Secret must be a 4-digit number between 1000 and 9999.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started FROM rooms WHERE room_id=?', (room_id,))
    row = cur.fetchone()
    if row and row['started'] == 1:
        conn.close()
        emit('error', {'message': 'Cannot set secret after the game has started.'})
        return
    cur.execute('INSERT OR REPLACE INTO secrets(room_id, player_num, secret) VALUES(?,?,?)',
                (room_id, pn, secret))
    conn.commit()
    conn.close()
    emit('secret_ack', {'player': pn})
    emit('state', public_state(room_id), room=room_id)

@socketio.on('reset_secret')
def on_reset_secret(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    pn = player_for_sid(room_id, request.sid)
    if pn is None:
        emit('error', {'message': 'You are not in this room.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started FROM rooms WHERE room_id=?', (room_id,))
    row = cur.fetchone()
    if row and row['started'] == 1:
        conn.close()
        emit('error', {'message': 'Cannot reset secret after the game has started.'})
        return
    cur.execute('DELETE FROM secrets WHERE room_id=? AND player_num=?', (room_id, pn))
    conn.commit()
    conn.close()
    emit('state', public_state(room_id), room=room_id)

@socketio.on('start_game')
def on_start_game(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    if room_id not in rooms_runtime:
        emit('error', {'message': 'Room not found.'})
        return

    conn = db_connect()
    nums = player_nums(conn, room_id)
    cur = conn.cursor()
    cur.execute('SELECT player_num FROM secrets WHERE room_id=?', (room_id,))
    ready = {row['player_num'] for row in cur.fetchall()}

    if len(nums) < MIN_PLAYERS:
        conn.close()
        emit('error', {'message': f'Need at least {MIN_PLAYERS} players to start.'})
        return
    if not all(n in ready for n in nums):
        conn.close()
        emit('error', {'message': 'All joined players must set their numbers.'})
        return

    timer_start_ms = int(time.time() * 1000)
    cur.execute('UPDATE rooms SET started=1, current_turn=?, winner=NULL, timer_start_ms=? WHERE room_id=?',
                (nums[0], timer_start_ms, room_id))
    conn.commit()
    conn.close()
    rooms_runtime[room_id]['finished'] = False
    print(f"Game started in {room_id}; turn order {nums}")
    emit('game_started', {'current_turn': nums[0], 'timer_start_ms': timer_start_ms}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

@socketio.on('submit_guess')
def on_submit_guess(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    guess = str(data.get('guess', '')).strip()

    pn = player_for_sid(room_id, request.sid)
    if pn is None:
        emit('error', {'message': 'You are not in this room.'})
        return
    if not valid_four_digit(guess):
        emit('error', {'message': 'Guess must be a 4-digit number between 1000 and 9999.'})
        return

    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT started, current_turn FROM rooms WHERE room_id=?', (room_id,))
    rrow = cur.fetchone()
    if not rrow or rrow['started'] == 0:
        conn.close()
        emit('error', {'message': 'Game has not started.'})
        return
    if pn != rrow['current_turn']:
        conn.close()
        emit('error', {'message': f"Not your turn (Player {rrow['current_turn']}'s turn)."})
        return

    nums = player_nums(conn, room_id)
    target = ring_target(nums, pn)
    cur.execute('SELECT secret FROM secrets WHERE room_id=? AND player_num=?', (room_id, target))
    srow = cur.fetchone()
    if not srow:
        conn.close()
        emit('error', {'message': 'Target secret missing.'})
        return

    matches = count_matches(guess, srow['secret'])
    outcome = ('You cracked the number! 🎉' if matches == 4 else f'{matches} correct')

    cur.execute('SELECT COALESCE(MAX(idx),0) AS mx FROM history WHERE room_id=? AND player_num=?', (room_id, pn))
    mx = cur.fetchone()['mx']
    cur.execute('INSERT INTO history(room_id, player_num, idx, target, guess, outcome, ts) VALUES(?,?,?,?,?,?,?)',
                (room_id, pn, mx + 1, target, guess, outcome, datetime.utcnow().isoformat()))

    if matches == 4:
        cur.execute('UPDATE rooms SET started=0, winner=? WHERE room_id=?', (pn, room_id))
        conn.commit()
        conn.close()
        rooms_runtime[room_id]['finished'] = True
        print(f"Game over in {room_id}: player {pn} wins")
        emit('guess_result', {'player': pn, 'target': target, 'guess': guess, 'outcome': outcome}, room=room_id)
        emit('game_over', {'winner': pn, 'message': outcome}, room=room_id)
        emit('state', public_state(room_id), room=room_id)
    else:
        nxt = next_in_ring(nums, pn)
        cur.execute('UPDATE rooms SET current_turn=? WHERE room_id=?', (nxt, room_id))
        conn.commit()
        conn.close()
        emit('guess_result', {'player': pn, 'target': target, 'guess': guess, 'outcome': outcome}, room=room_id)
        emit('turn', {'current_turn': nxt}, room=room_id)
        emit('state', public_state(room_id), room=room_id)

@socketio.on('new_game')
def on_new_game(data):
    data = data or {}
    room_id = (data.get('room_id') or '').upper()
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('DELETE FROM secrets WHERE room_id=?', (room_id,))
    cur.execute('DELETE FROM history WHERE room_id=?', (room_id,))
    cur.execute('UPDATE rooms SET started=0, current_turn=1, winner=NULL, timer_start_ms=NULL WHERE room_id=?', (room_id,))
    conn.commit()
    conn.close()
    rooms_runtime.setdefault(room_id, {'players': {}, 'finished': False})
    rooms_runtime[room_id]['finished'] = False
    emit('system', {'message': 'New game. Everyone set your numbers to begin.'}, room=room_id)
    emit('state', public_state(room_id), room=room_id)

# ---------- public state ----------
def public_state(room_id):
    conn = db_connect()
    cur = conn.cursor()
    cur.execute('SELECT mode, max_players, started, current_turn, winner, timer_start_ms FROM rooms WHERE room_id=?',
                (room_id,))
    r = cur.fetchone()
    if not r:
        conn.close()
        return {'exists': False}

    nums = player_nums(conn, room_id)

    cur.execute('SELECT player_num, name FROM players WHERE room_id=? ORDER BY player_num', (room_id,))
    name_rows = cur.fetchall()
    names = {row['player_num']: row['name'] for row in name_rows}

    cur.execute('SELECT player_num FROM secrets WHERE room_id=?', (room_id,))
    ready = {row['player_num'] for row in cur.fetchall()}

    rt = rooms_runtime.get(room_id, {'players': {}})
    connected = {pn for pn, sid in rt.get('players', {}).items() if sid}

    players = []
    for n in nums:
        players.append({
            'num': n,
            'name': names.get(n, f'Player {n}'),
            'ready': n in ready,
            'connected': n in connected,
            'target': ring_target(nums, n),
        })

    cur.execute('''SELECT player_num, target, guess, outcome, idx, ts
                   FROM history WHERE room_id=? ORDER BY ts, idx''', (room_id,))
    history = []
    for row in cur.fetchall():
        history.append({
            'player': row['player_num'],
            'player_name': names.get(row['player_num'], f'Player {row["player_num"]}'),
            'target': row['target'],
            'target_name': names.get(row['target'], f'Player {row["target"]}'),
            'guess': row['guess'],
            'outcome': row['outcome'],
        })
    conn.close()

    return {
        'exists': True,
        'mode': r['mode'],
        'max_players': r['max_players'],
        'started': bool(r['started']),
        'current_turn': r['current_turn'],
        'winner': r['winner'],
        'finished': rooms_runtime.get(room_id, {}).get('finished', False),
        'timer_start_ms': r['timer_start_ms'],
        'players': players,
        'history': history,
    }

if __name__ == '__main__':
    print("=" * 50)
    print("Starting 4-Digit Guess Game Server")
    print("=" * 50)
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)
