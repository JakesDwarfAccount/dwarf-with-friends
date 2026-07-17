"""Minimal raw-socket WS probe for dwf. Drains fast, replies to pings, sends no input.
Logs per-second: frames, bytes, opcode mix, and flags inter-frame gaps > 500ms.

Positional tokens in argv[3:]:
  wss:<host>   route through the cloudflare tunnel (TLS, port 443)
  input        send a cursor update every 0.5s after 6s (legacy input path)
  proto1       protocol-v1 client (WA-9): append &proto=1, send `hello`, ACK every binary
               frame, decode the 10-byte header, and report BLOCK_SET/AUX rates + gaps.
  snapreport   (WA-11, implies proto1) decode BLOCK_SET payloads (inflating deflated ones)
               to track distinct (bx,by,bz) blocks seen; reports when the HELLO interest
               window is fully covered and when snapshot_meta trickle begin/end arrive.
  have:<N>     HELLO's `have` field (default 0 = full snapshot). Use the world_seq printed
               by a prior run's hello_ack/PROTO1 line to drive a resume test.
  reqblocks:bx,by,bz[;bx,by,bz...]  (WA-11.3) send a `reqblocks` message right after HELLO
               for the given block(s) -- used with snapreport to verify a far-out-of-trickle-
               order block still arrives promptly (priority 0, front-of-line).
  auxdump      (WE-3) decode every v1 AUX frame's JSON (inflating deflated payloads) and
               track, per unit id, whether/when it first carried "ah" (appearance-hash).
               At exit, prints: units ever seen, units that ever carried ah, whether every
               ah value is 16 lowercase hex chars, and a small sample of units that NEVER
               carried ah (the WE-3 "flat animals carry none" fixture check) -- plus writes
               results/auxdump_<player>.json with the raw per-unit summary.
  itemtails    (WC-1, implies proto1/snapreport) decode kTailItem (kind=0x01) tail entries
               inside BLOCK_SET payloads: item_type/mat_type/mat_index/subtype/iflags/stack
               (§WC-1 wire: 8-byte legacy prefix + subtype i16/iflags u8/stack u8). Collects
               up to 4000 samples and writes results/itemtails_<player>.json.
  spattails    (WC-11, implies proto1/snapreport) decode kTailSpatterMat (kind=0x03,
               9-byte: mat_type/mat_index/amount/state) AND kTailItemSpatter (kind=0x05,
               3-byte: growth_class/item_type/amount) tail entries. Collects up to 4000
               samples of each and writes results/spattails_<player>.json.
  flowtails    (WC-15, implies proto1/snapreport) decode kTailFlow (kind=0x04, 2-byte:
               flow_type/density) tail entries. Collects up to 4000 samples and writes
               results/flowtails_<player>.json.
  grasstails   (WC-17, implies proto1/snapreport) decode kTailGrass (kind=0x06, variable:
               idlen u8 + id bytes + amount u8 -- the resolved plant token string, same
               layout as the PLANT tail) entries. Collects up to 4000 samples and writes
               results/grasstails_<player>.json.
  engtails     (WC-18, implies proto1/snapreport) decode kTailEngraving (kind=0x07,
               3-byte: eflags u16 LE + quality u8) entries. Collects up to 4000 samples
               and writes results/engtails_<player>.json.
  desigtile:wx,wy,wz  (designation-freshness bug repro, implies proto1/snapreport) track
               ONE world tile's desig1 byte (dig:4 bits, wire_v1.h TileRecord) across every
               BLOCK_SET that carries its block, regardless of camera movement. Prints a
               timestamped line every time the decoded `dig` value CHANGES (0=No, per
               DIG_NAMES order), and writes results/desigreport_<player>.json with the full
               transition list at exit -- used to prove/disprove whether a fresh mining
               designation actually reaches an already-connected, camera-still client."""
import socket, base64, os, sys, time, struct, ssl, json, zlib, http.client

PLAYER = sys.argv[1] if len(sys.argv) > 1 else "probe1"
DUR = int(sys.argv[2]) if len(sys.argv) > 2 else 60
TOKENS = sys.argv[3:]
WSS_HOST = None
HAVE = 0
REQBLOCKS = []
for a in TOKENS:
    if a.startswith("wss:"):
        WSS_HOST = a[4:]
    if a.startswith("have:"):
        HAVE = int(a[5:])
    if a.startswith("reqblocks:"):
        for triple in a[len("reqblocks:"):].split(";"):
            parts = [int(x) for x in triple.split(",")]
            REQBLOCKS.append(parts)
AUXDUMP = "auxdump" in TOKENS
ITEMTAILS = "itemtails" in TOKENS
SPATTAILS = "spattails" in TOKENS
FLOWTAILS = "flowtails" in TOKENS
GRASSTAILS = "grasstails" in TOKENS
ENGTAILS = "engtails" in TOKENS
DESIGTILE = None
for a in TOKENS:
    if a.startswith("desigtile:"):
        _dwx, _dwy, _dwz = (int(x) for x in a[len("desigtile:"):].split(","))
        DESIGTILE = (_dwx, _dwy, _dwz)
DESIGREPORT = DESIGTILE is not None
# The tail-dump tokens all document "implies proto1/snapreport" -- decode_block_set (the
# only place tail entries are walked) is gated on SNAPREPORT, so the implication must be
# real or the tail tokens silently collect zero samples (found live during WC-17 verify).
SNAPREPORT = ("snapreport" in TOKENS or ITEMTAILS or SPATTAILS or FLOWTAILS
              or GRASSTAILS or ENGTAILS or DESIGREPORT)
PROTO1 = "proto1" in TOKENS or SNAPREPORT or AUXDUMP
SEND_INPUT = "input" in TOKENS
if WSS_HOST:
    HOST, PORT, USE_TLS = WSS_HOST, 443, True
else:
    HOST, PORT, USE_TLS = "127.0.0.1", 8765, False
W, H = 50, 28
# dims:WxH -- override the interest-window request size (default 50x28). Used by
# gate_userperf.py to force the two extra headless clients WIDE (e.g. dims:200x114) so a
# "multi" cell reproduces the multi-wide-client server load the owner actually sees. Additive/
# backward-compatible: absent -> the historical 50x28 every existing caller relied on.
for _a in TOKENS:
    if _a.startswith("dims:"):
        try:
            _dw, _dh = _a[len("dims:"):].lower().split("x")
            W, H = max(1, int(_dw)), max(1, int(_dh))
        except Exception:
            pass

# B139 harness: pass the join password through env DFCAP_AUTH so the probe works against
# an auth-enabled live server (the browser sends this same value as the dfcap_auth cookie
# on both the WS upgrade and every HTTP fetch). Absent -> unchanged open-dev behavior.
AUTH = os.environ.get("DFCAP_AUTH", "")

def fetch_camera(player):
    """GET /camera?player=<player> -- the interest window's ACTUAL x/y/z authority (§0.8:
    HELLO's cam x/y/z are advisory-only for trickle sort order; the server always sizes the
    interest window from camera_for_player, which for a brand-new player name defaults to
    the live DF host's current view). Used so snapreport's assumed interest window matches
    what the server will actually stream, instead of guessing coordinates."""
    conn = (http.client.HTTPSConnection(HOST, PORT, timeout=5) if USE_TLS
            else http.client.HTTPConnection(HOST, PORT, timeout=5))
    try:
        conn.request("GET", f"/camera?player={player}",
                     headers={"Cookie": f"dfcap_auth={AUTH}"} if AUTH else {})
        r = conn.getresponse()
        data = json.loads(r.read())
    finally:
        conn.close()
    return data

raw = socket.create_connection((HOST, PORT), timeout=15)
raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
if USE_TLS:
    ctx = ssl.create_default_context()
    s = ctx.wrap_socket(raw, server_hostname=HOST)
else:
    s = raw
key = base64.b64encode(os.urandom(16)).decode()
url = f"/ws?player={PLAYER}&w={W}&h={H}" + ("&proto=1" if PROTO1 else "")
req = (f"GET {url} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n"
       f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
       + (f"Cookie: dfcap_auth={AUTH}\r\n" if AUTH else "")
       + f"Sec-WebSocket-Version: 13\r\n\r\n")
s.sendall(req.encode())
resp = b""
while b"\r\n\r\n" not in resp:
    c = s.recv(4096)
    if not c: print("CLOSED during handshake, got:", resp[:200]); sys.exit(1)
    resp += c
head, _, rest = resp.partition(b"\r\n\r\n")
print("HANDSHAKE:", head.split(b"\r\n")[0].decode(), flush=True)
if b"101" not in head.split(b"\r\n")[0]: print(head.decode()); sys.exit(1)

buf = bytearray(rest)
s.settimeout(2.0)

def need(n):
    while len(buf) < n:
        try:
            c = s.recv(65536)
        except socket.timeout:
            return False
        if not c: raise ConnectionError("peer closed")
        buf.extend(c)
    return True

def send_frame(op, payload=b""):
    mask = os.urandom(4)
    hdr = bytes([0x80 | op])
    L = len(payload)
    if L < 126: hdr += bytes([0x80 | L])
    elif L < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", L)
    else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", L)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

def send_text(obj):
    send_frame(1, json.dumps(obj).encode())

CAM_X, CAM_Y, CAM_Z = 0, 0, 100
if PROTO1:
    try:
        _cam = fetch_camera(PLAYER)
        CAM_X, CAM_Y, CAM_Z = int(_cam["x"]), int(_cam["y"]), int(_cam["z"])
        print(f"camera_for_player({PLAYER}) = ({CAM_X},{CAM_Y},{CAM_Z})", flush=True)
    except Exception as e:
        print(f"WARN: /camera fetch failed ({e}); falling back to advisory-only ({CAM_X},{CAM_Y},{CAM_Z})", flush=True)
    hello = {"type": "hello", "proto": 1, "player": PLAYER, "have": HAVE,
             "cam": {"x": CAM_X, "y": CAM_Y, "z": CAM_Z, "w": W, "h": H}}
    # B139 harness: an auth-enabled server also gates the WS hello itself ("token", see
    # websocket.cpp JOIN SECURITY) -- same shared secret as the dfcap_auth cookie.
    if AUTH:
        hello["token"] = AUTH
    send_text(hello)
    if REQBLOCKS:
        send_text({"type": "reqblocks", "blocks": REQBLOCKS})
        print(f"sent reqblocks: {REQBLOCKS}", flush=True)

t0 = time.time(); last_frame = t0; sec = int(t0)
stats = {"n": 0, "b": 0, "ops": {}}
# proto1 counters
v1 = {"blockset": 0, "aux": 0, "acks": 0, "helloack": 0, "maxgap": 0.0, "gaps500": 0,
      "last_aux": None, "aux_gaps500": 0, "world_seq": 0, "blockset_bytes": 0}
last_input = 0.0

# ---- WA-11 snapreport state ---------------------------------------------------------
def _fdiv16(v):
    return v // 16 if v >= 0 else -((-v + 15) // 16)

# Interest window per §0.8: camera rect x z-range [z-10, z] (same math as world_stream.cpp).
_IBX0, _IBX1 = _fdiv16(CAM_X), _fdiv16(CAM_X + W - 1)
_IBY0, _IBY1 = _fdiv16(CAM_Y), _fdiv16(CAM_Y + H - 1)
_IZ1, _IZ0 = CAM_Z, max(0, CAM_Z - 10)
interest_set = {(bx, by, bz) for bz in range(_IZ0, _IZ1 + 1)
                for bx in range(_IBX0, _IBX1 + 1) for by in range(_IBY0, _IBY1 + 1)}
seen_blocks = set()
interest_full_t = None
last_inview_count = [0]        # mutable cell (closures below just read/write index 0)
last_inview_growth_t = [t0]
snap_meta = {"begin": None, "end": None}
# Burst-vs-steady-state split (WA-11 resume-economics evidence): total distinct blocks stop
# growing once the catch-up burst (full snapshot OR resume's small dirty-since-have set) is
# delivered; afterward, bytes are just ongoing per-tick in-view churn common to BOTH a fresh
# connection and a resumed one, so comparing burst bytes (not whole-connection-lifetime
# bytes) isolates the number the "<10% of snapshot bytes" pass criterion is actually about.
burst_done = {"t": None, "bytes": None, "blocks": None}
last_total_count = [0]
last_total_growth_t = [t0]

block_crc = {}   # (bx,by,bz) -> crc32 of its full wire record (header+3072+tails), latest wins

# ---- WC-1 itemtails state -------------------------------------------------------------
item_tail_samples = []   # list of {block, tile_idx, item_type, mat_type, mat_index, subtype, iflags, stack}

# ---- WC-11 spattails / WC-15 flowtails state -------------------------------------------
spatter_mat_samples = []   # {block, tile_idx, mat_type, mat_index, amount, state}
item_spatter_samples = []  # {block, tile_idx, growth_class, item_type, amount}
flow_samples = []          # {block, tile_idx, flow_type, density}

# ---- WC-17 grasstails / WC-18 engtails state --------------------------------------------
grass_samples = []         # {block, tile_idx, id, amount}
eng_samples = []           # {block, tile_idx, eflags, quality}

# ---- desigtile state (designation-freshness bug repro) ---------------------------------
# Local dig ordinal table, matching web/js/dwf-cache-worker.js's DIG_NAMES exactly
# (both are self-consistent-only tables -- see that file's banner).
DIG_NAMES = ["No", "Default", "UpDownStair", "Channel", "Ramp", "DownStair", "UpStair"]
desig_target_block = None   # (bx,by,bz) computed from DESIGTILE once we know it
desig_target_idx = None     # tile_idx within that block (ly*16+lx)
desig_last_dig = None       # last observed dig ordinal (None = never seen this tile yet)
desig_transitions = []      # [{t, dig, dig_name, marker, world_seq}]
if DESIGTILE:
    _dwx, _dwy, _dwz = DESIGTILE
    desig_target_block = (_dwx >> 4, _dwy >> 4, _dwz)
    _dlx, _dly = _dwx & 15, _dwy & 15
    desig_target_idx = _dly * 16 + _dlx
    print(f"desigtile: watching world tile ({_dwx},{_dwy},{_dwz}) = "
          f"block {desig_target_block} tile_idx {desig_target_idx}", flush=True)

# ---- WE-3 auxdump state --------------------------------------------------------------
import re as _re
_HEX16_RE = _re.compile(r"^[0-9a-f]{16}$")
aux_units = {}   # unit id -> {"first_seen": t, "first_ah": t|None, "last_ah": str|None}
aux_bad_hash = []  # (unit id, offending "ah" string) -- should stay empty

def decode_block_set(raw_body):
    """Walk a decoded (already-inflated) BLOCK_SET payload, returning the set of
    (bx,by,bz) keys it carries and updating `block_crc` with each block's content hash
    (for the WA-11 resume-equivalence check: same key + same crc across two probe runs
    means byte-identical decoded records). Mirrors wire_v1.h §0.3 byte-for-byte (tail
    entries must be skipped by length to reach the next block header)."""
    global desig_last_dig
    keys = set()
    off = 0
    n = len(raw_body)
    if n < 6:
        return keys
    block_count = struct.unpack_from("<H", raw_body, 4)[0]
    off = 6
    for _ in range(block_count):
        if off + 12 > n:      # bx(2)+by(2)+bz(2)+ver(4)+bflags(1)+tail_count(1) = 12
            break
        block_start = off
        bx, by, bz = struct.unpack_from("<HHH", raw_body, off)
        ver = struct.unpack_from("<I", raw_body, off + 6)[0]
        tail_count = raw_body[off + 11]
        tiles_off = off + 12
        if (DESIGREPORT and desig_target_block == (bx, by, bz)
                and tiles_off + (desig_target_idx + 1) * 12 <= n):
            rec_off = tiles_off + desig_target_idx * 12
            desig1 = raw_body[rec_off + 7]
            dig = desig1 & 0xF
            marker = (desig1 >> 6) & 1
            if dig != desig_last_dig:
                now_t = time.time() - t0
                name = DIG_NAMES[dig] if dig < len(DIG_NAMES) else f"?{dig}"
                print(f"[{now_t:6.1f}s] DESIGTILE dig {desig_last_dig}->{dig} ({name}) "
                      f"marker={marker} world_seq={ver}", flush=True)
                desig_transitions.append({"t": now_t, "dig": dig, "dig_name": name,
                                           "marker": marker, "block_ver": ver})
                desig_last_dig = dig
        off += 12 + 3072
        for _ in range(tail_count):
            if off + 3 > n:
                break
            tail_tile_idx = raw_body[off]
            tail_kind = raw_body[off + 1]
            ln = raw_body[off + 2]
            if (ITEMTAILS and tail_kind == 0x01 and ln >= 12
                    and off + 3 + ln <= n and len(item_tail_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                item_type, mat_type, mat_index, subtype, iflags, stack = \
                    struct.unpack_from("<hhihBB", d, 0)
                rec = {
                    "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                    "item_type": item_type, "mat_type": mat_type, "mat_index": mat_index,
                    "subtype": subtype, "iflags": iflags, "stack": stack,
                }
                # WIRE-TAILS item identity extension: ident_kind u8 | idlen u8 | id bytes
                # after the 12-byte body (present only when the server resolved a token).
                if ln >= 14:
                    ik, il = d[12], d[13]
                    if ik and il and ln >= 14 + il:
                        rec["identKind"] = ik
                        rec["ident"] = d[14:14 + il].decode("ascii", "replace")
                item_tail_samples.append(rec)
            # WC-11: kTailSpatterMat (0x03, 9 bytes: mat_type i16/mat_index i32/amount
            # u16/state i8 -- the additive extension over the pre-WC-11 8-byte prefix).
            if (SPATTAILS and tail_kind == 0x03 and ln >= 9
                    and off + 3 + ln <= n and len(spatter_mat_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                mat_type, mat_index, amount, state = struct.unpack_from("<hiHb", d, 0)
                spatter_mat_samples.append({
                    "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                    "mat_type": mat_type, "mat_index": mat_index, "amount": amount, "state": state,
                })
            # WC-11: kTailItemSpatter (0x05, 3 bytes: growth_class u8/item_type u8/amount u8).
            if (SPATTAILS and tail_kind == 0x05 and ln >= 3
                    and off + 3 + ln <= n and len(item_spatter_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                growth_class, item_type, amount = struct.unpack_from("<BBB", d, 0)
                item_spatter_samples.append({
                    "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                    "growth_class": growth_class, "item_type": item_type, "amount": amount,
                })
            # WC-15: kTailFlow (0x04, 2 bytes: flow_type u8/density u8).
            if (FLOWTAILS and tail_kind == 0x04 and ln >= 2
                    and off + 3 + ln <= n and len(flow_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                flow_type, density = struct.unpack_from("<BB", d, 0)
                flow_samples.append({
                    "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                    "flow_type": flow_type, "density": density,
                })
            # WC-17: kTailGrass (0x06, variable: idlen u8 + id bytes + amount u8).
            if (GRASSTAILS and tail_kind == 0x06 and ln >= 2
                    and off + 3 + ln <= n and len(grass_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                idlen = d[0]
                if 1 + idlen < ln:
                    gid = d[1:1 + idlen].decode("latin-1")
                    amount = d[1 + idlen]
                    grass_samples.append({
                        "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                        "id": gid, "amount": amount,
                    })
            # WC-18: kTailEngraving (0x07, 3 bytes: eflags u16 LE + quality u8).
            if (ENGTAILS and tail_kind == 0x07 and ln >= 3
                    and off + 3 + ln <= n and len(eng_samples) < 4000):
                d = raw_body[off + 3: off + 3 + ln]
                eflags, quality = struct.unpack_from("<HB", d, 0)
                eng_samples.append({
                    "block": [bx, by, bz], "tile_idx": tail_tile_idx,
                    "eflags": eflags, "quality": quality,
                })
            off += 3 + ln
        keys.add((bx, by, bz))
        block_crc[(bx, by, bz)] = zlib.crc32(raw_body[block_start:off]) & 0xffffffff
    return keys

print(f"probing {DUR}s ({'snapreport' if SNAPREPORT else ('proto1' if PROTO1 else ('cursor-input' if SEND_INPUT else 'idle'))})...", flush=True)
try:
    while time.time() - t0 < DUR:
        nowi = time.time()
        if SEND_INPUT and nowi - t0 > 6 and nowi - last_input > 0.5:
            last_input = nowi
            send_frame(1, b'{"type":"cursor","x":10,"y":10,"z":50,"fx":0.5,"fy":0.5,"drag":0}')
        if not need(2):
            now = time.time()
            print(f"[{now-t0:6.1f}s] STALL: no bytes for 2s (last frame {now-last_frame:.1f}s ago)", flush=True)
            continue
        b1, b2 = buf[0], buf[1]
        op = b1 & 0x0F; L = b2 & 0x7F; off = 2
        if L == 126:
            if not need(4): continue
            L = struct.unpack(">H", bytes(buf[2:4]))[0]; off = 4
        elif L == 127:
            if not need(10): continue
            L = struct.unpack(">Q", bytes(buf[2:10]))[0]; off = 10
        if not need(off + L): continue
        payload = bytes(buf[off:off+L]); del buf[:off+L]
        now = time.time()
        gap = now - last_frame
        if gap > 0.5 and stats["n"] > 0:
            print(f"[{now-t0:6.1f}s] GAP {gap*1000:.0f}ms before op={op} len={L}", flush=True)
            v1["gaps500"] += 1
        if gap > v1["maxgap"]:
            v1["maxgap"] = gap
        last_frame = now
        if op == 9: send_frame(10, payload); continue          # protocol ping -> pong
        if op == 8: print(f"[{now-t0:6.1f}s] SERVER CLOSE {payload[:2].hex()}"); break
        stats["n"] += 1; stats["b"] += L
        stats["ops"][op] = stats["ops"].get(op, 0) + 1

        if PROTO1 and op == 2 and L >= 10:                      # v1 binary frame
            if payload[0] == 0x44 and payload[1] == 0x35:
                ftype = payload[3]; fflags = payload[4]; fseq = struct.unpack("<I", payload[6:10])[0]
                send_text({"type": "ack", "seq": fseq, "t": int(now * 1000)})
                v1["acks"] += 1
                if ftype == 0x01:
                    v1["blockset"] += 1
                    v1["blockset_bytes"] += L
                    if SNAPREPORT:
                        body = bytes(payload[10:])
                        if fflags & 0x01:
                            try:
                                body = zlib.decompress(body)
                            except Exception:
                                body = b""
                        if body:
                            if len(body) >= 4:
                                v1["world_seq"] = struct.unpack_from("<I", body, 0)[0]
                            new_keys = decode_block_set(body)
                            if REQBLOCKS:
                                for rb in REQBLOCKS:
                                    rbt = tuple(rb)
                                    if rbt in new_keys and rbt not in seen_blocks:
                                        print(f"[{now-t0:6.1f}s] REQBLOCKS delivered {rbt}", flush=True)
                            seen_blocks.update(new_keys)
                            # "Fully delivered" can't mean literally every (bx,by,bz) in the
                            # rect: §0.8 never ships fully-hidden blocks, and a real interest
                            # window legitimately contains undiscovered cells (unrevealed rock/
                            # cavern) that will NEVER arrive. Use convergence instead: once no
                            # NEW in-window block has shown up for 1s, coverage has plateaued
                            # (matches how a real client would judge "caught up").
                            inview_now = len(seen_blocks & interest_set)
                            if inview_now > last_inview_count[0]:
                                last_inview_count[0] = inview_now
                                last_inview_growth_t[0] = now
                            if (interest_full_t is None and last_inview_count[0] > 0
                                    and now - last_inview_growth_t[0] > 1.0):
                                interest_full_t = last_inview_growth_t[0] - t0
                                print(f"[{now-t0:6.1f}s] SNAPREPORT interest window converged at "
                                      f"t={interest_full_t:.2f}s ({last_inview_count[0]}/{len(interest_set)} "
                                      f"of the rect discovered+delivered, {len(seen_blocks)} total distinct seen)",
                                      flush=True)
                            total_now = len(seen_blocks)
                            if total_now > last_total_count[0]:
                                last_total_count[0] = total_now
                                last_total_growth_t[0] = now
                            if (burst_done["t"] is None and last_total_count[0] > 0
                                    and now - last_total_growth_t[0] > 1.0):
                                burst_done["t"] = last_total_growth_t[0] - t0
                                burst_done["bytes"] = v1["blockset_bytes"]
                                burst_done["blocks"] = last_total_count[0]
                                print(f"[{now-t0:6.1f}s] SNAPREPORT catch-up burst done at "
                                      f"t={burst_done['t']:.2f}s blocks={burst_done['blocks']} "
                                      f"blockset_bytes_at_burst={burst_done['bytes']}", flush=True)
                elif ftype == 0x02:
                    v1["aux"] += 1
                    if v1["last_aux"] is not None and now - v1["last_aux"] > 0.5:
                        v1["aux_gaps500"] += 1
                    v1["last_aux"] = now
                    if AUXDUMP:
                        body = bytes(payload[10:])
                        if fflags & 0x01:
                            try:
                                body = zlib.decompress(body)
                            except Exception:
                                body = b""
                        try:
                            aux_obj = json.loads(body.decode("utf-8")) if body else None
                        except Exception:
                            aux_obj = None
                        if aux_obj:
                            for u in aux_obj.get("units", []):
                                uid = u.get("id")
                                if uid is None:
                                    continue
                                rec = aux_units.setdefault(uid, {"first_seen": now - t0, "first_ah": None, "last_ah": None})
                                ah = u.get("ah")
                                if ah:
                                    if not _HEX16_RE.match(ah):
                                        aux_bad_hash.append((uid, ah))
                                    if rec["first_ah"] is None:
                                        rec["first_ah"] = now - t0
                                    rec["last_ah"] = ah
        elif PROTO1 and op == 1:                                # v1 text control
            try:
                m = json.loads(payload.decode("utf-8", "replace"))
            except Exception:
                m = {}
            t = m.get("type")
            if t == "ping":
                send_text({"type": "pong", "ts": m.get("ts"), "tc": int(now * 1000)})
            elif t == "hello_ack":
                v1["helloack"] += 1; v1["world_seq"] = m.get("world_seq", 0)
                print(f"[{now-t0:6.1f}s] hello_ack world_seq={m.get('world_seq')} map={m.get('map')} limits={m.get('limits')}", flush=True)
            elif t == "snapshot_meta" and SNAPREPORT:
                tr = m.get("trickle")
                if tr == "begin" and snap_meta["begin"] is None:
                    snap_meta["begin"] = now - t0
                    print(f"[{now-t0:6.1f}s] SNAPSHOT begin world_seq={m.get('world_seq')} "
                          f"discovered_blocks={m.get('discovered_blocks')}", flush=True)
                elif tr == "end" and snap_meta["end"] is None:
                    snap_meta["end"] = now - t0
                    print(f"[{now-t0:6.1f}s] SNAPSHOT end world_seq={m.get('world_seq')} "
                          f"discovered_blocks={m.get('discovered_blocks')} distinct_blocks_seen={len(seen_blocks)} "
                          f"blockset_bytes_at_end={v1['blockset_bytes']}", flush=True)

        if int(now) != sec:
            sec = int(now)
            extra = f" v1[blockset={v1['blockset']} aux={v1['aux']} acks={v1['acks']}]" if PROTO1 else ""
            print(f"[{now-t0:6.1f}s] {stats['n']} frames, {stats['b']/1024:.0f} KiB, ops={stats['ops']}{extra}", flush=True)
except ConnectionError as e:
    print(f"[{time.time()-t0:6.1f}s] CONNECTION ERROR: {e}", flush=True)
el = time.time() - t0
print(f"DONE {el:.1f}s: {stats['n']} frames total = {stats['n']/el:.1f} fps, ops={stats['ops']}", flush=True)
if PROTO1:
    print(f"PROTO1: blockset={v1['blockset']} ({v1['blockset']/el:.1f}/s) "
          f"aux={v1['aux']} ({v1['aux']/el:.1f}/s) acks={v1['acks']} helloack={v1['helloack']} "
          f"world_seq={v1['world_seq']} maxgap={v1['maxgap']*1000:.0f}ms gaps>500={v1['gaps500']} "
          f"auxgaps>500={v1['aux_gaps500']} blockset_bytes={v1['blockset_bytes']}", flush=True)
if SNAPREPORT:
    print(f"SNAPREPORT: have={HAVE} interest_full_t={interest_full_t} "
          f"snapshot_begin_t={snap_meta['begin']} snapshot_end_t={snap_meta['end']} "
          f"distinct_blocks_seen={len(seen_blocks)} blockset_bytes={v1['blockset_bytes']} "
          f"burst_done={burst_done}", flush=True)
    # Dump per-block content hashes so two separate probe runs (e.g. a fresh-snapshot
    # control vs. a resumed reconnect) can be diffed for byte-identical decoded records
    # (WA-11 resume-equivalence acceptance check).
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"snapreport_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({
            "have": HAVE, "world_seq": v1["world_seq"],
            "distinct_blocks": len(seen_blocks), "blockset_bytes": v1["blockset_bytes"],
            "block_crc": {f"{k[0]},{k[1]},{k[2]}": v for k, v in block_crc.items()},
        }, f)
    print(f"SNAPREPORT dump written: {outpath}", flush=True)
if AUXDUMP:
    with_ah = {uid: r for uid, r in aux_units.items() if r["first_ah"] is not None}
    without_ah = {uid: r for uid, r in aux_units.items() if r["first_ah"] is None}
    print(f"AUXDUMP: units_seen={len(aux_units)} units_with_ah={len(with_ah)} "
          f"units_without_ah={len(without_ah)} bad_hash_count={len(aux_bad_hash)}", flush=True)
    if aux_bad_hash:
        print(f"AUXDUMP BAD HASH SAMPLES: {aux_bad_hash[:10]}", flush=True)
    slow = {uid: r["first_ah"] - r["first_seen"] for uid, r in with_ah.items()
            if r["first_ah"] - r["first_seen"] > 5.0}
    if slow:
        print(f"AUXDUMP: units whose ah took >5s after first sighting: {slow}", flush=True)
    print(f"AUXDUMP sample without ah (flat/animal candidates): {list(without_ah.keys())[:10]}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"auxdump_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"units_seen": len(aux_units), "units_with_ah": len(with_ah),
                   "units_without_ah": len(without_ah), "bad_hash": aux_bad_hash,
                   "detail": aux_units}, f, indent=1)
    print(f"AUXDUMP dump written: {outpath}", flush=True)
if ITEMTAILS:
    print(f"ITEMTAILS: samples={len(item_tail_samples)}", flush=True)
    for s in item_tail_samples[:10]:
        print(f"  block={s['block']} tile={s['tile_idx']} item_type={s['item_type']} "
              f"mat_type={s['mat_type']} mat_index={s['mat_index']} subtype={s['subtype']} "
              f"iflags=0b{s['iflags']:05b} stack={s['stack']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"itemtails_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"samples": item_tail_samples}, f, indent=1)
    print(f"ITEMTAILS dump written: {outpath}", flush=True)
if SPATTAILS:
    print(f"SPATTAILS: spatter_mat_samples={len(spatter_mat_samples)} "
          f"item_spatter_samples={len(item_spatter_samples)}", flush=True)
    for s in spatter_mat_samples[:10]:
        print(f"  spatter block={s['block']} tile={s['tile_idx']} mat_type={s['mat_type']} "
              f"mat_index={s['mat_index']} amount={s['amount']} state={s['state']}", flush=True)
    for s in item_spatter_samples[:10]:
        print(f"  item_spatter block={s['block']} tile={s['tile_idx']} "
              f"growth_class={s['growth_class']} item_type={s['item_type']} amount={s['amount']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"spattails_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"spatter_mat": spatter_mat_samples, "item_spatter": item_spatter_samples}, f, indent=1)
    print(f"SPATTAILS dump written: {outpath}", flush=True)
if FLOWTAILS:
    print(f"FLOWTAILS: samples={len(flow_samples)}", flush=True)
    for s in flow_samples[:10]:
        print(f"  block={s['block']} tile={s['tile_idx']} flow_type={s['flow_type']} density={s['density']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"flowtails_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"samples": flow_samples}, f, indent=1)
    print(f"FLOWTAILS dump written: {outpath}", flush=True)

if GRASSTAILS:
    print(f"GRASSTAILS: samples={len(grass_samples)}", flush=True)
    from collections import Counter
    _ids = Counter(s["id"] for s in grass_samples)
    _amts = [s["amount"] for s in grass_samples]
    if _amts:
        print(f"  species={dict(_ids.most_common(8))}", flush=True)
        print(f"  amount min={min(_amts)} max={max(_amts)} mean={sum(_amts)/len(_amts):.1f}", flush=True)
    for s in grass_samples[:10]:
        print(f"  block={s['block']} tile={s['tile_idx']} id={s['id']} amount={s['amount']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"grasstails_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"samples": grass_samples}, f, indent=1)
    print(f"GRASSTAILS dump written: {outpath}", flush=True)

if ENGTAILS:
    print(f"ENGTAILS: samples={len(eng_samples)}", flush=True)
    for s in eng_samples[:10]:
        print(f"  block={s['block']} tile={s['tile_idx']} eflags=0x{s['eflags']:04x} quality={s['quality']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"engtails_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"samples": eng_samples}, f, indent=1)
    print(f"ENGTAILS dump written: {outpath}", flush=True)

if DESIGREPORT:
    print(f"DESIGREPORT: target={DESIGTILE} block={desig_target_block} "
          f"tile_idx={desig_target_idx} transitions={len(desig_transitions)} "
          f"last_dig={desig_last_dig}", flush=True)
    for tr in desig_transitions:
        print(f"  t={tr['t']:.2f}s dig={tr['dig']} ({tr['dig_name']}) marker={tr['marker']} "
              f"block_ver={tr['block_ver']}", flush=True)
    import pathlib
    outdir = pathlib.Path(__file__).resolve().parent / "results"
    outdir.mkdir(exist_ok=True)
    outpath = outdir / f"desigreport_{PLAYER}.json"
    with open(outpath, "w") as f:
        json.dump({"target": DESIGTILE, "block": desig_target_block,
                    "tile_idx": desig_target_idx, "transitions": desig_transitions,
                    "last_dig": desig_last_dig}, f, indent=1)
    print(f"DESIGREPORT dump written: {outpath}", flush=True)
