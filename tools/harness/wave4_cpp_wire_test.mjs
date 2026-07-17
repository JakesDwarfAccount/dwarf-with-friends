// wave4_cpp_wire_test.mjs -- the CLIENT CONTRACT for the Wave-4 C++ wire batch (gaps W1-W5).
//
// The four Wave-4 client agents built screens that read fields the DLL did not yet emit. This file
// pins those fields: their NAMES, their TYPES, and -- for the kitchen -- the TRI-STATE they must be
// able to express. If the server ever drops one or flips a type, this fails.
//
// THE POINT OF THIS FILE, AND WHY IT IS NOT dwfui_adoption_test.
// `dwfui_adoption_test` "proved" a capability with `assert.match(source, /\bDWFUI\b/)` -- the file
// contains some letters -- and reported a reassuring 0 while 467 controls bypassed the layer
// (AGENTS.md, "A test can pass while asserting nothing"). So the assertions here work on DECODED
// PAYLOADS, not on source text, and every validator is proven to FAIL by running it against a
// SEEDED-BAD payload in the same run (section 2). A validator that cannot fail proves nothing.
//
// The two source-shape checks in section 3 exist for exactly one thing a payload validator cannot
// see: that the hard-coded literal `"brewCapable":false` (kitchen_panel.cpp:243) is really GONE
// rather than merely absent from a fixture I wrote myself.
//
//   node tools/harness/wave4_cpp_wire_test.mjs                     offline: fixtures + source (exit 0/1)
//   node tools/harness/wave4_cpp_wire_test.mjs --live http://127.0.0.1:1234?player=p
//                                                                  ALSO validate the LIVE DLL's
//                                                                  payloads. Use this AFTER the
//                                                                  DLL is deployed -- it is the
//                                                                  proof the fields really ship.
//
// Offline mode deliberately does NOT hit the server: the running DF is on the PREVIOUS DLL, so a
// live probe would fail for the right reason at the wrong time and read as a regression.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const src = p => fs.readFileSync(join(root, "src", p), "utf8");

let failed = 0, passed = 0;
const check = (n, c, x) => {
  if (c) { passed++; console.log(`  ok   - ${n}`); }
  else { failed++; console.log(`  FAIL - ${n}${x ? "  ->  " + x : ""}`); }
};

const isBool = v => typeof v === "boolean";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isStr = v => typeof v === "string";
// An item sprite ref is the ONE shape DwfTiles.resolveItemSpriteRef accepts
// (dwf-tiles.js:2026): a STRING itemType plus three numbers. A ref whose itemType is a number
// silently resolves to null and paints the fail-loud empty tile, so the type is load-bearing.
const isItemRef = v => !!v && isStr(v.itemType) && isNum(v.itemSubtype) &&
  isNum(v.materialType) && isNum(v.materialIndex);
const needsIdentity = type => ["SEEDS", "PLANT", "PLANT_GROWTH", "FISH", "FISH_RAW"].includes(type);
const hasStableIdentity = v => isNum(v.identKind) && [1, 2].includes(v.identKind) && isStr(v.ident) && !!v.ident;

// ---------------------------------------------------------------------------------------------
// The validators. Each returns a list of contract violations; [] == the payload honours the wire.
// ---------------------------------------------------------------------------------------------

// W1 -- /kitchen. The client's kitchenCellState() (dwf-kitchen.js:86) is a 3-valued model:
//   cannot     <- cookCapable === false / brewCapable falsy   (native GREY, un-clickable)
//   restricted <- capable, allow flag false                   (native RED)
//   allowed    <- capable, allow flag true                    (native GREEN)
// so a row is only tri-state-capable if the CAPABILITY booleans are present AND are real booleans.
function validateKitchen(p) {
  const e = [];
  if (!p || !Array.isArray(p.plants)) return ["kitchen: missing plants[]"];
  if (!Array.isArray(p.items)) return ["kitchen: missing items[]"];
  for (const r of p.plants) {
    const at = `kitchen.plants[id=${r && r.id}]`;
    if (!isBool(r.cookCapable)) e.push(`${at}: cookCapable must be a boolean (W1)`);
    if (!isBool(r.plantCookCapable)) e.push(`${at}: plantCookCapable must be a boolean (W1)`);
    if (!isBool(r.brewCapable)) e.push(`${at}: brewCapable must be a boolean`);
    if (!isBool(r.seedCookAllowed)) e.push(`${at}: seedCookAllowed must survive (additive rule)`);
    if (!isBool(r.plantCookAllowed)) e.push(`${at}: plantCookAllowed must survive (additive rule)`);
    if (!isItemRef(r.spriteRef)) e.push(`${at}: spriteRef must be an item ref (WIRE-GAP-S3-2)`);
    else if (!hasStableIdentity(r.spriteRef)) e.push(`${at}: seed spriteRef needs plant identKind+ident`);
  }
  for (const r of p.items) {
    const at = `kitchen.items[${r && r.name}]`;
    if (!isBool(r.cookCapable)) e.push(`${at}: cookCapable must be a boolean (W1)`);
    if (!isBool(r.brewCapable)) e.push(`${at}: brewCapable must be a boolean (W1)`);
    if (!isBool(r.brewAllowed)) e.push(`${at}: brewAllowed must be a boolean (W1)`);
    if (!isBool(r.cookAllowed)) e.push(`${at}: cookAllowed must survive (additive rule)`);
    if (!isNum(r.type) || !isNum(r.mat) || !isNum(r.matIndex))
      e.push(`${at}: (type, mat, matIndex) addressing must survive -- a cell with no addressing is a dead button`);
    if (!isItemRef(r.spriteRef)) e.push(`${at}: spriteRef must be an item ref (WIRE-GAP-S3-2)`);
    else if (needsIdentity(r.spriteRef.itemType) && !hasStableIdentity(r.spriteRef))
      e.push(`${at}: species-specific spriteRef needs identKind+ident`);
  }
  // The whole point of W1: some row must be able to say CANNOT, and some row must be able to say
  // RESTRICTED. A wire on which every row is `capable:true` has not fixed anything.
  const rows = p.plants.concat(p.items);
  if (!rows.some(r => r.cookCapable === false || r.brewCapable === false))
    e.push("kitchen: no row can express CANNOT -- the grey tri-state is still unreachable (W1)");
  return e;
}

// W2/W3 -- /stock-item-action.
function validateItemSheet(p) {
  const e = [];
  if (!p || p.ok !== true) return ["itemSheet: not ok"];
  if (!isBool(p.following)) e.push("itemSheet: following must be a boolean (W2) -- UNIT_SHEET_CAMERA_ACTIVE reads it");
  // W3: the location row has TWO art channels and they are not interchangeable. A stockpile is a
  // BUILDING -> an interface token; a container is an ITEM -> an item ref. Null/"" mean "not this
  // kind of location", which is legal; a WRONG-SHAPED value is not.
  if (!(p.locationSpriteRef === null || isItemRef(p.locationSpriteRef)))
    e.push("itemSheet: locationSpriteRef must be null or an item ref (W3)");
  if (!isStr(p.locationSpriteToken))
    e.push("itemSheet: locationSpriteToken must be a string (W3)");
  if (p.locationSpriteToken && !/^STOCKPILE_ICON_[A-Z_]+$/.test(p.locationSpriteToken))
    e.push(`itemSheet: locationSpriteToken '${p.locationSpriteToken}' is not a STOCKPILE_ICON_* interface token (W3)`);
  if (p.locationSpriteRef && p.locationSpriteToken)
    e.push("itemSheet: a location cannot be both an item and a stockpile (W3)");
  for (const c of (Array.isArray(p.contents) ? p.contents : [])) {
    if (!isItemRef(c.spriteRef))
      e.push(`itemSheet.contents[id=${c.id}]: spriteRef must be an item ref (S4 DATA GAP 3)`);
  }
  return e;
}

// W2 -- /unit.
function validateUnitSheet(p) {
  const e = [];
  if (!p || !p.unit) return ["unitSheet: missing unit"];
  if (!isBool(p.following)) e.push("unitSheet: following must be a boolean (W2)");
  // W6 is NOT a wire gap: /unit has ALWAYS carried the unit's live tile, which is everything a
  // recenter needs. Pin it so nobody "fixes" W6 by adding a duplicate route.
  const t = p.tile;
  if (!t || !isNum(t.x) || !isNum(t.y) || !isNum(t.z))
    e.push("unitSheet: tile{x,y,z} must survive -- it IS the recenter payload (W6)");
  // W4 -- relation rows.
  for (const r of (Array.isArray(p.unit.relations) ? p.unit.relations : [])) {
    const at = `unitSheet.relations[${r && r.name}]`;
    if (!isNum(r.professionColor)) e.push(`${at}: professionColor must be a number (W4)`);
    if (r.professionColor < -1 || r.professionColor > 15)
      e.push(`${at}: professionColor ${r.professionColor} outside DF's 4-bit colour range (-1 unknown, 0-15)`);
    if (!isBool(r.dead)) e.push(`${at}: dead must be a boolean (W4)`);
    if (!isStr(r.colorRole)) e.push(`${at}: colorRole must survive (additive rule)`);
  }
  return e;
}

// W5 -- /justice?mode=convicts.
function validateConvicts(p) {
  const e = [];
  if (!p || !Array.isArray(p.convicts)) return ["justice: missing convicts[]"];
  for (const c of p.convicts) {
    const at = `justice.convicts[crime=${c && c.crimeId}]`;
    if (!isStr(c.profession)) e.push(`${at}: profession must be a string (W5)`);
    if (!isNum(c.professionColor)) e.push(`${at}: professionColor must be a number (W5)`);
    if (!isNum(c.portraitTexpos)) e.push(`${at}: portraitTexpos must be a number (W5)`);
    if (!isNum(c.unitId)) e.push(`${at}: unitId must survive (additive rule)`);
  }
  return e;
}

// ---------------------------------------------------------------------------------------------
// 1. GOOD payloads -- the exact shapes the emitters now produce. 0 violations.
// ---------------------------------------------------------------------------------------------
const GOOD = {
  // Rows lifted from the oracle `kitchen all three states.png`, which is the whole specification:
  // rope reeds = cook GREY / brew GREEN; plump helmets = cook GREEN / brew RED; seeds = cook RED.
  kitchen: {
    player: "p",
    plants: [
      { id: 0, name: "plump helmet", seedCookAllowed: false, plantCookAllowed: true,
        cookCapable: true, plantCookCapable: true, brewCapable: true, brewAllowed: false,
        spriteRef: { itemType: "SEEDS", itemSubtype: -1, materialType: 419, materialIndex: 0, identKind: 1, ident: "MUSHROOM_HELMET_PLUMP" } },
      { id: 12, name: "rope reed", seedCookAllowed: true, plantCookAllowed: false,
        cookCapable: true, plantCookCapable: false, brewCapable: true, brewAllowed: true,
        spriteRef: { itemType: "SEEDS", itemSubtype: -1, materialType: 419, materialIndex: 12, identKind: 1, ident: "REED_ROPE" } },
    ],
    items: [
      { type: 55, category: "PLANT", mat: 419, matIndex: 12, name: "Rope reeds", count: 13,
        cookAllowed: true, cookCapable: false, brewCapable: true, brewAllowed: true,
        spriteRef: { itemType: "PLANT", itemSubtype: -1, materialType: 419, materialIndex: 12, identKind: 1, ident: "REED_ROPE" } },
      { type: 55, category: "PLANT", mat: 419, matIndex: 0, name: "Plump helmets", count: 246,
        cookAllowed: true, cookCapable: true, brewCapable: true, brewAllowed: false,
        spriteRef: { itemType: "PLANT", itemSubtype: -1, materialType: 419, materialIndex: 0, identKind: 1, ident: "MUSHROOM_HELMET_PLUMP" } },
      { type: 53, category: "GLOB", mat: 42, matIndex: 7, name: "Prepared cat intestines", count: 1,
        cookAllowed: true, cookCapable: true, brewCapable: false, brewAllowed: false,
        spriteRef: { itemType: "GLOB", itemSubtype: -1, materialType: 42, materialIndex: 7 } },
    ],
    wireBatch: "dwf-wire-batch-W4-20260712",
  },
  itemSheetInStockpile: {
    ok: true, id: 9, title: "tower-cap splint", following: true,
    locationId: 3, locationSpriteRef: null, locationSpriteToken: "STOCKPILE_ICON_FURNITURE",
    contents: [],
  },
  itemSheetInBarrel: {
    ok: true, id: 10, title: "plump helmet", following: false,
    locationId: -1, locationSpriteToken: "",
    locationSpriteRef: { itemType: "BARREL", itemSubtype: -1, materialType: 0, materialIndex: 2 },
    contents: [
      { id: 11, name: "plump helmet", forbidden: false, dump: false, hidden: false,
        spriteRef: { itemType: "PLANT", itemSubtype: -1, materialType: 419, materialIndex: 0 } },
    ],
  },
  unitSheet: {
    player: "p", kind: "unit", tile: { x: 60, y: 70, z: 140 }, following: true,
    unit: {
      id: 4, relations: [
        { label: "Spouse", name: "Urist", profession: "Miner", colorRole: "family",
          professionColor: 6, dead: false },
        { label: "Father", name: "Kadol", profession: "Peasant", colorRole: "family",
          professionColor: 7, dead: true },
      ],
    },
  },
  convicts: {
    convicts: [
      { crimeId: 1, unitId: 4, name: "Urist", profession: "Miner", professionColor: 6,
        portraitTexpos: 8123, mode: "PRISON", prisonTime: 100, hammerstrikes: 0,
        victimId: -1, victim: "" },
    ],
  },
};

console.log("1. GOOD payloads (the shapes the new emitters produce)");
check("W1 /kitchen honours the tri-state contract", validateKitchen(GOOD.kitchen).length === 0,
  validateKitchen(GOOD.kitchen).join(" | "));
check("W2/W3 /stock-item-action (stockpile location)", validateItemSheet(GOOD.itemSheetInStockpile).length === 0,
  validateItemSheet(GOOD.itemSheetInStockpile).join(" | "));
check("W3 /stock-item-action (container location + contents art)", validateItemSheet(GOOD.itemSheetInBarrel).length === 0,
  validateItemSheet(GOOD.itemSheetInBarrel).join(" | "));
check("W2/W4 /unit", validateUnitSheet(GOOD.unitSheet).length === 0,
  validateUnitSheet(GOOD.unitSheet).join(" | "));
check("W5 /justice?mode=convicts", validateConvicts(GOOD.convicts).length === 0,
  validateConvicts(GOOD.convicts).join(" | "));

// ---------------------------------------------------------------------------------------------
// 2. PROOF THE VALIDATORS CAN FAIL. Each case seeds one realistic regression -- including the two
//    exact bugs this batch fixes -- and the validator MUST reject it. If a "bad" payload passes,
//    this file is decoration and the run fails.
// ---------------------------------------------------------------------------------------------
const clone = o => JSON.parse(JSON.stringify(o));
console.log("\n2. SEEDED-BAD payloads (each MUST be rejected -- this is what makes section 1 mean anything)");

const bad = (name, payload, validator, mustMatch) => {
  const errs = validator(payload);
  const hit = errs.some(e => e.includes(mustMatch));
  check(`rejects: ${name}`, errs.length > 0 && hit,
    errs.length === 0 ? "VALIDATOR PASSED A BAD PAYLOAD" : `wrong error: ${errs.join(" | ")}`);
};

// The pre-batch wire, exactly: no cookCapable anywhere, brewCapable hard-coded false on item rows.
const preBatchKitchen = clone(GOOD.kitchen);
preBatchKitchen.plants.forEach(r => { delete r.cookCapable; delete r.plantCookCapable; delete r.spriteRef; });
preBatchKitchen.items.forEach(r => { delete r.cookCapable; delete r.brewAllowed; delete r.spriteRef; r.brewCapable = false; });
bad("the PRE-BATCH /kitchen wire (no cookCapable at all)", preBatchKitchen, validateKitchen, "cookCapable must be a boolean");

const allCapable = clone(GOOD.kitchen);
allCapable.plants.forEach(r => { r.cookCapable = true; r.plantCookCapable = true; r.brewCapable = true; });
allCapable.items.forEach(r => { r.cookCapable = true; r.brewCapable = true; });
bad("a /kitchen where nothing can ever be GREY", allCapable, validateKitchen, "no row can express CANNOT");

const strCapable = clone(GOOD.kitchen);
strCapable.items[0].cookCapable = "false";   // truthy string -> the client would read ALLOWED
bad("cookCapable smuggled in as the STRING \"false\"", strCapable, validateKitchen, "cookCapable must be a boolean");

const identityBlind = clone(GOOD.kitchen);
delete identityBlind.items[0].spriteRef.identKind;
delete identityBlind.items[0].spriteRef.ident;
bad("a species-specific Kitchen row with only unstable numeric material fields", identityBlind,
  validateKitchen, "species-specific spriteRef needs identKind+ident");

const noFollow = clone(GOOD.itemSheetInStockpile);
delete noFollow.following;
bad("an item sheet with no `following` (the pre-batch wire)", noFollow, validateItemSheet, "following must be a boolean");

const tokenAsRef = clone(GOOD.itemSheetInStockpile);
tokenAsRef.locationSpriteRef = { itemType: "STOCKPILE_ICON_FOOD", itemSubtype: -1, materialType: -1, materialIndex: -1 };
tokenAsRef.locationSpriteToken = "STOCKPILE_ICON_FOOD";
bad("an interface token smuggled through the ITEM channel", tokenAsRef, validateItemSheet, "cannot be both an item and a stockpile");

const numType = clone(GOOD.itemSheetInBarrel);
numType.locationSpriteRef.itemType = 55;     // number, not token -> resolveItemSpriteRef returns null
bad("a sprite ref whose itemType is a NUMBER", numType, validateItemSheet, "locationSpriteRef must be null or an item ref");

const noContentArt = clone(GOOD.itemSheetInBarrel);
delete noContentArt.contents[0].spriteRef;
bad("container contents with no sprite ref", noContentArt, validateItemSheet, "S4 DATA GAP 3");

const noTile = clone(GOOD.unitSheet);
delete noTile.tile;
bad("a unit sheet with no `tile` (would really break recenter)", noTile, validateUnitSheet, "IS the recenter payload");

const badColor = clone(GOOD.unitSheet);
badColor.unit.relations[0].professionColor = 99;
bad("a professionColor outside DF's 4-bit range", badColor, validateUnitSheet, "outside DF's 4-bit colour range");

const preBatchConvicts = clone(GOOD.convicts);
delete preBatchConvicts.convicts[0].profession;
delete preBatchConvicts.convicts[0].portraitTexpos;
bad("the PRE-BATCH convict row (no profession, no portrait)", preBatchConvicts, validateConvicts, "profession must be a string");

// ---------------------------------------------------------------------------------------------
// 3. SOURCE GUARDS. Exactly two things a fixture I wrote myself cannot prove.
// ---------------------------------------------------------------------------------------------
console.log("\n3. SOURCE guards (what a self-authored fixture cannot prove)");
const kitchenSrc = src("kitchen_panel.cpp");
check("the hard-coded `\"brewCapable\":false` is GONE from kitchen_panel.cpp (W1)",
  !/\\"brewCapable\\":false/.test(kitchenSrc), "the literal is still there");
check("cook capability is read from the MATERIAL's EDIBLE_COOKED, not guessed from the category (W1)",
  /material_flags::EDIBLE_COOKED/.test(kitchenSrc), "no EDIBLE_COOKED read -- the source of truth is missing");
check("Kitchen serializes stable item identity through the established identKind/ident contract",
  /kitchen_item_identity[\s\S]*?identKind[\s\S]*?json_string\(a\.ident\)/.test(kitchenSrc),
  "species identity never reaches spriteRef");
check("the DLL build stamp exists (grep the .dll for it to prove the build is not a lie)",
  /dwf-wire-batch-W4-20260712/.test(src("json_util.h")), "marker constant missing");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);

// ---------------------------------------------------------------------------------------------
// 4. LIVE mode -- the same validators against a running DLL. This is the ONLY thing that proves the
//    server really emits the fields; everything above proves only that the contract is well-formed.
// ---------------------------------------------------------------------------------------------
const liveIdx = process.argv.indexOf("--live");
if (liveIdx >= 0) {
  const base = (process.argv[liveIdx + 1] || "http://127.0.0.1:1234").replace(/\/$/, "");
  const player = process.argv[liveIdx + 2] || "wiretest";
  const get = async path => {
    const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}player=${player}&t=${Date.now()}`,
      { cache: "no-store" });
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
  };
  console.log(`\n4. LIVE against ${base}`);
  try {
    const kitchen = await get("/kitchen");
    check("live /kitchen carries the batch marker",
      kitchen.wireBatch === "dwf-wire-batch-W4-20260712",
      `wireBatch=${kitchen.wireBatch} -- THE DEPLOYED DLL DOES NOT CONTAIN THIS BATCH`);
    const ke = validateKitchen(kitchen);
    check("live /kitchen honours the tri-state contract", ke.length === 0, ke.slice(0, 4).join(" | "));
    const ce = validateConvicts(await get("/justice?mode=convicts"));
    check("live /justice?mode=convicts", ce.length === 0, ce.slice(0, 4).join(" | "));
    const uid = process.env.WIRE_TEST_UNIT_ID;
    if (uid) {
      const ue = validateUnitSheet(await get(`/unit?id=${uid}`));
      check(`live /unit?id=${uid}`, ue.length === 0, ue.slice(0, 4).join(" | "));
    } else {
      console.log("  skip - live /unit  (set WIRE_TEST_UNIT_ID=<id> to include it)");
    }
    const iid = process.env.WIRE_TEST_ITEM_ID;
    if (iid) {
      const ie = validateItemSheet(await get(`/stock-item-action?id=${iid}&action=info`));
      check(`live /stock-item-action?id=${iid}`, ie.length === 0, ie.slice(0, 4).join(" | "));
    } else {
      console.log("  skip - live /stock-item-action  (set WIRE_TEST_ITEM_ID=<id> to include it)");
    }
  } catch (err) {
    check("live probe reachable", false, String(err && err.message));
  }
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed  (with --live)`);
}

process.exit(failed === 0 ? 0 : 1);
