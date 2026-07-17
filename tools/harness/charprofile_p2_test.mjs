// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, version 3 of the License.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
// Full license: see LICENSE. Third-party credits: see NOTICE.
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = { setTimeout, addEventListener() {} };
globalThis.fetch = async () => ({ ok: false });
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
globalThis.unitImagesEnabled = true;
// The profile body is a DWFUI grid now (the composition rule: the GRID owns the dividers, a cell
// draws nothing), so the renderers need the shared layer in scope exactly as the live client does.
globalThis.DWFUI = (await import("../../web/js/dwf-ui-components.js")).default;
globalThis.window.DWFUI = globalThis.DWFUI;

const { renderUnitTabBody, renderUnitLaborPanel } =
  await import("../../web/js/dwf-unit-hud-notifications.js");

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log("PASS " + label); }
  catch (error) { console.log("FAIL " + label); throw error; }
}

const skills = [
  { id: 2, category: "Labor", caption: "Carpenter", ratingCaption: "Professional", rating: 9, effectiveRating: 9, rusty: false, colorRole: "attention", order: 0 },
  { id: 1, category: "Labor", caption: "Woodcutter", ratingCaption: "Competent", rating: 3, effectiveRating: 2, rusty: true, colorRole: "attention", order: 1 },
  { id: 37, category: "Combat", caption: "Axedwarf", ratingCaption: "Dabbling", rating: 0, effectiveRating: 0, rusty: false, colorRole: "accent", order: 2 },
  { id: 92, category: "Social", caption: "Speaker", ratingCaption: "Adequate", rating: 2, effectiveRating: 1, rusty: true, colorRole: "neutral", order: 3 },
  { id: 90, category: "Other skills", caption: "Poet", ratingCaption: "Competent", rating: 3, effectiveRating: 2, rusty: true, colorRole: "neutral", order: 4 }
];

console.log("# PR4 Skills");
for (const [detail, present, absent] of [
  ["Labor", "Professional Carpenter", "Axedwarf"],
  ["Combat", "Dabbling Axedwarf", "Carpenter"],
  ["Social", "Adequate Speaker", "Poet"],
  ["Other skills", "Competent Poet", "Speaker"]
]) {
  check(`${detail} is an independent native skill category`, () => {
    const html = renderUnitTabBody({ skills, skillLines: ["stale flat fallback (Lv 99, 1/2 xp)"] }, "Skills", detail);
    assert.match(html, new RegExp(present));
    assert.doesNotMatch(html, new RegExp(absent));
    assert.doesNotMatch(html, /\bLv\b|\bxp\b|stale flat fallback/i);
  });
}
check("rust is a separate suffix and native noun captions survive", () => {
  const labor = renderUnitTabBody({ skills }, "Skills", "Labor");
  assert.match(labor, /Competent Woodcutter<\/span>\s*<span class="unit-skill-rust"> \(Rusty\)/);
  assert.doesNotMatch(labor, /Wood Cutting|Carpentry/);
});

const knowledge = [
  { type: "poetic-form", id: 4, title: "The Letter of Prophecies", subtype: "Poetic form", colorRole: "form", detailTarget: "poetic-form:4", order: 0 },
  { type: "written-content", id: 8, title: "The Wind Foretells", subtype: "Poem", colorRole: "work", detailTarget: "written-content:8", order: 1 }
];
check("Knowledge uses two-line rows and a detail affordance", () => {
  const html = renderUnitTabBody({ knowledge }, "Skills", "Knowledge");
  assert.ok(html.indexOf("Letter of Prophecies") < html.indexOf("Wind Foretells"));
  assert.match(html, /unit-knowledge-subtype unit-prose-form">Poetic form/);
  assert.match(html, /unit-knowledge-subtype unit-prose-work">Poem/);
  assert.equal((html.match(/data-unit-knowledge-detail=/g) || []).length, 2);
});

console.log("# PR5 Personality");
const personalityNarrative = {
  traits: [{ spans: [
    { text: "She has a natural inclination toward language", role: "positive" },
    { text: ", but she has very bad intuition.", role: "negative" }
  ] }],
  values: [{ spans: [
    { text: "Like others in her culture, she values craftsmanship and art.", role: "neutral" },
    { text: " She personally values harmony.", role: "personal-positive" },
    { text: " Her dream was realized.", role: "dream" }
  ] }],
  preferences: [{ spans: [
    { text: "Olon Esmonom likes microcline, battle axes and sand pear cider.", role: "neutral" },
    { text: " She absolutely detests fire snakes.", role: "negative" }
  ] }],
  needs: [
    { spans: [{ text: "Overall, she is unfocused by unmet needs.", role: "warning" }] },
    { spans: [
      { text: "She is ", role: "neutral" }, { text: "distracted", role: "attention" },
      { text: " after being unable to pray to Avuz Scarletmauve.", role: "neutral" }
    ] }
  ]
};
for (const detail of ["Traits", "Values", "Preferences", "Needs"]) {
  check(`${detail} renders server-authored semantic prose`, () => {
    const html = renderUnitTabBody({
      personalityNarrative,
      personalityTraitLines: ["stale raw trait"], personalityValueLines: ["Harmony: 12"],
      personalityPreferenceLines: ["Material preference: 1, 2, 3, 4"],
      personalityNeedLines: ["Acquireobject (focus -23198)"]
    }, "Personality", detail);
    assert.match(html, /unit-prose-block/);
    assert.doesNotMatch(html, /stale raw trait|Harmony: 12|Material preference|Acquireobject|focus -/);
  });
}
check("Traits preserve positive and negative spans in one sentence", () => {
  const html = renderUnitTabBody({ personalityNarrative }, "Personality", "Traits");
  assert.match(html, /unit-prose-positive/);
  assert.match(html, /unit-prose-negative/);
});
check("Preferences resolve natural names and absolute hatred", () => {
  const html = renderUnitTabBody({ personalityNarrative }, "Personality", "Preferences");
  assert.match(html, /microcline, battle axes and sand pear cider/);
  assert.match(html, /absolutely detests fire snakes/);
});

console.log("# PR6 Thoughts");
const thoughts = {
  recent: [
    { order: 0, spans: [{ text: "She feels ", role: "neutral" }, { text: "satisfied", role: "emotion-positive" }, { text: " at work.", role: "neutral" }] },
    { order: 1, spans: [{ text: "She felt ", role: "neutral" }, { text: "pleasure", role: "emotion-positive" }, { text: " remembering", role: "memory" }, { text: " a fine Bed.", role: "neutral" }] }
  ],
  memories: [
    { order: 0, spans: [{ text: "She felt ", role: "neutral" }, { text: "fondness", role: "emotion-positive" }, { text: " remembering", role: "memory" }, { text: " making a friend.", role: "neutral" }] }
  ]
};
check("Recent thoughts exclude Memories and browser-only Stress", () => {
  const html = renderUnitTabBody({ thoughts, thoughtLines: ["Stress: -99460 (Overwhelmed)", "[varying]"] }, "Thoughts", "Recent thoughts");
  assert.match(html, /satisfied/);
  assert.match(html, /fine Bed/);
  assert.doesNotMatch(html, /making a friend|Stress:|\[varying\]/);
});
check("Memories is a distinct semantic prose surface", () => {
  const html = renderUnitTabBody({ thoughts }, "Thoughts", "Memories");
  assert.match(html, /making a friend/);
  // B294: spans without a served native color carry style="color:inherit" (neutralizing the old
  // guessed CSS hue) -- tolerate attributes between the class and the text.
  assert.match(html, /unit-prose-memory"[^>]*> remembering/);
  assert.doesNotMatch(html, /satisfied at work|fine Bed/);
});

console.log("# PR7 Labor work animals");
const laborData = { details: [], rows: [{ id: 42, specialist: false, assignedTo: "" }] };
check("assigned and assignable work animals are structured beneath the shared header", () => {
  const html = renderUnitLaborPanel({
    id: 42,
    laborWorkAnimalLines: ["stale No work animals assigned."],
    laborWorkAnimals: [
      { unitId: 7, name: "Mistem", trainingType: "Hunting training", assignmentState: "assignable", order: 20 },
      { unitId: 8, name: "Deler", trainingType: "War training", assignmentState: "assigned", order: 10 }
    ]
  }, "Work animals", laborData);
  assert.match(html, /Will do available tasks anywhere/);
  assert.ok(html.indexOf("Deler") < html.indexOf("Mistem"));
  assert.match(html, /War training/);
  assert.match(html, />Assigned</);
  assert.match(html, />Assignable</);
  assert.doesNotMatch(html, /stale No work animals assigned|Unit\s+[78]/);
});
check("structured empty work animals preserve exact native wording", () => {
  const html = renderUnitLaborPanel({ id: 42, laborWorkAnimals: [] }, "Work animals", laborData);
  assert.match(html, /Will do available tasks anywhere/);
  assert.match(html, /No assigned or assignable work animals/);
  assert.match(html, /unit-list-grid-unboxed/);
});

console.log("# additive server and known-bad guards");
const header = readFileSync(new URL("../../src/unit_sheet.h", import.meta.url), "utf8");
const cpp = readFileSync(new URL("../../src/unit_sheet.cpp", import.meta.url), "utf8");
const infoPanel = readFileSync(new URL("../../src/info_panel.cpp", import.meta.url), "utf8");
for (const member of ["std::vector<UnitSkillRecord> skills", "std::vector<UnitKnowledgeRecord> knowledge",
  "std::vector<UnitNeedRecord> needs", "std::vector<UnitThoughtRecord> recent_thoughts",
  "std::vector<UnitThoughtRecord> memories", "std::vector<UnitLaborAnimalRecord> labor_work_animals"]) {
  check(`server declares additive ${member}`, () => assert.ok(header.includes(member)));
}
for (const field of ["\\\"skills\\\"", "\\\"knowledge\\\"", "\\\"personalityNarrative\\\"", "\\\"thoughts\\\"", "\\\"laborWorkAnimals\\\""]) {
  check(`server serializes ${field}`, () => assert.ok(cpp.includes(field)));
}
check("Preferences use the real unit_soul preference vector", () => {
  assert.match(cpp, /for \(auto pref : soul->preferences\)/);
  assert.doesNotMatch(cpp, /soul->personality\.preferences/);
});
check("Traits include mannerisms and habits instead of the old selected-facet subset", () => {
  assert.match(cpp, /soul->personality\.mannerism/);
  assert.match(cpp, /soul->personality\.habit/);
  assert.match(cpp, /facet_phrases\[\]/);
});
check("Knowledge reads every authored known-info collection", () => {
  for (const field of ["known_written_contents", "known_poetic_forms", "known_musical_forms", "known_dance_forms"])
    assert.ok(cpp.includes(field));
});
check("thought records carry category, chronology, strength, and a dedup key", () => {
  for (const field of ["category", "strength", "year_tick", "dedup_key"])
    assert.ok(header.includes(field));
  assert.ok(cpp.includes("\\\"dedupKey\\\""));
});
check("skill records use native noun captions, rust, and enum XP thresholds", () => {
  assert.match(cpp, /attrs\.caption_noun/);
  assert.match(cpp, /skill->rusty/);
  assert.match(cpp, /rating_attrs\.xp_threshold/);
  assert.doesNotMatch(cpp.slice(cpp.indexOf("unit_skill_records"), cpp.indexOf("unit_room_lines")), /500 \+ 100/);
});
// B242: this check pinned the PRE-B233-2 implementation, which listed
// plotinfo.training.training_assignments -- DF's ANIMAL TRAINING assignment ("who trains this
// creature"), a different concept from a WORK ANIMAL. B233-2 rebuilt the tab on DF's real
// work-animal field and ADDED the write the old check asserted was absent. Pinning the deleted
// implementation kept this suite red AND would have "protected" the wrong DF concept, so the check
// now states the contract B233-2 actually ships.
check("work animals are read from DF's real work-animal field (PetOwner), living animals only", () => {
  // The owner relationship, not the trainer assignment. (find_training_assignment still reads the
  // training vector elsewhere -- that IS the right source for an animal's own trainer label -- so
  // the negative is scoped to the work-animal function body.)
  const workAnimals = cpp.slice(cpp.indexOf("std::vector<UnitLaborAnimalRecord> unit_labor_work_animals"));
  const body = workAnimals.slice(0, workAnimals.indexOf("\n}\n") + 3);
  assert.match(body, /relationship_ids\[df::enums::unit_relationship_type::PetOwner\]/);
  assert.doesNotMatch(body, /training_assignments/,
    "the animal-TRAINING vector is the wrong DF concept for the work-animal tab");
  // B214: corpses and ghosts are retained in units.active -- a dead war dog must never be listed.
  assert.match(cpp, /!Units::isAnimal\(animal\) \|\| !Units::isActive\(animal\) \|\| Units::isDead\(animal\)/);
  // Eligibility == DF's own AssignWorkAnimal list: unowned, own-civ, tame, war or hunting.
  assert.match(cpp, /animal_owner == -1 && owner_is_citizen &&\s*Units::isOwnCiv\(animal\) && Units::isTame\(animal\) &&\s*\(Units::isWar\(animal\) \|\| Units::isHunter\(animal\)\)/);
  // The list and the write share ONE gate, so the UI can never offer a row the write refuses.
  assert.match(cpp, /work_animal_blocked_reason\(animal\)/);
  assert.match(infoPanel, /std::string work_animal_blocked_reason\(df::unit\* animal\)/);
  assert.match(infoPanel, /bool set_work_animal_owner\(df::unit\* animal, int32_t owner_id, std::string\* err\)/);
  assert.match(infoPanel, /work_animal_blocked_reason\(animal\)/, "the write consults the same gate the list renders");
});

console.log(`\ncharprofile p2: ${passed} passed`);
