// Rule 0003 — native work-order item-condition status text and colors.
// Binary-read from Dwarf Fortress.exe 683C721D… @ 0x14038c3c0.
// Paraphrased facts only; see ../0003-work-order-condition-status-colors.md.

export const CURSES_COLOR = Object.freeze({
    Black: 0,
    Green: 2,
    Red: 4,
});

export function workOrderConditionStatus(satisfiedForNextCheck) {
    const satisfied = Boolean(satisfiedForNextCheck);
    return {
        text: satisfied ? 'Satisfied for next check' : 'Not satisfied for next check',
        foreground: satisfied ? CURSES_COLOR.Green : CURSES_COLOR.Red,
        background: CURSES_COLOR.Black,
        bright: true,
    };
}
