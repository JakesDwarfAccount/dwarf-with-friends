// Rule 0001 — mode-specific status bubble selection. See the ledger entry.
// Binary-read from Dwarf Fortress.exe 683C721D… (paraphrased facts only).
//
// The text-mode chooser at 0x140e89460 has GetTickCount windows. The normal Steam graphics
// selector at 0x1402685d0 does not apply those windows to needs. Keep the two routes separate.

export const THRESHOLDS = {
    hungry:  { field: 'hunger_timer',     min: 50000, textWindow: [0, 200] },
    drowsy:  { field: 'sleepiness_timer', min: 57600, textWindow: [300, 500] },
    thirsty: { field: 'thirst_timer',     min: 25000, textWindow: [500, 700] },
};

export const GRAPHICS_NEED_PRIORITY = Object.freeze(['thirsty', 'hungry', 'drowsy']);

export function thresholdEligible(slice) {
    const out = [];
    for (const [name, r] of Object.entries(THRESHOLDS)) {
        if ((slice[r.field] ?? 0) >= r.min) out.push(name);
    }
    return out;
}

// Compatibility name for callers that only need the three threshold predicates.
export const eligible = thresholdEligible;

// phase = map_renderer.cur_tick_count % 1000. This models only the non-graphics/text branch.
export function textModeChooserSelection(slice, phase) {
    for (const name of thresholdEligible(slice)) {
        const [lo, hi] = THRESHOLDS[name].textWindow;
        if (phase >= lo && phase < hi) return name;
    }
    return null;
}

// Compatibility name retained for existing callers. It is deliberately explicit above that this
// is not the normal graphics route.
export const chooserSelection = textModeChooserSelection;

// The graphics selector tests need rows in this order, after its higher-priority status groups.
// `higherPriorityIndicator` represents those earlier groups, not another need.
export function graphicsNeedSelection(slice, { higherPriorityIndicator = 0 } = {}) {
    if (higherPriorityIndicator === 1) return null;
    for (const name of GRAPHICS_NEED_PRIORITY) {
        const rule = THRESHOLDS[name];
        if ((slice[rule.field] ?? 0) >= rule.min) return name;
    }
    return null;
}
