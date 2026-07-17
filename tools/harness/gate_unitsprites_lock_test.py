"""Pure-Python contention test for gate_unitsprites --refresh-atlas locking."""

import concurrent.futures
import os
import threading
import time
from pathlib import Path

from unitsprites_refresh_lock import acquire_refresh_lock


ARTIFACT_ROOT = Path(".tmp-codex-artifacts/tooling") / f"gate-unitsprites-lock-test-{os.getpid()}-{time.time_ns()}"
LOCK_PATH = ARTIFACT_ROOT / "DF_LOCK"
CONTENDERS = 12


def contender(number, barrier):
    barrier.wait()
    return number, acquire_refresh_lock(LOCK_PATH, f"contender-{number}")


def main():
    gate_source = Path("tools/harness/gate_unitsprites.py").read_text(encoding="utf-8")
    assert "acquire_refresh_lock(lock_path, \"gate_unitsprites\")" in gate_source
    assert "if lock_path.exists():" not in gate_source

    ARTIFACT_ROOT.mkdir(parents=True, exist_ok=False)
    barrier = threading.Barrier(CONTENDERS)
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONTENDERS) as pool:
        results = list(pool.map(lambda number: contender(number, barrier), range(CONTENDERS)))

    winners = [(number, detail) for number, (won, detail) in results if won]
    losers = [(number, detail) for number, (won, detail) in results if not won]
    assert len(winners) == 1, f"expected exactly one O_EXCL winner, got {winners!r}"
    assert len(losers) == CONTENDERS - 1, f"expected {CONTENDERS - 1} held-lock losers"

    winner, payload = winners[0]
    stored = LOCK_PATH.read_text(encoding="utf-8").strip()
    assert stored == payload, f"lock was overwritten: stored={stored!r} winner={payload!r}"
    assert stored.startswith(f"contender-{winner} "), stored
    assert all("held by" in detail and "age" in detail for _, detail in losers), losers

    print(f"PASS  O_EXCL allows exactly one of {CONTENDERS} concurrent refresh-lock claimants")
    print("PASS  held claimants report the holder and lock age without breaking the lock")
    print(f"ARTIFACT  {ARTIFACT_ROOT}")


if __name__ == "__main__":
    main()
