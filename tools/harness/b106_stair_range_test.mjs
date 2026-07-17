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

// B106/B58 stair range regression. Run: node tools/harness/b106_stair_range_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const read=(...p)=>fs.readFileSync(path.join(root,...p),"utf8");
const controls=read("web","js","dwf-controls-placement.js");
const core=read("web","js","dwf-core.js");
const placement=read("src","placement.cpp");
const gridSource=core.match(/  function stairPreviewGrid\(preview, rendered\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(gridSource,"persistent preview helper exists");
const box={};vm.createContext(box);vm.runInContext(gridSource+"\nthis.convert=stairPreviewGrid;",box);
assert.deepEqual(JSON.parse(JSON.stringify(box.convert({x1:47,y1:61,x2:52,y2:71,z:169},{ox:40,oy:55}))),
 {ax:7,ay:6,bx:12,by:16},"preview is world-anchored");
assert.equal(box.convert({x1:"bad",y1:1,x2:2,y2:3},{ox:0,oy:0}),null);
const labelSource=core.match(/  function designationZRangeLabel\(preview\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(labelSource,"z-extent label helper exists");
vm.runInContext(labelSource+"\nthis.zlabel=designationZRangeLabel;",box);
assert.equal(box.zlabel({z1:169,z2:166}),"Z 166-169 (4 levels)",
  "in-progress preview explicitly shows the full z extent");
assert.equal(box.zlabel({z1:169,z2:169}),"");
// Edited 2026-07-11 (B193): designateStairRange became designateTwoClickRange -- the same
// two-click gesture, generalized from stairs/erase to every rectangle designation tool.
const fn=controls.match(/  async function designateTwoClickRange\([\s\S]*?\n  \}/)?.[0]||"";
assert.match(fn,/stairRangeStart = selection;[\s\S]*?showDesignationRangePreview\(selection, selection\.z\);/);
assert.match(fn,/start\.z === pointZ[\s\S]*?return/);
// B196: the second click commits bbox(anchor, this click) -- the rubber-banded rect the cursor
// tracked -- not the frozen first-click footprint, then delegates to the shared volume submitter.
assert.match(fn,/const rect = twoClickRangeMerge\(start, selection\);/,
  "second release completes the rubber-banded box, merging the anchor with the second click");
assert.match(fn,/await submitDesignationRange\(rect, pointZ\);/,
  "the second click delegates to the shared volume submitter");
const submit=controls.match(/  async function submitDesignationRange\([\s\S]*?\n  \}/)?.[0]||"";
assert.match(submit,/const px1 = values\[0\] - values\[6\][\s\S]*?const px2 = values\[2\] - values\[6\]/);
assert.match(submit,/px=\$\{px1\}.*py=\$\{py1\}[\s\S]*?px2=\$\{px2\}.*py2=\$\{py2\}/);
assert.match(submit,/designationTool === "stairs" \? "stairs"/);
assert.match(submit,/zlevels=\$\{values\[4\] - values\[5\]\}/);
assert.match(submit,/stairRangePreview = null/);
assert.match(submit,/await whenCameraMovesFlushed\(\)/,
  "designation waits for its Shift+wheel camera endpoint before POSTing");
const waitSource=core.match(/  function whenCameraMovesFlushed\(\) \{[\s\S]*?\n  \}/)?.[0]||"";
const resolveSource=core.match(/  function resolveMoveWaiters\(\) \{[\s\S]*?\n  \}/)?.[0]||"";
const waitBox={sending:true,queued:{dx:0,dy:0,dz:-1},moveWaiters:[]};
vm.createContext(waitBox);
vm.runInContext(waitSource+"\n"+resolveSource+"\nthis.wait=whenCameraMovesFlushed;this.resolveAll=resolveMoveWaiters;",waitBox);
let cameraReady=false;
const pending=waitBox.wait().then(()=>{cameraReady=true;});
await Promise.resolve();
assert.equal(cameraReady,false,"pending camera move keeps designation gated");
waitBox.resolveAll();
await pending;
assert.equal(cameraReady,true,"camera completion releases the designation POST");
function payload(s,c,f){return{px:s.x1-c.x,py:s.y1-c.y,px2:s.x2-c.x,py2:s.y2-c.y,w:f.w,h:f.h,zlevels:s.z-c.z};}
function assertArea(p){assert.notEqual(p.px,p.px2);assert.notEqual(p.py,p.py2);assert.equal(p.zlevels,3);}
const start={x1:47,y1:61,x2:52,y2:71,z:169};
assertArea(payload(start,{x:40,y:55,z:166},{w:80,h:50}));
assert.throws(()=>assertArea({px:7,py:6,px2:7,py2:6,zlevels:3}),"test-the-test rejects old one-column payload");
const cap=placement.match(/bool is_stair =[\s\S]*?if \(is_stair && z_hi > z_lo\) \{[\s\S]*?\n        \}/)?.[0]||"";
assert.match(cap,/z == z_hi\)\s+level_dig = df::tile_dig_designation::DownStair/);
assert.match(cap,/z == z_lo\) level_dig = df::tile_dig_designation::UpStair/);
assert.match(cap,/else\s+level_dig = df::tile_dig_designation::UpDownStair/);
const bits=(z,lo,hi)=>z===hi?"DownStair":z===lo?"UpStair":"UpDownStair";
assert.deepEqual([166,167,168,169].map(z=>bits(z,166,169)),["UpStair","UpDownStair","UpDownStair","DownStair"]);
assert.match(placement,/\(changed \|\| des_priority > 0\).*setDesignationAt/);
// Edited 2026-07-11 (B193): the two held-drag release assertions (completedRange.shifted commit
// + the stairs/erase-only two-release fallback) are replaced by the single two-click routing --
// click-drag no longer commits a designation, and the two-click flow is tool-agnostic.
const pointerUp=controls.match(/view\.addEventListener\("pointerup"[\s\S]*?\n  \}\);/)?.[0]||"";
assert.match(pointerUp,/rangeDesignationTools\.has\(selectedDesignation\) && paintMode === "rect"\) \{\s*designateTwoClickRange\(downX, downY, event\.clientX, event\.clientY\);/,
  "every rect-mode rectangle designation commits through the two-click handler");
assert.doesNotMatch(pointerUp,/completedRange/,
  "the held-drag commit path stays removed");
console.log("PASS B106/B58 two-click stair range, persistent preview, payload, and caps");
