#!/usr/bin/env node
// Squad-delete TEARDOWN test (rules-ledger 0008). The native disband path performs four cleanup
// steps that do_squad_delete historically skipped: unlink position-assigned equipment from the
// fort's item-assignment indexes, clear off-map occupants' squad/position membership, destroy the
// squad's current training activity, and unlink + deep-delete the ammo specs. This pins each step
// AND its ordering inside do_squad_delete -- existence of a helper alone is not enough (the
// stockpile repair sat uncalled for weeks behind exactly that kind of check).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const squads = readFileSync(join(root, "src", "squads.cpp"), "utf8");

// --- helper: unassign_equipment_item moves an id assigned -> unassigned (both native indexes).
const unassignAt = squads.indexOf("void unassign_equipment_item");
assert.ok(unassignAt >= 0, "unassign_equipment_item exists");
const unassignBody = squads.slice(unassignAt, squads.indexOf("\n}", unassignAt));
assert.match(unassignBody, /erase_from_vector\(plotinfo->equipment\.items_assigned\[type\], item_id\)/,
  "unassign erases the id from items_assigned");
assert.match(unassignBody, /insert_into_vector\(plotinfo->equipment\.items_unassigned\[type\], item_id\)/,
  "unassign returns the id to items_unassigned");

// --- helper: release_offmap_occupant converts links to their 'former' forms for both ranks.
const releaseAt = squads.indexOf("void release_offmap_occupant");
assert.ok(releaseAt >= 0, "release_offmap_occupant exists");
const releaseBody = squads.slice(releaseAt, squads.indexOf("\n}", releaseAt));
assert.match(releaseBody, /histfig_entity_link_squadst/, "handles the soldier SQUAD link");
assert.match(releaseBody, /histfig_entity_link_former_squadst/, "files a former-squad link");
assert.match(releaseBody, /histfig_entity_link_positionst/, "handles the leader POSITION link");
assert.match(releaseBody, /histfig_entity_link_former_positionst/, "files a former-position link");
assert.match(releaseBody, /asn->histfig = -1;\s*asn->histfig2 = -1;/,
  "vacates the noble seat's holder fields");

// --- helper: remove_squad_activity destroys the entry and resets squad.activity.
const actAt = squads.indexOf("void remove_squad_activity");
assert.ok(actAt >= 0, "remove_squad_activity exists");
const actBody = squads.slice(actAt, squads.indexOf("\n}", actAt));
assert.match(actBody, /world->activities\.all/, "searches world.activities.all");
assert.match(actBody, /for \(auto ev : entry->events\) delete ev;/, "deep-deletes the events");
assert.match(actBody, /delete entry;/, "deletes the activity entry itself");
assert.match(actBody, /squad->activity = -1;/, "resets squad.activity to -1");
assert.match(actBody, /order_load/, "nulls the has-bad-pointers load buffer too");

// --- the wiring: all four steps run inside do_squad_delete, in a safe order.
const ddAt = squads.indexOf("bool do_squad_delete");
assert.ok(ddAt >= 0, "do_squad_delete exists");
const dd = squads.slice(ddAt, squads.indexOf("\n}", squads.indexOf("delete squad;", ddAt)));

const at = (needle) => {
  const i = dd.indexOf(needle);
  assert.ok(i >= 0, `do_squad_delete contains: ${needle}`);
  return i;
};
const occupantRelease = at("release_offmap_occupant(hf, squad, i == 0)");
const posUnassign = at("for (int32_t item_id : pos->equipment.assigned_items)");
const activity = at("remove_squad_activity(squad)");
const ammoLoop = at("for (auto spec : squad->ammo.ammunition)");
const ammoUnassign = dd.indexOf("for (int32_t item_id : spec->assigned)");
assert.ok(ammoUnassign > ammoLoop, "ammo specs unlink their assigned item ids");
assert.match(dd.slice(ammoLoop, dd.indexOf("squad->ammo.ammunition.clear()", ammoLoop)),
  /delete spec;/, "ammo specs are deep-deleted, not leaked");
const ammoClear = at("squad->ammo.ammunition.clear()");
const freeSquad = at("delete squad;");

assert.ok(occupantRelease < freeSquad && posUnassign < freeSquad &&
          activity < freeSquad && ammoClear < freeSquad,
  "every 0008 step runs before the squad is freed");
assert.ok(occupantRelease < posUnassign,
  "occupants are released before their positions are deep-deleted");
// The old fallback must be gone: a bare occupant reset with no hf cleanup around it.
assert.match(dd, /if \(hf && !removed_live\)/,
  "the no-live-unit path goes through release_offmap_occupant, not just occupant = -1");

console.log("PASS squad delete performs the four native 0008 teardown steps before the free");
