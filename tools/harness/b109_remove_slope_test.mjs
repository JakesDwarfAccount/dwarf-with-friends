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

// B109 remove-slope regression. Run: node tools/harness/b109_remove_slope_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const placement=fs.readFileSync(path.join(root,"src","placement.cpp"),"utf8");
const guard=placement.match(/bool can_remove_stairs_ramps\([\s\S]*?\n\}/)?.[0]||"";
assert.match(guard,/tiletype_material::CONSTRUCTION \|\|[\s\S]*?Constructions::findAtTile\(pos\)/);
assert.match(guard,/tiletype_shape::RAMP_TOP[\s\S]*?pos\.z - 1[\s\S]*?tiletype_shape::RAMP/);
assert.doesNotMatch(guard,/switch\s*\([^)]*shape/);
assert.match(placement,/can_remove_stairs_ramps\(map, pos, target\)[\s\S]*?pos = target;[\s\S]*?des\.bits\.dig = df::tile_dig_designation::Default/);
assert.match(placement,/\(changed \|\| des_priority > 0\).*setDesignationAt/);
const shapes=["WALL","FLOOR","FORTIFICATION","STAIR_UP","STAIR_DOWN","STAIR_UPDOWN","RAMP","TRACK_RAMP"];
function targetFor(t,below){if(t.hidden)return null;if(t.material==="CONSTRUCTION"||t.hasConstruction)return t.pos;
 if(["RAMP","STAIR_UP","STAIR_DOWN"].includes(t.shape))return t.pos;
 if(t.shape==="RAMP_TOP"&&below&&!below.hidden&&below.shape==="RAMP")return below.pos;return null;}
for(const shape of shapes)assert.deepEqual(targetFor({shape,material:"OTHER",hasConstruction:true,hidden:false,pos:[1,2,169]}),[1,2,169],shape);
const top={shape:"RAMP_TOP",material:"AIR",hidden:false,pos:[47,92,169]};
const ramp={shape:"RAMP",material:"CONSTRUCTION",hidden:false,pos:[47,92,168]};
assert.deepEqual(targetFor(top,ramp),ramp.pos,"up-slope proxy maps to constructed ramp");
function accepted(w,h,make){let n=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(targetFor(make(x,y),ramp))n++;return n;}
assert.equal(accepted(2,3,(x,y)=>({...ramp,pos:[47+x,92+y,169]})),6,"logged 2x3 box");
assert.equal(accepted(4,1,(x,y)=>({...ramp,pos:[49+x,94+y,169]})),4,"logged 4x1 box");
assert.equal(accepted(1,1,()=>top),1,"logged single slope");
const old=t=>!t.hidden&&t.material==="CONSTRUCTION"?t.pos:null;
assert.throws(()=>assert.deepEqual(old(top),ramp.pos),"test-the-test rejects old material-only proxy path");
console.log("PASS B109 construction matrix + natural/constructed upward-slope proxy + logged boxes");
