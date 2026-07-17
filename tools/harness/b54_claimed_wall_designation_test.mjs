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

// B54 claimed-wall regression. Run: node tools/harness/b54_claimed_wall_designation_test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const read=(...p)=>fs.readFileSync(path.join(root,...p),"utf8");
const world=read("src","world_stream.cpp");
const glbox={self:null,performance:{now:()=>0}}; glbox.self=glbox; vm.createContext(glbox);
vm.runInContext(read("web","js","dwf-adjacency.js"),glbox);
vm.runInContext(read("web","js","dwf-gl.js"),glbox);
const GL=glbox.DwfGL;
class FakeCanvas { constructor(){this.width=800;this.height=600;this.style={};}
 addEventListener(){} removeEventListener(){} getContext(){return new Proxy({},{get(t,p){if(p in t)return t[p];if(p==="measureText")return()=>({width:8});return()=>{};},set(t,p,v){t[p]=v;return true;}});}}
globalThis.window=globalThis; globalThis.location={search:"",protocol:"http:",host:"localhost"};
globalThis.document={hidden:false,addEventListener(){},getElementById(){return null;},createElement(){return{style:{}};},body:{appendChild(){}}};
globalThis.addEventListener=()=>{}; globalThis.sessionStorage={getItem(){return null;},setItem(){}};
globalThis.Image=class{set src(_) {}}; globalThis.fetch=async()=>({ok:false,json:async()=>null});
vm.runInThisContext(read("web","js","dwf-tiles.js"));
const Tiles=globalThis.DwfTiles.init({canvas:new FakeCanvas(),managePoll:false,manageCamera:false});
for(const [kind,cat] of [[7,"dig"],[8,"stair"],[9,"stair"],[10,"stair"],[11,"ramp"],[12,"channel"],[13,"removeConstruction"]]){
 assert.equal(GL.resolveDjob(kind,null)?.cat,cat,`GL kind ${kind}`);
 assert.equal(Tiles._resolveDjobForTest(kind,null)?.cat,cat,`canvas kind ${kind}`);
}
for(const job of ["Dig","CarveUpwardStaircase","CarveDownwardStaircase","CarveUpDownStaircase","CarveRamp","DigChannel","RemoveConstruction"])
 assert.match(world,new RegExp(`case df::job_type::${job}:\\s+kind = `),`server emits ${job}`);
const wall={tt:1,ttname:"StoneWall",shape:"WALL",mat:"STONE",hidden:false,flow:0,liquid:"none",outside:0};
const floor={...wall,ttname:"StoneFloor",shape:"FLOOR"};
assert.equal(Tiles._resolveTileDesignationForTest(wall,7)?.glyph?.cat,"dig","canvas actual claimed-job overlay path");
assert.equal(Tiles._resolveTileDesignationForTest(wall,0),null,"undesignated wall stays unmarked");
function atlas(){const ids=new Map();let next=1;return{resolve(s,c,r){const k=`${s}|${c}|${r}`;if(!ids.has(k))ids.set(k,next++);return ids.get(k);},resolvePalette(s,c,r){return this.resolve(s,c,r);}};}
function decode(b){const f=new Float32Array(b.buffer),u=new Uint16Array(b.buffer);return Array.from({length:b.count},(_,i)=>({x:f[i*4],y:f[i*4+1],cell:u[i*8+4]}));}
const a=atlas(),b=GL.createSceneBuilder({atlas:a,spriteMap:{},tokenMap:{},shadowCellMap:{},adjacency:glbox.DwfAdjacency});
const tiles=Array.from({length:9},()=>floor); tiles[4]=wall; tiles[5]=floor;
b.buildScene({origin:{x:0,y:0,z:150},width:3,height:3,tiles,djobs:[{x:1,y:1,z:150,k:7}]});
const glyph=a.resolve("designations.png",0,1);
assert.ok(decode(b).some(i=>i.x===1&&i.y===1&&i.cell===glyph),"GL actual scene emits glyph on wall beside hallway");
function assertVisible(resolve){assert.equal(resolve(wall,7)?.cat,"dig");}
assert.throws(()=>assertVisible((_t,k)=>k<=6?{cat:"other"}:null),"test-the-test rejects pre-fix six-kind path");
assertVisible((t,k)=>GL.resolveDjob(k,t));
assertVisible((t,k)=>Tiles._resolveTileDesignationForTest(t,k)?.glyph);
console.log("PASS B54 claimed exposed-wall mining glyph: server + GL + canvas2d");
