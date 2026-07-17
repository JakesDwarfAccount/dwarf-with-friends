// F6 Phase-0b test-the-test (spec 2026-07-09-f6-phase1-acquisition-spec.md §6, T1).
//
// Pure host reimplementation of the /diag windowed-sum + reconciliation arithmetic that
// world_stream_diag_json() runs, with NO DFHack/DF dependency, so it compiles and RUNS without a
// live fort (ZERO-DF-contact honest proof). It demonstrates the reconciliation identity
//   capWaitMsPerSec + suspWaitMsPerSec  ~=  residualMs   (= holdSum - phaseSum)
// discriminates a correct lap layout from a SEEDED MIS-LAP (tB folded onto t0, exactly the
// DWF_DIAG_SEED_MISLAP path in world_stream.cpp). The live T1 (flag-built DLL on a fort)
// stays deploy-gated; this proves the *math* the live check relies on is load-bearing.
//
// Build+run (from repo root; any C++17 compiler):
//   cl /std:c++17 /EHsc /Fe:diagfix.exe tools\harness\diag_window_fixture.cpp && diagfix.exe
//   g++ -std=c++17 -O2 -o diagfix tools/harness/diag_window_fixture.cpp && ./diagfix
// Modes:
//   (no args)       normal laps -> identity MUST reconcile (exit 0)
//   --seed-mislap   tB:=t0      -> identity MUST break by ~suspWait (proves the check catches it)

#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <cstring>
#include <vector>

struct Tick {   // one push-loop iteration's bracket marks (ms, relative to t0=0)
    double t0, tA, tB, t1;   // pre-lock / after capture_mu / after CoreSuspender / after hold
    double phase_sum;        // measured in-suspend work (the five phase accumulators)
};

// Mirror of world_stream_tick's per-tick derivation (correct = live code; mislap = seeded flag).
struct Derived { double capWait, suspWait, dfStall, hold, phase_sum; };

Derived derive(const Tick& t, bool seed_mislap) {
    double tB = seed_mislap ? t.t0 : t.tB;   // DWF_DIAG_SEED_MISLAP folds tB onto t0
    Derived d;
    d.capWait  = t.tA - t.t0;
    d.suspWait = tB   - t.tA;
    d.dfStall  = t.t1 - tB;
    d.hold     = t.t1 - t.t0;
    d.phase_sum = t.phase_sum;
    return d;
}

int main(int argc, char** argv) {
    bool seed_mislap = false;
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], "--seed-mislap") == 0) seed_mislap = true;

    // 30 ticks @ ~33 ms: capWait 1 ms, suspWait 9 ms (half a ~19 ms DF frame), dfStall 0.7 ms,
    // phase_sum 0.7 ms -- the spec's live anatomy (~290 ms/s residual, ~21 ms/s hold at 30 Hz).
    std::vector<Tick> ticks;
    for (int i = 0; i < 30; ++i)
        ticks.push_back({0.0, 1.0, 10.0, 10.7, 0.7});

    // Windowed sums (the diag ms/s: one entry/tick over the trailing second).
    double capSum = 0, suspSum = 0, dfSum = 0, holdSum = 0, phaseSum = 0, suspMax = 0;
    for (const auto& t : ticks) {
        Derived d = derive(t, seed_mislap);
        capSum += d.capWait; suspSum += d.suspWait; dfSum += d.dfStall;
        holdSum += d.hold;   phaseSum += d.phase_sum;
        if (d.suspWait > suspMax) suspMax = d.suspWait;
    }
    double residual = holdSum - phaseSum;              // world_stream_diag_json's residualMs
    double recon    = capSum + suspSum;                // spec C1 left-hand side
    double tol      = std::max(0.05 * residual, 2.0);  // max(5%, 2 ms/s), spec C1 bound
    double gap      = std::fabs(recon - residual);
    bool reconciles = gap <= tol;

    std::printf("mode=%s  capWait=%.1f suspWait=%.1f dfStall=%.1f | residualMs=%.1f  "
                "capWait+suspWait=%.1f  gap=%.1f tol=%.1f  suspWaitMax=%.1f\n",
                seed_mislap ? "SEED-MISLAP" : "normal",
                capSum, suspSum, dfSum, residual, recon, gap, tol, suspMax);

    if (!seed_mislap) {
        // Also assert dfStall ~= phase_sum (spec C4) in the correct layout.
        bool c4 = std::fabs(dfSum - phaseSum) <= std::max(0.05 * phaseSum, 2.0);
        if (reconciles && c4) {
            std::printf("PASS: correct laps reconcile (C1) and dfStall~=phaseSum (C4).\n");
            return 0;
        }
        std::printf("FAIL: correct laps did NOT reconcile -- arithmetic is wrong.\n");
        return 1;
    }
    // Test-the-test: the seeded mis-lap MUST break C1 by ~suspWait; if it still reconciled the
    // check is vacuous and this harness must fail loudly.
    if (!reconciles && gap > suspMax * ticks.size() * 0.5) {
        std::printf("PASS (test-the-test): mis-lap broke reconciliation by ~%.0f ms/s "
                    "(== folded suspWait) -- the C1 check is load-bearing.\n", gap);
        return 0;
    }
    std::printf("FAIL: seeded mis-lap still reconciled -- C1 check is VACUOUS.\n");
    return 1;
}
