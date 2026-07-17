"""wedge_probe.py -- WA-2 acceptance for the per-type latest-wins writer.

Two independent checks (run one, or both by default):

  cursor : prove a WEDGED client no longer freezes another player's cursor stream (A1).
           Probe A connects and NEVER reads (its send buffer backs up). A "mover" sends
           cursor updates at 25 Hz. Probe B connects normally and measures inter-`cursors`
           -frame gaps for the duration. PASS: B's cursor cadence stays ~25 Hz with p95
           gap < 120 ms (pre-fix it collapsed to ~10 s freezes when A wedged).

  seed   : prove the queued seed keyframe (A6) never lets a STALE-dims keyframe be applied
           after a current-dims one. N rapid connect/disconnect cycles alternate the /ws
           window dims; each connection inflates its keyframes and checks that once a
           keyframe matching the requested dims is seen, no later keyframe with different
           dims arrives. PASS: zero such violations across all cycles.

Usage:
  python wedge_probe.py [cursor|seed|both] [secs_or_cycles]
  python wedge_probe.py cursor 60
  python wedge_probe.py seed 50
"""
import socket, base64, os, sys, time, struct, threading, zlib, re

SERVER = ("127.0.0.1", 8765)


class Ws:
    def __init__(self, player, w, h, read=True):
        self.s = socket.create_connection(SERVER, timeout=15)
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /ws?player={player}&w={w}&h={h} HTTP/1.1\r\nHost: 127.0.0.1\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            c = self.s.recv(4096)
            if not c:
                raise ConnectionError("closed in handshake")
            resp += c
        if b"101" not in resp.split(b"\r\n", 1)[0]:
            raise ConnectionError("handshake rejected")
        self.buf = bytearray(resp.split(b"\r\n\r\n", 1)[1])
        self.s.settimeout(0.5)

    def send(self, op, payload=b""):
        mask = os.urandom(4)
        hdr = bytes([0x80 | op])
        L = len(payload)
        if L < 126: hdr += bytes([0x80 | L])
        elif L < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", L)
        else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", L)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def _need(self, n):
        while len(self.buf) < n:
            try: c = self.s.recv(262144)
            except socket.timeout: return False
            if not c: raise ConnectionError("peer closed")
            self.buf.extend(c)
        return True

    def recv(self):
        """(opcode, payload) or None on timeout. Auto-answers ping."""
        if not self._need(2): return None
        b1, b2 = self.buf[0], self.buf[1]
        op = b1 & 0x0F; L = b2 & 0x7F; off = 2
        if L == 126:
            if not self._need(4): return None
            L = struct.unpack(">H", bytes(self.buf[2:4]))[0]; off = 4
        elif L == 127:
            if not self._need(10): return None
            L = struct.unpack(">Q", bytes(self.buf[2:10]))[0]; off = 10
        if not self._need(off + L): return None
        payload = bytes(self.buf[off:off+L]); del self.buf[:off+L]
        if op == 9: self.send(10, payload); return self.recv()
        return op, payload

    def close(self):
        try: self.s.close()
        except OSError: pass


# ---------------- cursor-cadence-under-wedge (A1) ----------------
def run_cursor(dur):
    print(f"== cursor: 1 wedged reader + 25 Hz mover; measuring probe B cadence for {dur}s ==",
          flush=True)
    # A: connects, requests a big window, and NEVER reads -> its send buffer backs up.
    a = Ws("wedgeA", 50, 28)
    # Mover: streams a cursor at 25 Hz so the server has an active cursor to broadcast.
    mover = Ws("wedgeMover", 4, 4)
    mstop = threading.Event()
    def move():
        n = 0
        nxt = time.monotonic()
        while not mstop.is_set():
            now = time.monotonic()
            if now >= nxt:
                nxt += 0.04
                n += 1
                try:
                    mover.send(1, ('{"type":"cursor","x":%d,"y":10,"z":50,"fx":0.5,"fy":0.5,'
                                   '"drag":0}' % (n % 90)).encode())
                except OSError: return
            try: mover.recv()
            except (ConnectionError, OSError): return
    threading.Thread(target=move, daemon=True).start()

    # B: connects normally, drains, timestamps every `cursors` frame.
    b = Ws("wedgeB", 50, 28)
    cur_times = []
    t0 = time.monotonic()
    last_a_push = t0
    try:
        while time.monotonic() - t0 < dur:
            # Keep A wedged: nudge its camera so the server keeps pushing it big frames it
            # never reads (buffer stays full). Cheap HTTP POST, no read on A.
            if time.monotonic() - last_a_push > 0.3:
                last_a_push = time.monotonic()
                try:
                    import urllib.request
                    d = 8 if int(last_a_push) % 2 else -8
                    urllib.request.urlopen(
                        f"http://127.0.0.1:8765/camera?player=wedgeA&dx={d}&dy=0",
                        data=b"", timeout=2).read()
                except Exception: pass
            fr = b.recv()
            if fr is None: continue
            op, payload = fr
            if op == 1 and payload.startswith(b'{"type":"cursors"'):
                cur_times.append(time.monotonic())
    finally:
        mstop.set(); a.close(); b.close(); mover.close()

    gaps = [ (cur_times[i] - cur_times[i-1]) * 1000.0 for i in range(1, len(cur_times)) ]
    gaps.sort()
    n = len(gaps)
    def pct(p): return gaps[min(n - 1, int(p * n))] if n else float("nan")
    cadence = len(cur_times) / dur
    p50 = pct(0.5); p95 = pct(0.95); mx = gaps[-1] if gaps else float("nan")
    print(f"   B cursors frames={len(cur_times)} cadence={cadence:.1f}/s "
          f"gap p50={p50:.0f}ms p95={p95:.0f}ms max={mx:.0f}ms", flush=True)
    ok = (cadence >= 15.0) and (p95 < 120.0)
    print(f"   cursor: {'PASS' if ok else 'FAIL'} "
          f"(need cadence>=15/s and p95 gap<120ms while a peer is wedged)", flush=True)
    return ok


# ---------------- seed-race (A6) ----------------
_WMODE = re.compile(rb'"mode":"(key|delta)"')
_WW = re.compile(rb'"width":(\d+)')
_WH = re.compile(rb'"height":(\d+)')

def _text_of(op, payload):
    if op == 2:
        try: return zlib.decompress(payload)   # keyframes are zlib/RFC1950 deflated
        except zlib.error: return b""
    return payload

def run_seed(cycles):
    print(f"== seed: {cycles} connect/disconnect cycles, alternating dims; asserting no "
          f"stale-dims keyframe applied after a current one ==", flush=True)
    dims = [(50, 28), (60, 34)]
    violations = 0
    total_key = 0
    for c in range(cycles):
        w, h = dims[c % 2]
        try:
            ws = Ws("seedrace", w, h)
        except (ConnectionError, OSError):
            time.sleep(0.05); continue
        current_seen = False
        t0 = time.monotonic()
        try:
            while time.monotonic() - t0 < 0.4:
                fr = ws.recv()
                if fr is None: continue
                op, payload = fr
                txt = _text_of(op, payload)
                m = _WMODE.search(txt)
                if not m or m.group(1) != b"key":
                    continue
                mw = _WW.search(txt); mh = _WH.search(txt)
                if not mw or not mh:
                    continue
                total_key += 1
                kw, kh = int(mw.group(1)), int(mh.group(1))
                is_current = (kw == w and kh == h)
                if is_current:
                    current_seen = True
                elif current_seen:
                    violations += 1
                    print(f"   VIOLATION cycle {c}: applied stale-dims keyframe {kw}x{kh} "
                          f"AFTER a current {w}x{h}", flush=True)
        except (ConnectionError, OSError):
            pass
        finally:
            ws.close()
        time.sleep(0.03)
    ok = (violations == 0)
    print(f"   seed: keyframes inspected={total_key} violations={violations} -> "
          f"{'PASS' if ok else 'FAIL'}", flush=True)
    return ok


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    n = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    results = []
    if mode in ("cursor", "both"):
        results.append(run_cursor(n if (n and mode == "cursor") else 60))
    if mode in ("seed", "both"):
        results.append(run_seed(n if (n and mode == "seed") else 50))
    print("OVERALL:", "PASS" if all(results) else "FAIL", flush=True)
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
