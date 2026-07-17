"""TEST-THE-TEST for gate_userperf's sawtooth metrics (completeness protocol rule 3).

Feeds gate_cell() the REAL measured payloads from the perfhitch differential (a busy fort,
back-to-back, results/sawtooth-ctl2/fix2-*.json) and asserts the new tail/hitch gating:
  - the PRE-FIX (sawtooth) payload FAILs,
  - the POST-FIX payload PASSes,
  - and the OLD checks alone (p95<=22 + longtasks>200) would have PASSed the sawtooth
    (the documented blind spot -- proves the new metrics are load-bearing).

Offline, no live game / browser needed. Exit 0 = all assertions hold.
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate_userperf as G

GL_SOLO = {"area": "busy", "zoom": "wide", "clients": "solo", "renderer": "gl"}

# Real measured payloads (results/sawtooth-ctl2-*.json / sawtooth-fix2-*.json, 2026-07-08,
# busy fort origin(18,66,161), same scene back-to-back). Only the fields gate_cell reads.
CONTROL = {  # deployed pre-fix keep-warm = the sawtooth
    "rafFps": 132.2, "p95FrameMs": 6.5, "p99FrameMs": 56.2,
    "hitchesPerSec": 3.27, "longtaskMsPerSec": 115.5, "longtasksOver200": 0,
}
FIXED = {    # incremental keep-warm
    "rafFps": 154.7, "p95FrameMs": 6.5, "p99FrameMs": 12.5,
    "hitchesPerSec": 0.067, "longtaskMsPerSec": 0.0, "longtasksOver200": 0,
}

def old_gate_would_pass(m):
    """The pre-perfhitch gating: p95<=22, longtasks>200==0, rafFps>=50. Nothing else."""
    return (m["rafFps"] >= G.RAF_FPS_MIN and m["p95FrameMs"] <= G.P95_FRAME_MS_MAX
            and m["longtasksOver200"] == 0)

fails = 0
def check(name, cond):
    global fails
    print(("  ok   - " if cond else "  FAIL - ") + name)
    if not cond: fails += 1

print("gate_userperf sawtooth metric test-the-test")

passed_ctl, reasons_ctl = G.gate_cell(GL_SOLO, CONTROL, {}, {}, {})
check("sawtooth (pre-fix) payload FAILs the new gate", passed_ctl is False)
check("  ...and the failure names a tail/hitch reason",
      any(("p99" in r or "hitch" in r or "sawtooth" in r) for r in reasons_ctl))
print("       reasons:", "; ".join(reasons_ctl))

passed_fix, reasons_fix = G.gate_cell(GL_SOLO, FIXED, {}, {}, {})
check("post-fix (incremental keep-warm) payload PASSes the new gate", passed_fix is True)
check("  ...with zero reasons", reasons_fix == [])

# The blind-spot proof: the OLD gate alone passes BOTH -- so p95/longtasks>200 could never
# have caught this sawtooth. The new metrics are what make the difference.
check("OLD gate (p95<=22 + longtasks>200) would have PASSED the sawtooth (blind spot)",
      old_gate_would_pass(CONTROL) is True)
check("new gate flips that same payload to FAIL", passed_ctl is False)

# Discrimination sanity: p95 is IDENTICAL in both (6.5) -> p95 alone cannot tell them apart.
check("p95 is identical pre/post (6.5) -> p95 alone is non-discriminating here",
      CONTROL["p95FrameMs"] == FIXED["p95FrameMs"])

print(("\nPASS" if fails == 0 else f"\nFAIL ({fails} failures)")
      + " -- gate_userperf sawtooth metrics")
sys.exit(1 if fails else 0)
