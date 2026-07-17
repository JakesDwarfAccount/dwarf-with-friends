#!/usr/bin/env python
"""cdp_probe.py -- minimal Chrome DevTools Protocol driver for the harness.

Written 2026-07-08 (overnight run): the agent-browser CLI's engine RPC is broken
machine-wide (engine executes commands but never replies; every CLI call dies with
"EOF while parsing"). Chrome itself + CDP are healthy, so this drives the browser
directly. Requires `pip install websocket-client` (installed machine-wide tonight).

Port discovery: scans agent-browser chrome user-data-dirs under %TEMP% for
DevToolsActivePort, or use --port. `launch` starts the bundled agent-browser chrome
with a fixed debug port and its own profile dir (safe: never touches the Chrome).

Usage:
  python cdp_probe.py targets                          # list open pages
  python cdp_probe.py launch [URL] [--port 9333]       # start chrome, print port
  python cdp_probe.py shot OUT.png [--match SUBSTR]    # screenshot first matching page
  python cdp_probe.py eval "JS" [--match SUBSTR]       # Runtime.evaluate (returnByValue)
  python cdp_probe.py metrics W H [--match SUBSTR]     # Emulation.setDeviceMetricsOverride
  python cdp_probe.py click X Y [--match SUBSTR]       # mouse press+release at CSS px
  python cdp_probe.py open URL [--match SUBSTR]        # navigate matching page
  python cdp_probe.py key TEXT [--match SUBSTR]        # Input.insertText
All commands take [--port N]; default: first discovered port.
--match matches target url or title (default: first page target).
"""
import argparse, base64, glob, json, os, subprocess, sys, tempfile, time
import urllib.request

try:
    import websocket
except ImportError:
    sys.exit("pip install websocket-client first")


def discover_ports(max_probe=6):
    # dozens of stale profile dirs accumulate; probe only the newest few
    cands = []
    for pat in (os.path.join(tempfile.gettempdir(), "agent-browser-chrome-*", "DevToolsActivePort"),
                os.path.join(tempfile.gettempdir(), "cdp-probe-*", "DevToolsActivePort")):
        for f in glob.glob(pat):
            try:
                cands.append((os.path.getmtime(f), int(open(f).readline().strip())))
            except (OSError, ValueError):
                pass
    ports = []
    for _, port in sorted(cands, reverse=True)[:max_probe]:
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=2)
            ports.append(port)
        except OSError:
            pass
    return ports  # newest profile first


def pages(port):
    data = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=5))
    return [t for t in data if t.get("type") == "page"]


def pick(port, match):
    ps = pages(port)
    if match:
        ps = [t for t in ps if match.lower() in t.get("url", "").lower()
              or match.lower() in t.get("title", "").lower()]
    if not ps:
        sys.exit("no page target%s on port %d" % (" matching %r" % match if match else "", port))
    return ps[0]


class CDP:
    def __init__(self, target):
        self.ws = websocket.create_connection(target["webSocketDebuggerUrl"],
                                              timeout=30, suppress_origin=True)
        self.mid = 0

    def call(self, method, **params):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.mid:
                if "error" in msg:
                    sys.exit("CDP error: %s" % msg["error"])
                return msg.get("result", {})


def find_chrome():
    hits = glob.glob(os.path.expanduser("~/.agent-browser/browsers/chrome-*/chrome.exe")) or \
           glob.glob(os.path.expanduser("~/.agent-browser/browsers/chrome-*/**/chrome.exe"), recursive=True)
    if not hits:
        sys.exit("no bundled chrome under ~/.agent-browser/browsers")
    return sorted(hits)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["targets", "launch", "shot", "eval", "click", "open", "key", "metrics"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--port", type=int)
    ap.add_argument("--match")
    a = ap.parse_args()

    if a.cmd == "launch":
        port = a.port or 9333
        profile = tempfile.mkdtemp(prefix="cdp-probe-")
        url = a.args[0] if a.args else "about:blank"
        subprocess.Popen([find_chrome(), "--remote-debugging-port=%d" % port,
                          "--user-data-dir=" + profile, "--no-first-run",
                          "--no-default-browser-check", "--window-size=1280,800",
                          # keep rAF running at full rate even when the window is not the
                          # foreground/focused window -- required for perf measurement
                          # (gate_userperf.py); Chrome otherwise throttles a backgrounded or
                          # occluded tab's requestAnimationFrame to ~0, which reads as a fake
                          # 0-fps stall. Harmless for the other cdp_probe commands.
                          "--disable-background-timer-throttling",
                          "--disable-backgrounding-occluded-windows",
                          "--disable-renderer-backgrounding",
                          url],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            time.sleep(0.5)
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=2)
                print(json.dumps({"port": port, "profile": profile}))
                return
            except OSError:
                pass
        sys.exit("chrome did not come up on port %d" % port)

    port = a.port or (discover_ports() or [None])[0]
    if not port:
        sys.exit("no live CDP port found; use `launch` or --port")

    if a.cmd == "targets":
        for t in pages(port):
            print(port, "|", t["title"][:40], "|", t["url"][:100])
        return

    cdp = CDP(pick(port, a.match))
    if a.cmd == "shot":
        out = a.args[0]
        png = base64.b64decode(cdp.call("Page.captureScreenshot", format="png")["data"])
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        open(out, "wb").write(png)
        print("saved %d bytes -> %s" % (len(png), out))
    elif a.cmd == "eval":
        r = cdp.call("Runtime.evaluate", expression=a.args[0], returnByValue=True,
                     awaitPromise=True)
        print(json.dumps(r.get("result", {}).get("value"), default=str))
    elif a.cmd == "metrics":
        # Force a fixed layout viewport (gate_userperf.py drives 2560x1400 so "wide" zoom hits
        # ~200x114 tiles regardless of the headless window size). deviceScaleFactor=1, non-mobile.
        w, h = int(a.args[0]), int(a.args[1])
        cdp.call("Emulation.setDeviceMetricsOverride", width=w, height=h,
                 deviceScaleFactor=1, mobile=False)
        print("metrics %dx%d" % (w, h))
    elif a.cmd == "click":
        x, y = float(a.args[0]), float(a.args[1])
        for typ in ("mousePressed", "mouseReleased"):
            cdp.call("Input.dispatchMouseEvent", type=typ, x=x, y=y,
                     button="left", clickCount=1)
        print("clicked %g,%g" % (x, y))
    elif a.cmd == "open":
        cdp.call("Page.navigate", url=a.args[0])
        print("navigated")
    elif a.cmd == "key":
        cdp.call("Input.insertText", text=a.args[0])
        print("typed")


if __name__ == "__main__":
    main()
