"""WE-5 leak probe: connect to the WS as a player, park/pan the camera over an
unrevealed unit's position (natural fixture: any unit standing on a hidden tile),
inflate every map frame for --secs, and grep the JSON for the unit ids / race
tokens that must NOT appear. Also polls /mapdata each second (same emit body).

Usage: python we5_ws_leak_probe.py --x 144 --y 90 --z 0 --ids 5893 --tokens DEMON --secs 30
Exit 0 = no leak. Evidence JSON: results/we5-leak-<utc>.json
"""
import argparse, base64, json, os, socket, struct, sys, time, urllib.request, zlib
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOST, PORT = "127.0.0.1", 8765
W, H = 50, 28
PLAYER = "we5leak"

def http_post(url):
    req = urllib.request.Request(url, method="POST", data=b"")
    with urllib.request.urlopen(req, timeout=8) as r:
        return r.read()

def http_json(path):
    with urllib.request.urlopen(f"http://{HOST}:{PORT}{path}", timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))

def ws_connect():
    s = socket.create_connection((HOST, PORT), timeout=15)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET /ws?player={PLAYER}&w={W}&h={H} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n"
           f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
           f"Sec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        c = s.recv(4096)
        if not c: raise ConnectionError("closed during handshake")
        resp += c
    head, _, rest = resp.partition(b"\r\n\r\n")
    if b"101" not in head.split(b"\r\n")[0]:
        raise ConnectionError("handshake: " + head.decode(errors="replace")[:200])
    return s, bytearray(rest)

def send_frame(s, op, payload=b""):
    mask = os.urandom(4)
    hdr = bytes([0x80 | op])
    L = len(payload)
    if L < 126: hdr += bytes([0x80 | L])
    elif L < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", L)
    else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", L)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--x", type=int, required=True)
    ap.add_argument("--y", type=int, required=True)
    ap.add_argument("--z", type=int, required=True)
    ap.add_argument("--ids", type=str, default="", help="comma-separated unit ids that must not appear")
    ap.add_argument("--tokens", type=str, default="", help="comma-separated substrings that must not appear")
    ap.add_argument("--secs", type=int, default=30)
    args = ap.parse_args()
    forbidden_ids = [i for i in args.ids.split(",") if i]
    forbidden_tokens = [t for t in args.tokens.split(",") if t]

    # camera centered on the target
    cx, cy = args.x - W // 2, args.y - H // 2
    http_post(f"http://{HOST}:{PORT}/camera?player={PLAYER}&x={cx}&y={cy}&z={args.z}")

    s, buf = ws_connect()
    s.settimeout(2.0)

    frames = 0
    text_bytes = 0
    leaks = []
    mapdata_polls = 0
    t0 = time.time()
    last_poll = 0.0
    last_pan = 0.0
    pan_flip = 1

    def scan(txt, source):
        for fid in forbidden_ids:
            if f'"id":{fid}' in txt or f'"id": {fid}' in txt:
                leaks.append({"source": source, "match": f"id:{fid}"})
        for tok in forbidden_tokens:
            if tok in txt:
                leaks.append({"source": source, "match": tok})

    def need(n):
        while len(buf) < n:
            try:
                c = s.recv(65536)
            except socket.timeout:
                return False
            if not c: raise ConnectionError("peer closed")
            buf.extend(c)
        return True

    while time.time() - t0 < args.secs:
        now = time.time()
        if now - last_pan > 3:      # small pan keeps keyframes coming (window change)
            last_pan = now
            pan_flip = -pan_flip
            try:
                http_post(f"http://{HOST}:{PORT}/camera?player={PLAYER}&dx={pan_flip}&dy=0")
            except Exception:
                pass
        if now - last_poll > 1:
            last_poll = now
            try:
                md = http_json(f"/mapdata?player={PLAYER}&w={W}&h={H}")
                mapdata_polls += 1
                scan(json.dumps(md), "mapdata")
            except Exception:
                pass
        if not need(2): continue
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
        if op == 9: send_frame(s, 10, payload); continue
        if op == 8: break
        txt = None
        if op == 1:
            txt = payload.decode("utf-8", errors="replace")
        elif op == 2:
            try:
                txt = zlib.decompress(payload).decode("utf-8", errors="replace")
            except Exception:
                txt = None
        if txt is not None:
            frames += 1
            text_bytes += len(txt)
            scan(txt, f"ws-op{op}")

    try: s.close()
    except Exception: pass

    result = {
        "gate": "we5-leak-probe", "utc": datetime.now(timezone.utc).isoformat(),
        "target": {"x": args.x, "y": args.y, "z": args.z},
        "forbidden_ids": forbidden_ids, "forbidden_tokens": forbidden_tokens,
        "secs": args.secs, "ws_frames_scanned": frames, "ws_text_bytes": text_bytes,
        "mapdata_polls": mapdata_polls, "leaks": leaks, "pass": not leaks,
    }
    out = HERE / "results" / f"we5-leak-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    print(("LEAK PROBE PASS" if result["pass"] else "LEAK PROBE FAIL") + f"  evidence: {out}")
    return 0 if result["pass"] else 1

if __name__ == "__main__":
    sys.exit(main())
