// Rule 0002 — native work-order suggested item conditions.
// Binary-read from Dwarf Fortress.exe 683C721D… @ 0x140a9d510 / 0x14038c3c0.
// Paraphrased facts only; see ../0002-work-order-suggested-conditions.md.

export const COMPARE = Object.freeze({
    GreaterThan: 2,
    LessThan: 3,
});

export const EMPTY_FLAG = 0x400;

const ITEM_TYPE_IDS = Object.freeze({
    FLASK: 11,
    GOBLET: 12,
    CAGE: 16,
    BARREL: 17,
    BUCKET: 18,
    ANIMALTRAP: 19,
    COFFIN: 21,
    BOX: 30,
    BAG: 31,
    BIN: 32,
    ARMORSTAND: 33,
    WEAPONRACK: 34,
    CABINET: 35,
    BACKPACK: 61,
    QUIVER: 62,
    TOOL: 86,
});

const EMPTY_CONTAINER_TYPES = new Set(
    Object.entries(ITEM_TYPE_IDS)
        .filter(([name]) => name !== 'TOOL')
        .map(([, id]) => id),
);

const FILTER_DEFAULTS = Object.freeze({
    item_type: -1,
    item_subtype: -1,
    mat_type: -1,
    mat_index: -1,
    flags1: 0,
    flags2: 0,
    flags3: 0,
    flags4: 0,
    flags5: 0,
    reaction_class: '',
    has_material_reaction_product: '',
    metal_ore: -1,
    min_dimension: -1,
    contains: Object.freeze([]),
    reaction_id: -1,
    has_tool_use: -1,
    dye_color: -1,
});

export const FILTER_FIELDS = Object.freeze(Object.keys(FILTER_DEFAULTS));
export const SUPPRESSION_FIELDS = Object.freeze(
    FILTER_FIELDS.filter(field => field !== 'contains'),
);

function itemTypeId(value) {
    return typeof value === 'string' ? (ITEM_TYPE_IDS[value] ?? value) : value;
}

export function canonicalFilter(source = {}) {
    const filter = {};
    for (const field of FILTER_FIELDS) {
        const value = source[field] ?? FILTER_DEFAULTS[field];
        filter[field] = Array.isArray(value) ? [...value] : value;
    }
    filter.item_type = itemTypeId(filter.item_type);
    filter.flags1 = Number(filter.flags1) >>> 0;
    return filter;
}

export function sameItemFilter(left, right) {
    const a = canonicalFilter(left);
    const b = canonicalFilter(right);
    return SUPPRESSION_FIELDS.every(field => a[field] === b[field]);
}

export function isEmptyCapableProduct(product) {
    const type = itemTypeId(product.item_type);
    if (EMPTY_CONTAINER_TYPES.has(type)) return true;
    return type === ITEM_TYPE_IDS.TOOL && Number(product.tool_container_capacity ?? 0) > 0;
}

function condition(filter, compare_type) {
    return { compare_type, compare_val: 10, ...canonicalFilter(filter) };
}

// Native order: optional empty-product variant, ordinary product, then required inputs.
// Every generated text row remains visible. Existing conditions suppress only the row's add
// control by scalar/string item fields, ignoring operator, threshold, and the contains vector.
export function visibleSuggestions({ products = [], required_inputs = [], existing = [] }) {
    const generated = [];

    for (const product of products) {
        const filter = canonicalFilter(product);
        if (isEmptyCapableProduct(product) && !(filter.flags1 & EMPTY_FLAG)) {
            generated.push(condition({ ...filter, flags1: filter.flags1 | EMPTY_FLAG }, COMPARE.LessThan));
        }
        generated.push(condition(filter, COMPARE.LessThan));
    }

    for (const input of required_inputs) {
        generated.push(condition(input, COMPARE.GreaterThan));
    }

    return generated.map(suggestion => ({
        ...suggestion,
        add_available: !existing.some(current => sameItemFilter(current, suggestion)),
    }));
}
