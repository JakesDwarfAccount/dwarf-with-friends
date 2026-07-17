"""lag_lab.py -- end-to-end input->display lag lab for dwf WS transport.

Reproduces the "reported lag" symptom class LOCALLY, without WinDivert/admin, by modeling
what a lossy TCP path through an intermediary (cloudflared / CF edge) actually does:
the intermediary keeps READING from the origin eagerly (so the server never sees
backpressure and its single-slot coalescing never engages) while delivery to the
client is (a) throughput-limited (TCP cwnd collapse under loss) or (b) stalled in
bursts (retransmission head-of-line blocking). Frames queue in the middle; the client
then receives them ALL, in order.

Three actors:
  * SENDER  -- direct WS to the server as player "lagsender" (tiny 4x4 window),
               sends a smooth-cursor message every 100 ms whose integer `x` is a
               counter; records counter -> send time.
  * PROXY   -- localhost TCP proxy (127.0.0.1:8899 -> 127.0.0.1:8765). Modes:
                 direct              no proxy (receiver connects straight)
                 rate:<bytes/s>      server->client throughput cap, UNBOUNDED buffer
                 stall:<per>:<len>   every <per> s, freeze server->client for <len> s
               client->server direction is always forwarded eagerly.
  * RECEIVER-- WS via the proxy as player "lagrecv" (50x28 window = the bulk map
               stream). A "network thread" drains the socket eagerly (browsers always
               drain TCP; the message queue is in-process) and timestamps arrival.
               A simulated "main thread" consumes the queue under one of two models:
                 serial    -- process EVERY frame in order; each map frame costs
                              --proc ms (models inflate+JSON.parse+draw). This is
                              today's dwf-ws.js promise-chain behaviour.
                 dropstale -- per wake: coalesce queued map frames to the NEWEST
                              (older ones dropped unprocessed), cursors applied in
                              order (cheap). This is the proposed client fix.

Metric: for every cursors frame containing lagsender's counter,
  arrival_lag  = t_frame_fully_received - t_sent   (network + intermediary queue)
  display_lag  = t_processed_by_main_thread - t_sent (what the user actually sees)
The difference display-arrival is the CLIENT-side contribution; arrival_lag is the
TRANSPORT contribution. Drop-stale can only fix the former.

Usage:
  python lag_lab.py <mode> <client_model> [secs] [--proc MS] [--rate BPS] \
                    [--stall PER:LEN] [--label NAME]
  mode: direct | rate | stall
Examples:
  python lag_lab.py direct serial 40
  python lag_lab.py rate serial 45 --rate 80000
  python lag_lab.py rate dropstale 45 --rate 80000
  python lag_lab.py stall serial 45 --stall 8:2 --proc 12
  python lag_lab.py stall dropstale 45 --stall 8:2 --proc 12
"""
import socket, base64, os, sys, time, struct, threading, json, re
from collections import deque

SERVER = ("127.0.0.1", 8765)
PROXY_ADDR = ("127.0.0.1", 8899)

# ---------------- tiny WS client ----------------
class Ws:
    def __init__(self, host, port, player, w, h, proto1=False):
        self.proto1 = proto1
        self.s = socket.create_connection((host, port), timeout=15)
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        url = f"/ws?player={player}&w={w}&h={h}" + ("&proto=1" if proto1 else "")
        req = (f"GET {url} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            c = self.s.recv(4096)
            if not c: raise ConnectionError("closed in handshake")
            resp += c
        head, _, rest = resp.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise ConnectionError("handshake rejected: " + head.decode(errors="replace"))
        self.buf = bytearray(rest)
        self.s.settimeout(0.5)
        if proto1:
            self.send_text({"type": "hello", "proto": 1, "player": player, "have": 0,
                            "cam": {"x": 0, "y": 0, "z": 100, "w": w, "h": h}})

    def send_frame(self, op, payload=b""):
        mask = os.urandom(4)
        hdr = bytes([0x80 | op])
        L = len(payload)
        if L < 126: hdr += bytes([0x80 | L])
        elif L < 65536: hdr += bytes([0x80 | 126]) + struct.pack(">H", L)
        else: hdr += bytes([0x80 | 127]) + struct.pack(">Q", L)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send_text(self, obj):
        self.send_frame(1, json.dumps(obj).encode())

    def _need(self, n):
        while len(self.buf) < n:
            try:
                c = self.s.recv(262144)
            except socket.timeout:
                return False
            if not c: raise ConnectionError("peer closed")
            self.buf.extend(c)
        return True

    def recv_frame(self):
        """Returns (opcode, payload) or None on timeout. Auto-answers ping."""
        while True:
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
            if op == 9: self.send_frame(10, payload); continue
            return op, payload

# ---------------- proxy ----------------
class Proxy(threading.Thread):
    """Eager-read intermediary: always drains the server (like cloudflared), delivers
    to the client under a rate cap or scheduled stalls. Buffer is unbounded and its
    depth is sampled so we can report intermediary queue occupancy."""
    def __init__(self, mode, rate_bps=0, stall_per=0.0, stall_len=0.0, rcvbuf=0):
        super().__init__(daemon=True)
        self.mode, self.rate = mode, rate_bps
        self.per, self.slen = stall_per, stall_len
        # Optional small SO_RCVBUF on the server-facing socket: caps the TCP flow-control
        # window so a half-open server saturates its send buffer FAST (models the real
        # cloudflared path, whose bounded ~1 MB window is the buffer-bloat mechanism, §D --
        # Windows autotuning otherwise grows the window to many MB, which on an idle/low-rate
        # fort delays saturation for tens of seconds).
        self.rcvbuf = rcvbuf
        self.qs = deque()             # server->client pending chunks
        self.qs_bytes = 0
        self.peak = 0
        self.lock = threading.Lock()
        self.up = threading.Event()
        self.stalled = False
        # Impairment triggers for the WA-1 / WA-3 prune tests (proxyonly model):
        #   frozen         -> stop draining the SERVER (its send buffer fills -> writer send-
        #                     fail after kSendStallCapMs -> A2 zombie prune). Used by half-open.
        #   deliver_frozen -> stop delivering to the client AND stop forwarding client->server
        #                     (pongs blocked) while STILL draining the server (sends succeed,
        #                     no backpressure) -> A3 ping-silence 45 s prune. Used by freeze.
        self.frozen = threading.Event()
        self.deliver_frozen = threading.Event()
        self.cli_sock = None
        self.srv_sock = None

    def run(self):
        lst = socket.socket()
        lst.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        lst.bind(PROXY_ADDR); lst.listen(1)
        self.up.set()
        cli, _ = lst.accept()
        if self.rcvbuf > 0:
            # SO_RCVBUF must be set BEFORE connect() to actually cap the window (it disables
            # Windows receive-window autotuning for this socket). Set after connect it's a no-op
            # against an already-grown multi-MB buffer.
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self.rcvbuf)
            srv.connect(SERVER)
        else:
            srv = socket.create_connection(SERVER)
        for s in (cli, srv):
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.cli_sock, self.srv_sock = cli, srv
        srv.settimeout(0.5)           # so the drain loop can notice `frozen`
        threading.Thread(target=self._pump_c2s, args=(cli, srv), daemon=True).start()
        threading.Thread(target=self._drain_server, args=(srv,), daemon=True).start()
        self._deliver(cli)

    def trigger_half_open(self):
        """WA-1 A2: close the client socket and stop draining the server, keeping the server
        socket OPEN. The server's send buffer fills -> its writer send-fails after the cap ->
        the (fixed) writer closes the fd -> the connection is pruned."""
        self.frozen.set()
        try:
            if self.cli_sock: self.cli_sock.close()
        except OSError: pass

    def trigger_freeze(self):
        """WA-3 A3: block BOTH directions but keep both sockets open and keep draining the
        server (so its sends still succeed -- no backpressure). The client's PONGs never reach
        the server, so only the 45 s inbound-silence sweep can prune it."""
        self.deliver_frozen.set()

    def trigger_unfreeze(self):
        """Restore forwarding (WA-3 client-recovery test: the path comes back after the client's
        watchdog has already flipped to reconnect/poll)."""
        self.deliver_frozen.clear()
        self.frozen.clear()

    def _pump_c2s(self, cli, srv):
        try:
            while True:
                d = cli.recv(65536)
                if not d: break
                if self.deliver_frozen.is_set():
                    continue          # drop client->server (block PONGs) but keep cli drained
                srv.sendall(d)
        except OSError: pass

    def _drain_server(self, srv):
        try:
            while True:
                if self.frozen.is_set():
                    time.sleep(0.1); continue   # stop reading -> server send buffer fills
                try:
                    d = srv.recv(262144)
                except socket.timeout:
                    continue
                if not d: break
                with self.lock:
                    self.qs.append(d); self.qs_bytes += len(d)
                    self.peak = max(self.peak, self.qs_bytes)
        except OSError: pass

    def _deliver(self, cli):
        t0 = time.time()
        budget = 0.0
        last = t0
        try:
            while True:
                if self.deliver_frozen.is_set():
                    time.sleep(0.05); continue   # WA-3 freeze: stop delivering to the client
                now = time.time()
                if self.mode == "stall":
                    ph = (now - t0) % self.per
                    self.stalled = ph >= (self.per - self.slen)
                    if self.stalled:
                        time.sleep(0.005); continue
                if self.mode == "rate":
                    budget += (now - last) * self.rate
                    budget = min(budget, 65536.0)
                last = now
                chunk = None
                with self.lock:
                    if self.qs:
                        c0 = self.qs[0]
                        if self.mode == "rate":
                            n = int(min(len(c0), max(0, budget)))
                            if n == 0:
                                chunk = None
                            elif n == len(c0):
                                chunk = self.qs.popleft()
                            else:
                                chunk = c0[:n]; self.qs[0] = c0[n:]
                        else:
                            chunk = self.qs.popleft()
                        if chunk:
                            self.qs_bytes -= len(chunk)
                if chunk:
                    if self.mode == "rate": budget -= len(chunk)
                    cli.sendall(chunk)
                else:
                    time.sleep(0.002)
        except OSError:
            pass

    def depth(self):
        with self.lock: return self.qs_bytes

# ---------------- sender ----------------
class Sender(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.times = {}               # counter -> send time (monotonic)
        self.lock = threading.Lock()
        self.n = 0
        self.stop = False

    def run(self):
        ws = Ws(*SERVER, "lagsender", 4, 4)
        nxt = time.monotonic()
        while not self.stop:
            now = time.monotonic()
            if now >= nxt:
                nxt += 0.1
                self.n += 1
                with self.lock:
                    self.times[self.n] = now
                    if len(self.times) > 3000:      # bound memory
                        for k in list(self.times)[:1000]: self.times.pop(k, None)
                msg = ('{"type":"cursor","x":%d,"y":7,"z":50,"fx":0.5,"fy":0.5,"drag":0}'
                       % self.n).encode()
                try: ws.send_frame(1, msg)
                except OSError: return
            # drain inbound so our socket stays healthy (we ignore content)
            try: ws.recv_frame()
            except (ConnectionError, OSError): return

    def sent_at(self, counter):
        with self.lock: return self.times.get(counter)

# ---------------- receiver ----------------
CUR_RE = re.compile(rb'"name":"lagsender".*?"x":(\d+)')

def run_receiver(via_proxy, model, dur, proc_ms, sender, proxy):
    host, port = (PROXY_ADDR if via_proxy else SERVER)
    proto1 = (model == "v1")
    ws = Ws(host, port, "lagrecv", 50, 28, proto1=proto1)
    q = deque()                       # (t_arrival, kind, payload_len, counter_or_None)
    qlock = threading.Lock()
    netstop = threading.Event()

    def net_thread():
        while not netstop.is_set():
            try:
                fr = ws.recv_frame()
            except (ConnectionError, OSError):
                return
            if fr is None: continue
            op, payload = fr
            t = time.monotonic()
            if op == 2 and proto1 and len(payload) >= 10 and payload[0] == 0x44 and payload[1] == 0x35:
                # v1 binary frame: ACK IMMEDIATELY on arrival (measures the network, not the
                # client -- §WA-12.1), then enqueue as a "map" for the apply-all model.
                seq = struct.unpack("<I", payload[6:10])[0]
                try: ws.send_text({"type": "ack", "seq": seq, "t": int(t * 1000)})
                except OSError: return
                with qlock: q.append((t, "map", len(payload), None))
            elif op == 1 and payload.startswith(b'{"type":"cursors"'):
                m = CUR_RE.search(payload)
                c = int(m.group(1)) if m else None
                with qlock: q.append((t, "cur", len(payload), c))
            elif op == 1 and proto1 and payload.startswith(b'{"type":"ping"'):
                try:
                    m = json.loads(payload.decode("utf-8", "replace"))
                    ws.send_text({"type": "pong", "ts": m.get("ts"), "tc": int(t * 1000)})
                except (OSError, ValueError): pass
            elif op in (1, 2):
                with qlock: q.append((t, "map", len(payload), None))

    threading.Thread(target=net_thread, daemon=True).start()

    arr_lags, disp_lags = [], []      # (t, lag_s)
    dropped = 0; processed_maps = 0
    peak_backlog = 0
    t0 = time.monotonic()
    last_report = t0
    while time.monotonic() - t0 < dur:
        with qlock:
            batch = list(q); q.clear()
        peak_backlog = max(peak_backlog, len(batch))
        if not batch:
            time.sleep(0.002); continue
        if model == "serial":
            for (ta, kind, ln, c) in batch:
                if kind == "map":
                    time.sleep(proc_ms / 1000.0)   # inflate+parse+draw model
                    processed_maps += 1
                elif c is not None:
                    ts = sender.sent_at(c)
                    if ts:
                        now = time.monotonic()
                        arr_lags.append((now, ta - ts)); disp_lags.append((now, now - ts))
        elif model == "v1":
            # Drop-stale collapses to apply-all (§0.6/§WA-12.3): BLOCK_SET application is
            # idempotent + order-free and pacing bounds inflight to K frames, so there is no
            # backlog to coalesce -- apply every map cheaply, rAF-batched. Cursors in order.
            maps = [b for b in batch if b[1] == "map"]
            curs = [b for b in batch if b[1] == "cur"]
            processed_maps += len(maps)            # cheap idempotent apply (no proc sleep)
            for (ta, kind, ln, c) in curs:
                if c is not None:
                    ts = sender.sent_at(c)
                    if ts:
                        now = time.monotonic()
                        arr_lags.append((now, ta - ts)); disp_lags.append((now, now - ts))
        else:  # dropstale
            maps = [b for b in batch if b[1] == "map"]
            curs = [b for b in batch if b[1] == "cur"]
            if maps:
                dropped += len(maps) - 1
                time.sleep(proc_ms / 1000.0)       # pay for the NEWEST map only
                processed_maps += 1
            for (ta, kind, ln, c) in curs:
                if c is not None:
                    ts = sender.sent_at(c)
                    if ts:
                        now = time.monotonic()
                        arr_lags.append((now, ta - ts)); disp_lags.append((now, now - ts))
        now = time.monotonic()
        if now - last_report >= 5.0:
            last_report = now
            recent = [l for (t, l) in disp_lags if now - t <= 5.0]
            recenta = [l for (t, l) in arr_lags if now - t <= 5.0]
            d = proxy.depth() if proxy else 0
            print(f"[{now-t0:5.1f}s] disp p50={med(recent)*1000:6.0f}ms max={mx(recent)*1000:6.0f}ms | "
                  f"arrival p50={med(recenta)*1000:6.0f}ms | proxybuf={d/1024:6.0f}KiB | "
                  f"backlog_peak={peak_backlog} dropped={dropped}", flush=True)
            peak_backlog = 0
    netstop.set()

    # summary over the LAST 20s (steady state)
    cut = time.monotonic() - 20.0
    fd = sorted(l for (t, l) in disp_lags if t >= cut)
    fa = sorted(l for (t, l) in arr_lags if t >= cut)
    def pct(v, p): return v[min(len(v)-1, int(p*len(v)))] if v else float("nan")
    print("---- SUMMARY (last 20s) ----")
    print(f"display lag  p50={pct(fd,.5)*1000:.0f}ms p95={pct(fd,.95)*1000:.0f}ms max={(fd[-1] if fd else float('nan'))*1000:.0f}ms  (n={len(fd)})")
    print(f"arrival lag  p50={pct(fa,.5)*1000:.0f}ms p95={pct(fa,.95)*1000:.0f}ms max={(fa[-1] if fa else float('nan'))*1000:.0f}ms")
    print(f"client contribution p50={(pct(fd,.5)-pct(fa,.5))*1000:.0f}ms | maps processed={processed_maps} dropped={dropped}")
    if proxy: print(f"proxy peak buffer={proxy.peak/1024:.0f} KiB")

def med(v): return sorted(v)[len(v)//2] if v else float("nan")
def mx(v): return max(v) if v else float("nan")

# ---------------- proxyonly (no built-in sender/receiver) ----------------
def run_proxyonly(dur, proxy, halfopen, freeze, unfreeze=0.0):
    """WA-1 deliverable: run ONLY the impairment proxy so an EXTERNAL probe (ws_probe.py,
    the real browser client, ...) can connect through 127.0.0.1:8899. Optionally trigger a
    half-open (WA-1 A2) or a both-directions freeze (WA-3 A3) at a wall-clock offset, then
    report the proxy buffer depth once a second so the prune can be observed via /diag."""
    print(f"== proxyonly: forwarding {PROXY_ADDR[0]}:{PROXY_ADDR[1]} -> {SERVER[0]}:{SERVER[1]} "
          f"for {dur}s; connect your probe to {PROXY_ADDR[1]} "
          f"(halfopen={halfopen} freeze={freeze}) ==", flush=True)
    t0 = time.time()
    did = False; unfroze = False
    while time.time() - t0 < dur:
        time.sleep(1.0)
        el = time.time() - t0
        if not did and halfopen and el >= halfopen:
            proxy.trigger_half_open(); did = True
            print(f"[{el:5.1f}s] HALF-OPEN: client socket closed + server drain frozen "
                  f"(server send buffer fills -> writer send-fail -> prune)", flush=True)
        elif not did and freeze and el >= freeze:
            proxy.trigger_freeze(); did = True
            print(f"[{el:5.1f}s] FREEZE: both directions blocked, sockets kept open, server "
                  f"still drained (no PONG -> 45s ping-silence prune)", flush=True)
        if unfreeze and not unfroze and el >= unfreeze:
            proxy.trigger_unfreeze(); unfroze = True
            print(f"[{el:5.1f}s] UNFREEZE: forwarding restored (path recovers)", flush=True)
        print(f"[{el:5.1f}s] proxybuf={proxy.depth()/1024:7.0f}KiB "
              f"frozen={int(proxy.frozen.is_set())} deliverFrozen={int(proxy.deliver_frozen.is_set())}",
              flush=True)

# ---------------- main ----------------
def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "direct"
    model = sys.argv[2] if len(sys.argv) > 2 else "serial"
    dur = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 45
    proc = 12.0; rate = 80000; stall = (8.0, 2.0); label = ""
    halfopen = 0.0; freeze = 0.0; unfreeze = 0.0; rcvbuf = 0
    args = sys.argv[4:]
    i = 0
    while i < len(args):
        if args[i] == "--proc": proc = float(args[i+1]); i += 2
        elif args[i] == "--rate": rate = int(args[i+1]); i += 2
        elif args[i] == "--stall":
            a, b = args[i+1].split(":"); stall = (float(a), float(b)); i += 2
        elif args[i] == "--label": label = args[i+1]; i += 2
        elif args[i] == "--halfopen": halfopen = float(args[i+1]); i += 2
        elif args[i] == "--freeze": freeze = float(args[i+1]); i += 2
        elif args[i] == "--unfreeze": unfreeze = float(args[i+1]); i += 2
        elif args[i] == "--rcvbuf": rcvbuf = int(args[i+1]); i += 2
        else: i += 1
    print(f"== lag_lab mode={mode} model={model} dur={dur}s proc={proc}ms "
          f"rate={rate} stall={stall} {label} ==", flush=True)
    proxy = None
    if mode != "direct":
        proxy = Proxy(mode, rate_bps=rate, stall_per=stall[0], stall_len=stall[1], rcvbuf=rcvbuf)
        proxy.start(); proxy.up.wait()
        time.sleep(0.2)
    # proxyonly: no built-in sender/receiver -- just the proxy, for an external probe.
    if model == "proxyonly":
        if proxy is None:
            print("proxyonly needs a proxy: use a non-'direct' mode (e.g. `pass proxyonly`)")
            return
        run_proxyonly(dur, proxy, halfopen, freeze, unfreeze)
        return
    sender = Sender(); sender.start()
    time.sleep(1.0)                    # let the sender's cursor register
    run_receiver(mode != "direct", model, dur, proc, sender, proxy)
    sender.stop = True

if __name__ == "__main__":
    main()
