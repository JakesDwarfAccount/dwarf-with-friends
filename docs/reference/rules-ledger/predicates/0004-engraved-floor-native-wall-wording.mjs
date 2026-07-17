// Rule 0004 - the native engraving sheet's simple prose surface word is independent
// of the engraving's physical floor flag. Paraphrased facts only; see the ledger entry.

export function engravingPanelSurface(floorFlag) {
    return {
        surface: floorFlag ? 'floor' : 'wall',
        proseSurface: 'wall',
        opening: 'Engraved on the wall is ',
    };
}
