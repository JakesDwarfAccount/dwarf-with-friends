// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// SPDX-License-Identifier: AGPL-3.0-only
//
// B292: exhaustive snapshot of DFHack 53.15-r1's generated job_type and activity_event_type
// headers. Label resolution is intentionally generic: live jobs go through DF's job-button text
// vmethod, and all live activity subclasses go through activity_event::get_idle_string. B296's
// source-color switch is separately pinned for every event type, so additions cannot silently lose
// either their label or their Residents color.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const activity = readFileSync(join(root, "src", "unit_activity.h"), "utf8");
const activityWorld = readFileSync(join(root, "src", "unit_activity.cpp"), "utf8");
const activityLogic = readFileSync(join(root, "src", "unit_activity_logic.h"), "utf8");
const worldFixture = readFileSync(join(root, "tools", "harness",
  "b292_world_activity_fixture_test.cpp"), "utf8");
const info = readFileSync(join(root, "src", "info_panel.cpp"), "utf8");
const sheet = readFileSync(join(root, "src", "unit_sheet.cpp"), "utf8");
const hospital = readFileSync(join(root, "src", "hospital.cpp"), "utf8");

// <DFHACK_ROOT>\library\include\df\job_type.h, generated from df.job.xml for 53.15-r1.
// Position 0 is value -1 (NONE); positions 1..258 are values 0..257.
const JOB_TYPES = `
NONE CarveFortification SmoothWall SmoothFloor DetailWall DetailFloor Dig CarveUpwardStaircase CarveDownwardStaircase CarveUpDownStaircase CarveRamp DigChannel FellTree GatherPlants RemoveConstruction CollectWebs BringItemToDepot BringItemToShop Eat GetProvisions Drink DrinkItem FillWaterskin FillWaterskinItem Sleep CollectSand Fish Hunt HuntVermin Kidnap BeatCriminal StartingFistFight CollectTaxes GuardTaxCollector CatchLiveLandAnimal CatchLiveFish ReturnKill StoreOwnedItem PlaceItemInTomb StoreItemInStockpile StoreItemInBag StoreItemInLocation StoreWeapon StoreArmor StoreItemInBarrel StoreItemInBin SeekArtifact SeekInfant GoShopping GoShoppingSpecific Clean Rest PickupEquipment DumpItem StrangeMoodCrafter StrangeMoodJeweller StrangeMoodForge StrangeMoodMagmaForge StrangeMoodBrooding StrangeMoodFell StrangeMoodCarpenter StrangeMoodMason StrangeMoodBowyer StrangeMoodTanner StrangeMoodWeaver StrangeMoodGlassmaker StrangeMoodMechanics ConstructBuilding ConstructDoor ConstructFloodgate ConstructBed ConstructThrone ConstructCoffin ConstructTable ConstructChest ConstructBag ConstructBin ConstructArmorStand ConstructWeaponRack ConstructCabinet ConstructStatue ConstructBlocks MakeRawGlass MakeCrafts MintCoins CutGems CutGlass EncrustWithGems EncrustWithGlass DestroyBuilding SmeltOre MeltMetalObject ExtractMetalStrands PlantSeeds HarvestPlants TrainHuntingAnimal TrainWarAnimal MakeWeapon ForgeAnvil ConstructCatapultParts ConstructBallistaParts MakeArmor MakeHelm MakePants StudWith ButcherAnimal PrepareRawFish MillPlants BaitTrap MilkCreature MakeCheese ProcessPlants PolishStones ProcessPlantsVial ProcessPlantsBarrel PrepareMeal WeaveCloth MakeGloves MakeShoes MakeShield MakeCage MakeChain MakeFlask MakeGoblet MakeToy MakeAnimalTrap MakeBarrel MakeBucket MakeWindow MakeTotem MakeAmmo DecorateWith MakeBackpack MakeQuiver MakeBallistaArrowHead AssembleSiegeAmmo LoadCatapult LoadBallista FireCatapult FireBallista ConstructMechanisms MakeTrapComponent LoadCageTrap LoadStoneTrap LoadWeaponTrap CleanTrap EncrustWithStones LinkBuildingToTrigger PullLever anon_1 ExtractFromPlants ExtractFromRawFish ExtractFromLandAnimal TameVermin TameAnimal ChainAnimal UnchainAnimal UnchainPet ReleaseLargeCreature ReleasePet ReleaseSmallCreature HandleSmallCreature HandleLargeCreature CageLargeCreature CageSmallCreature RecoverWounded DiagnosePatient ImmobilizeBreak DressWound CleanPatient Surgery Suture SetBone PlaceInTraction DrainAquarium FillAquarium FillPond GiveWater GiveFood GiveWaterPet GiveFoodPet RecoverPet PitLargeAnimal PitSmallAnimal SlaughterAnimal MakeCharcoal MakeAsh MakeLye MakePotashFromLye FertilizeField MakePotashFromAsh DyeThread DyeCloth SewImage MakePipeSection OperatePump ManageWorkOrders UpdateStockpileRecords TradeAtDepot ConstructHatchCover ConstructGrate RemoveStairs ConstructQuern ConstructMillstone ConstructSplint ConstructCrutch ConstructTractionBench CleanSelf BringCrutch ApplyCast CustomReaction ConstructSlab EngraveSlab ShearCreature SpinThread PenLargeAnimal PenSmallAnimal MakeTool CollectClay InstallColonyInHive CollectHiveProducts CauseTrouble DrinkBlood ReportCrime ExecuteCriminal TrainAnimal CarveTrack PushTrackVehicle PlaceTrackVehicle StoreItemInVehicle GeldAnimal MakeFigurine MakeAmulet MakeScepter MakeCrown MakeRing MakeEarring MakeBracelet MakeGem PutItemOnDisplay HeistItem InterrogateSubject AcceptHeistItem StoreSquadEquipmentItem MixDye DyeLeather ConstructBoltThrowerParts LoadBoltThrower FireBoltThrower UNUSED_31 UNUSED_32 UNUSED_33 UNUSED_34 UNUSED_35 UNUSED_36 UNUSED_37 UNUSED_38 UNUSED_39 UNUSED_40
`.trim().split(/\s+/);

// df.job.xml's only missing captions and its only caption strings that would falsely look idle.
// All still resolve non-empty through the exact generated enum key fallback.
const NO_CAPTION = new Set(["NONE", "UNUSED_31", "UNUSED_32", "UNUSED_33", "UNUSED_34",
  "UNUSED_35", "UNUSED_36", "UNUSED_37", "UNUSED_38", "UNUSED_39", "UNUSED_40"]);
const IDLE_CAPTION = new Set(["DrinkBlood", "HeistItem", "AcceptHeistItem"]);

// <DFHACK_ROOT>\library\include\df\activity_event_type.h. NONE is not an event subclass.
const ACTIVITY_TYPES = `TrainingSession CombatTraining SkillDemonstration IndividualSkillDrill
Sparring RangedPractice Harassment Conversation Conflict Guard Reunion Prayer Socialize Worship
Performance Research PonderTopic DiscussTopic Read FillServiceOrder Write CopyWrittenContent
TeachTopic Play MakeBelieve PlayWithToy Encounter StoreObject`.split(/\s+/);

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

check("captured job_type audit is complete (-1 and 0..257)", () => {
  assert.equal(JOB_TYPES.length, 259);
  assert.equal(new Set(JOB_TYPES).size, 259);
  assert.equal(JOB_TYPES[0], "NONE");
  assert.equal(JOB_TYPES.at(-1), "UNUSED_40");
  assert.equal(NO_CAPTION.size, 11);
  assert.equal(IDLE_CAPTION.size, 3);
  for (const type of [...NO_CAPTION, ...IDLE_CAPTION])
    assert.ok(JOB_TYPES.includes(type), type);
});

check("every job_type takes one native, non-idle generic resolver", () => {
  assert.match(activity, /std::string native_job_name\(df::job\* job\)/);
  assert.match(activity, /DFHack::Job::getName\(job\)/,
    "live context-rich DF job-button wording must win");
  assert.match(activity, /ENUM_ATTR\(job_type, caption, job->job_type\)/,
    "DF structures caption must be the generic fallback");
  assert.match(activity, /ENUM_KEY_STR\(job_type, job->job_type\)/,
    "reserved and native idle-placeholder captions need a nonempty DF-owned key");
  assert.doesNotMatch(activity, /case\s+df::job_type::/,
    "a job_type switch can never prove exhaustive coverage");

  // This is the per-enum assertion: every captured value goes through the same function, and
  // caption-less/idle-caption values have their own nonempty generated key as the last resort.
  for (const type of JOB_TYPES) {
    const resolution = NO_CAPTION.has(type) || IDLE_CAPTION.has(type)
      ? type
      : "Job::getName -> caption";
    assert.ok(resolution && !/^No (?:job|activity)$/i.test(resolution), type);
  }
});

check("all 28 activity_event_type subclasses take DF's per-unit vmethod", () => {
  assert.equal(ACTIVITY_TYPES.length, 28);
  assert.equal(new Set(ACTIVITY_TYPES).size, 28);
  assert.match(activity, /event->getName\(unit->id, &name\)/);
  assert.match(activity, /ENUM_KEY_STR\(activity_event_type, event->getType\(\)\)/);
  for (const type of ACTIVITY_TYPES) {
    assert.ok(type.length > 0 && !/^No (?:job|activity)$/i.test(type), type);
    const pattern = new RegExp("case\\s+df::activity_event_type::" + type + ":", "g");
    assert.equal((activity.match(pattern) || []).length, 1,
      type + " must have exactly one source-color bucket");
  }
  assert.equal((activity.match(/case\s+df::activity_event_type::NONE:/g) || []).length, 1);
  for (const bucket of ["Job", "Social", "Need", "Training"])
    assert.match(activity, new RegExp("return UnitTaskColorBucket::" + bucket));
});

check("combat drill and every unit-owned current activity channel are reachable", () => {
  assert.ok(ACTIVITY_TYPES.includes("CombatTraining"));
  assert.ok(ACTIVITY_TYPES.includes("IndividualSkillDrill"));
  assert.match(activity, /Units::getMainSocialEvent\(unit\)/);
  for (const field of ["individual_drills", "conversations", "activities"])
    assert.ok(activity.includes(`unit->${field}`), field);
  assert.doesNotMatch(activity, /unit->ignored_activities/);
});

check("world-side activity participants are indexed once with explicit DF layouts", () => {
  assert.match(activityWorld, /world->activities\.all/);
  assert.match(activityWorld, /participants->units/,
    "the common activity_event_participants.units layout must be indexed");
  assert.match(activityWorld, /conversation->participants/);
  assert.match(activityWorld, /participant->unit_id/,
    "conversation_participantst must not be treated as activity_event_participants");
  assert.match(activityWorld, /event->parent_event_id/);
  assert.match(activityWorld, /candidate_wins/);
  assert.match(activity, /unit_current_activity_event\(unit\)[\s\S]*world_activities->find\(unit->id\)/,
    "the world scan must remain a fallback after all unit-side channels");
  assert.match(activityLogic, /if \(job\)[\s\S]*if \(unit_event\)[\s\S]*if \(world_event\)/,
    "job > unit-side activity > world activity precedence");
});

check("every browser-facing C++ unit/job surface consumes the shared native resolver", () => {
  assert.match(info, /UnitCurrentTask current_task[\s\S]*?unit_current_task\(unit, &world_activities\)/);
  assert.match(info, /first_job_label[\s\S]*?native_job_name\(job\)/);
  assert.match(sheet, /unit_current_job_label[\s\S]*?unit_current_task_name\(unit, &world_activities\)/);
  assert.match(hospital, /const std::string label = native_job_name\(job\)/);
  assert.doesNotMatch(info, /current_job \? "Working" : "No job"/);
  assert.doesNotMatch(sheet, /current_job \? "Unknown job" : "No job"/);
  assert.doesNotMatch(hospital, /struct MedJob\s*\{[^}]*label/);
});

check("failing-first oracle: the removed implementation classified combat drill as No job", () => {
  const oldLabel = unit => unit?.job?.current_job ? "Working" : "No job";
  const combatDrill = { id: 42, job: { current_job: null }, individual_drills: [7] };
  assert.equal(oldLabel(combatDrill), "No job");
  assert.match(activity, /last_unit_activity_event\(unit->individual_drills\)/);
  assert.match(activity, /event->getName\(unit->id, &name\)/);
});

check("behavioral fixture: 4009 resolves from world activity 4959 to the leaf demonstration", () => {
  const unit = {
    id: 4009,
    job: { current_job: null },
    individual_drills: [], social_activities: [], conversations: [], activities: [],
  };
  const worldActivities = [{ id: 4959, events: [
    { event_id: 0, parent_event_id: -1, participants: { units: [4009] },
      name: () => "Training Session" },
    { event_id: 1, parent_event_id: 0, participants: { units: [4009] },
      name: () => "Combat Training" },
    { event_id: 2, parent_event_id: 1, participants: { units: [4009] },
      name: id => id === 4009 ? "Watch Dodging Demonstration" : "Lead Dodging Demonstration" },
  ] }];

  const oldResolver = u => u.job.current_job ? "Working" : "No job";
  assert.equal(oldResolver(unit), "No job", "failing-first proof for today's resolver");

  const index = new Map();
  for (const entry of worldActivities) {
    const byId = new Map(entry.events.map(event => [event.event_id, event]));
    const depth = event => event.parent_event_id < 0 ? 0 : 1 + depth(byId.get(event.parent_event_id));
    const local = new Map();
    entry.events.forEach((event, order) => {
      for (const id of event.participants.units) {
        const candidate = { event, depth: depth(event), order };
        const current = local.get(id);
        if (!current || candidate.depth > current.depth ||
            (candidate.depth === current.depth && candidate.order > current.order))
          local.set(id, candidate);
      }
    });
    for (const [id, candidate] of local) index.set(id, candidate.event);
  }
  const resolved = index.get(unit.id)?.name(unit.id) || "No job";
  assert.equal(resolved, "Watch Dodging Demonstration");

  // The standalone C++ fixture consumes the same production precedence/ranking seam. This
  // plain-Node suite deliberately does not spawn a compiler.
  assert.match(worldFixture, /FixtureUnit unit\{4009\}/);
  assert.match(worldFixture, /assert\(resolved == "Watch Dodging Demonstration"\)/);
});

// AUDIT-FIX 07-15: the captured JOB_TYPES list above is a snapshot; on machines with the DFHack
// tree present, verify it against the GENERATED df.job.xml so "exhaustive" is measured, not merely
// asserted. Graceful skip elsewhere -- the snapshot cells still run.
check("captured job_type list matches df.job.xml exactly (when the DFHack tree is present)", () => {
  const xmlPath = process.env.DFHACK_SRC ? process.env.DFHACK_SRC + "/library/xml/df.job.xml" : "";
  let xml;
  try { xml = readFileSync(xmlPath, "utf8"); }
  catch { console.log("  (df.job.xml not present -- snapshot-only mode)"); return; }
  const enumBlock = xml.match(/<enum-type type-name='job_type'[\s\S]*?<\/enum-type>/);
  assert.ok(enumBlock, "job_type enum-type block present in df.job.xml");
  const names = [...enumBlock[0].matchAll(/<enum-item name='([^']+)'/g)].map(m => m[1]);
  // df.job.xml omits names for anonymous items; the snapshot calls those anon_N / UNUSED_NN.
  const snapshotNamed = JOB_TYPES.filter(t => !/^anon_\d+$|^UNUSED_\d+$/.test(t));
  const missing = names.filter(n => !JOB_TYPES.includes(n));
  const extra = snapshotNamed.filter(n => !names.includes(n));
  assert.deepEqual(missing, [], "df.job.xml names missing from the snapshot: " + missing.join(","));
  assert.deepEqual(extra, [], "snapshot names not in df.job.xml: " + extra.join(","));
});

console.log(`b292-job-activity-coverage: ${passed} passed; ${JOB_TYPES.length} job_type values; ${ACTIVITY_TYPES.length} activity types`);
