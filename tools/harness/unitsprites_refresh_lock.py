"""Atomic lock helper for gate_unitsprites --refresh-atlas."""

import datetime
import os
import time
from pathlib import Path


def _held_message(lock_path: Path) -> str:
    try:
        holder = lock_path.read_text(encoding="utf-8", errors="replace").strip()
    except FileNotFoundError:
        raise
    except OSError as exc:
        holder = f"unreadable: {exc}"
    try:
        age_s = max(0.0, time.time() - lock_path.stat().st_mtime)
        age = f"{age_s:.1f}s"
    except OSError:
        age = "unknown age"
    return f"{lock_path} is held by {holder!r} (age {age}); refusing to break it"


def acquire_refresh_lock(lock_path: Path, holder: str):
    """Atomically acquire a refresh lock, or report the existing holder.

    O_EXCL closes the exists()-then-write race: exactly one concurrent caller creates
    the file. A lock that disappears between a failed create and inspection is retried;
    a lock that remains is never removed or replaced here.
    """
    payload = f"{holder} {os.getpid()} {datetime.datetime.utcnow().isoformat()}Z\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    for _ in range(2):
        try:
            fd = os.open(lock_path, flags, 0o600)
        except FileExistsError:
            try:
                return False, _held_message(lock_path)
            except FileNotFoundError:
                continue
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as lock_file:
                lock_file.write(payload)
            # Defense in depth: confirm that the lock still names this holder.
            try:
                if lock_path.read_text(encoding="utf-8", errors="replace").startswith(f"{holder} "):
                    return True, payload.strip()
            except FileNotFoundError:
                return False, f"{lock_path} disappeared after creation; refusing to guess at lock ownership"
            return False, _held_message(lock_path)
    return False, f"{lock_path} changed while acquiring; retry the refresh instead of breaking a lock"
