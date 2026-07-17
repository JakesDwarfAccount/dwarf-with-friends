"""WINDOW-CAPTURE oracle helper for the parity harness (M1 closure item, 2026-07-07).

Both existing parity oracles (`GET /frame.jpg` and `GET /tiledump`) read DF's render buffer
BEFORE its screen-space fog *present* pass (see `docs/superpowers/specs/
2026-07-06-fog-lighting-report.md` §7 and `docs/reference/fogparams.json`'s `seeDown` entry).
This module captures what the player actually SEES: an OS-level `PrintWindow` screenshot of the
live "Dwarf Fortress" window, cropped to its client area so it shares a coordinate origin with
`/tiledump`'s capture buffer (both start at the native window's top-left client pixel -- the
`/tiledump` meta.json comment already documents `frame_w`/`frame_h` as "the full capture-buffer
pixel dims (always the current DF window size)", i.e. the client area, not the OS window rect).

READ-ONLY / PASSIVE: no `SetForegroundWindow`, no input injection, no focus steal. Pure
Win32 GDI (`PrintWindow` + `GetDIBits`) via ctypes -- no pywin32 dependency (matches the
project's existing pattern of using only Pillow/numpy from the .venv-asr env). Mirrors the
PowerShell `PrintWindow` recipe already proven in `tools/spikes/fog/fogcap.py`'s `winshot`
subcommand (used for the original fog-calibration sweep), reimplemented in-process so
`gate_parity.py` gets a PIL Image back directly instead of shelling out + reading a PNG file.

CONSTRAINT (document prominently -- this is the hard limitation of this whole approach):
DF's window must be VISIBLE ON SCREEN AND NOT MINIMIZED. `PrintWindow` on a minimized window
either fails outright or returns a blank/garbage bitmap depending on Windows version and
whether the app renders via GPU (DF does) -- there is no reliable "capture a minimized game"
API short of DWM thumbnail tricks this module does not attempt. Callers should treat
`DFWindowMinimized`/`DFWindowNotFound` as CANNOT-RUN (exit 2), not a score of 0.

DPI: sets process DPI awareness (per-monitor, falling back to system-DPI-aware) BEFORE any
window-rect query, so `GetWindowRect`/`GetClientRect` return PHYSICAL pixels matching what
`PrintWindow` actually paints -- without this, a non-DPI-aware Python process gets virtualized
(scaled-down) rects at 125/150% display scaling (tools/harness/README.md's "150% DPI" gotcha),
which would allocate an undersized bitmap and silently crop/tile the capture.
"""
import ctypes
from ctypes import wintypes

# -- DPI awareness: MUST happen before any GetWindowRect/GetClientRect call in this process --
def _make_dpi_aware():
    try:
        # PROCESS_PER_MONITOR_DPI_AWARE = 2 (shcore, Win 8.1+)
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

_make_dpi_aware()

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PW_RENDERFULLCONTENT = 2
DIB_RGB_COLORS = 0
BI_RGB = 0
SRCCOPY = 0x00CC0020


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class DFWindowNotFound(RuntimeError):
    """No visible top-level window with 'Dwarf Fortress' in its title."""


class DFWindowMinimized(RuntimeError):
    """The DF window exists but is minimized/iconic -- PrintWindow cannot capture it."""


def _enum_df_windows():
    hwnds = []

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if "Dwarf Fortress" in buf.value:
            hwnds.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(_cb), 0)
    return hwnds


def find_df_hwnd():
    """Largest (by screen area) visible window titled 'Dwarf Fortress...' -- same heuristic as
    fogcap.py's winshot (there matched by owning PID; here by title text per the task brief,
    which is equivalent in practice since only one DF instance ever runs, tools/harness/
    README.md gotcha "Only ONE DF instance ever")."""
    hwnds = _enum_df_windows()
    if not hwnds:
        raise DFWindowNotFound(
            "no visible window with 'Dwarf Fortress' in its title -- is DF running "
            "(and not minimized)?")

    def _area(h):
        r = RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        return max(0, r.right - r.left) * max(0, r.bottom - r.top)

    return max(hwnds, key=_area)


def capture_window_bitmap(hwnd):
    """PrintWindow the given hwnd into a PIL RGB Image sized to its FULL window rect (incl. any
    OS chrome), plus geometry metadata. Passive: no focus/activation calls of any kind."""
    from PIL import Image

    if user32.IsIconic(hwnd):
        raise DFWindowMinimized(
            "DF window is minimized -- PrintWindow cannot capture it; restore the window "
            "(no need to give it focus) before using --oracle window")

    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("GetWindowRect failed")
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        raise RuntimeError(f"degenerate window rect {w}x{h}")

    crect = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(crect))
    origin = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    client_off_x = origin.x - rect.left
    client_off_y = origin.y - rect.top
    client_w = crect.right - crect.left
    client_h = crect.bottom - crect.top

    hwindow_dc = user32.GetWindowDC(hwnd)
    if not hwindow_dc:
        raise RuntimeError("GetWindowDC failed")
    mem_dc = gdi32.CreateCompatibleDC(hwindow_dc)
    bmp = gdi32.CreateCompatibleBitmap(hwindow_dc, w, h)
    old_obj = gdi32.SelectObject(mem_dc, bmp)
    try:
        ok = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
        if not ok:
            # some GPU-backed windows reject PW_RENDERFULLCONTENT; PW_CLIENTONLY(=0)/plain
            # BitBlt-style fallback (flags=0) is worth one retry before giving up.
            ok = user32.PrintWindow(hwnd, mem_dc, 0)
        if not ok:
            raise RuntimeError("PrintWindow returned failure for both render-content flags")

        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h  # negative = top-down DIB (row 0 = top row)
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB
        buf = (ctypes.c_ubyte * (w * h * 4))()
        scanlines = gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(bmi), DIB_RGB_COLORS)
        if scanlines == 0:
            raise RuntimeError("GetDIBits returned 0 scanlines")
    finally:
        gdi32.SelectObject(mem_dc, old_obj)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(hwnd, hwindow_dc)

    img = Image.frombuffer("RGBA", (w, h), bytes(buf), "raw", "BGRA", 0, 1).convert("RGB")
    meta = {
        "window_rect": [rect.left, rect.top, rect.right, rect.bottom],
        "client_offset": [client_off_x, client_off_y],
        "client_size": [client_w, client_h],
    }
    return img, meta


def capture_df_client_area():
    """Find the DF window, PrintWindow it, and crop to its CLIENT area (drops title bar/
    borders) -- this crop shares a coordinate origin with /tiledump's capture buffer (both
    start at the native window's top-left client pixel), which is what lets gate_parity.py
    reuse its existing measure_content_bbox()/derive_oracle_geometry() alignment machinery
    unmodified. Returns (client_img, meta) where meta also carries the raw window/client
    rects for debugging."""
    hwnd = find_df_hwnd()
    full_img, meta = capture_window_bitmap(hwnd)
    ox, oy = meta["client_offset"]
    cw, ch = meta["client_size"]
    box = (ox, oy, ox + cw, oy + ch)
    client_img = full_img.crop(box)
    meta["hwnd"] = int(hwnd)
    meta["crop_box"] = list(box)
    return client_img, meta


if __name__ == "__main__":
    # Ad-hoc smoke test: capture and save to tools/harness/results/winshot_smoke.png (gitignored).
    import json
    import os
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "results")
    os.makedirs(out_dir, exist_ok=True)
    try:
        img, meta = capture_df_client_area()
    except (DFWindowNotFound, DFWindowMinimized) as e:
        print(f"CANNOT RUN: {e}")
        sys.exit(2)
    out = os.path.join(out_dir, "winshot_smoke.png")
    img.save(out)
    print(json.dumps({"ok": True, "out": out, "size": img.size, "meta": meta}, indent=2))
