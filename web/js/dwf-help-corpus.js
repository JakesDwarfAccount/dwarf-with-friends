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
//
// GENERATED FILE -- do not edit by hand. Regenerate with:
//   node tools/harness/help_corpus_extractor.mjs
(function (root) {
  "use strict";
  var DFHelpCorpus = {
    "version": "help-corpus v1 (B207)",
    "surfaces": [
      {
        "id": "hotkeys",
        "label": "Keyboard & mouse shortcuts",
        "kind": "hotkeys",
        "entries": [
          {
            "control": "[ / ]",
            "text": "Zoom in / out",
            "group": "Camera"
          },
          {
            "control": "Arrows",
            "text": "Pan",
            "group": "Camera"
          },
          {
            "control": "e / c",
            "text": "Z-level up / down",
            "group": "Camera"
          },
          {
            "control": "E / C",
            "text": "Z-level up / down, 10 at a time",
            "group": "Camera"
          },
          {
            "control": "Home",
            "text": "Reset to host camera (client extra)",
            "group": "Camera"
          },
          {
            "control": "PageUp / PageDown",
            "text": "Z-level up / down (client alias)",
            "group": "Camera"
          },
          {
            "control": "w a s d",
            "text": "Pan (Shift = 2x, like DF's W A S D)",
            "group": "Camera"
          },
          {
            "control": "Shift+B",
            "text": "Obligations board",
            "group": "Client-only panels"
          },
          {
            "control": "Shift+F",
            "text": "Kitchen",
            "group": "Client-only panels"
          },
          {
            "control": "Shift+G",
            "text": "Petitions",
            "group": "Client-only panels"
          },
          {
            "control": "g",
            "text": "Gather plants",
            "group": "Designations"
          },
          {
            "control": "i",
            "text": "Item/building designations",
            "group": "Designations"
          },
          {
            "control": "l",
            "text": "Chop trees",
            "group": "Designations"
          },
          {
            "control": "m",
            "text": "Dig / Mine",
            "group": "Designations"
          },
          {
            "control": "Shift+T",
            "text": "Traffic designations",
            "group": "Designations"
          },
          {
            "control": "v",
            "text": "Smooth floors/walls",
            "group": "Designations"
          },
          {
            "control": "x",
            "text": "Erase designations",
            "group": "Designations"
          },
          {
            "control": "f",
            "text": "Toggle liquid numerals",
            "group": "Display toggles"
          },
          {
            "control": "r",
            "text": "Toggle ramp indicators",
            "group": "Display toggles"
          },
          {
            "control": "j",
            "text": "Justice",
            "group": "Fort panels"
          },
          {
            "control": "k",
            "text": "Stocks",
            "group": "Fort panels"
          },
          {
            "control": "n",
            "text": "Nobles",
            "group": "Fort panels"
          },
          {
            "control": "o",
            "text": "Work orders",
            "group": "Fort panels"
          },
          {
            "control": "q",
            "text": "Squads",
            "group": "Fort panels"
          },
          {
            "control": "Shift+O",
            "text": "Objects / Artifacts",
            "group": "Fort panels"
          },
          {
            "control": "Shift+P",
            "text": "Locations / Places",
            "group": "Fort panels"
          },
          {
            "control": "Shift+Y",
            "text": "World map",
            "group": "Fort panels"
          },
          {
            "control": "t",
            "text": "Tasks / Jobs",
            "group": "Fort panels"
          },
          {
            "control": "u",
            "text": "Units / Creatures",
            "group": "Fort panels"
          },
          {
            "control": "y",
            "text": "Labor",
            "group": "Fort panels"
          },
          {
            "control": "1 – 9",
            "text": "Jump camera to saved map location 1–9 (works from the map, menu open or not)",
            "group": "Locations"
          },
          {
            "control": "Click",
            "text": "Inspect a tile or use the active tool",
            "group": "Mouse controls"
          },
          {
            "control": "Ctrl + wheel, or pinch",
            "text": "Zoom the view",
            "group": "Mouse controls"
          },
          {
            "control": "Left drag",
            "text": "Draw a designation or placement",
            "group": "Mouse controls"
          },
          {
            "control": "Middle click",
            "text": "Centre on that tile (client extra)",
            "group": "Mouse controls"
          },
          {
            "control": "Middle drag",
            "text": "Pan the map",
            "group": "Mouse controls"
          },
          {
            "control": "Right click",
            "text": "Back out one layer",
            "group": "Mouse controls"
          },
          {
            "control": "Right drag",
            "text": "Pan the map (client extra)",
            "group": "Mouse controls"
          },
          {
            "control": "Shift + wheel",
            "text": "Z-level up / down, 10 at a time",
            "group": "Mouse controls"
          },
          {
            "control": "Wheel",
            "text": "Z-level up / down",
            "group": "Mouse controls"
          },
          {
            "control": "b",
            "text": "Build",
            "group": "Structures"
          },
          {
            "control": "h",
            "text": "Hauling routes",
            "group": "Structures"
          },
          {
            "control": "p",
            "text": "Stockpiles",
            "group": "Structures"
          },
          {
            "control": "Shift+U",
            "text": "Burrows",
            "group": "Structures"
          },
          {
            "control": "z",
            "text": "Zones",
            "group": "Structures"
          },
          {
            "control": "Esc",
            "text": "Back out one layer; opens the Esc menu when nothing else is open",
            "group": "System"
          },
          {
            "control": "Shift+H / ? / F1",
            "text": "This hotkey reference",
            "group": "System"
          },
          {
            "control": "Shift+N",
            "text": "Announcements",
            "group": "System"
          },
          {
            "control": "Space",
            "text": "Pause / Unpause",
            "group": "System"
          }
        ]
      },
      {
        "id": "tools",
        "label": "Toolbar & map tools",
        "kind": "tools",
        "entries": [
          {
            "control": "",
            "text": "Accept this stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Accept this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Back to the burrow list",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Discard this stockpile repaint",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Done painting this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Erase painted parts of this stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Erase painted parts of this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint a rectangle to extend this stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint a rectangle to extend this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint freehand to extend this stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint freehand to extend this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Path cost of [key] traffic. Type an exact value.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove this entire stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove this entire zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Zones",
            "hotkey": ""
          },
          {
            "control": "build",
            "text": "Finish placing structures.",
            "hotkey": "b"
          },
          {
            "control": "burrow",
            "text": "Finish establishing burrows.",
            "hotkey": "U"
          },
          {
            "control": "chop",
            "text": "Set tree chopping orders.",
            "hotkey": "l"
          },
          {
            "control": "citizens",
            "text": "Citizen and creature information.",
            "hotkey": "u"
          },
          {
            "control": "digMenu",
            "text": "Finish setting dig orders.",
            "hotkey": "m"
          },
          {
            "control": "erase",
            "text": "Erase designations.",
            "hotkey": "x"
          },
          {
            "control": "gather",
            "text": "Set plant gathering orders.",
            "hotkey": "g"
          },
          {
            "control": "hauling",
            "text": "Finish setting hauling routes.",
            "hotkey": "h"
          },
          {
            "control": "itemdesig",
            "text": "Designate items for dumping and melting, claim forbidden items and buildings, and set item visibility.",
            "hotkey": "i"
          },
          {
            "control": "justice",
            "text": "Justice.",
            "hotkey": "j"
          },
          {
            "control": "labor",
            "text": "Labor management.",
            "hotkey": "y"
          },
          {
            "control": "locations",
            "text": "Place information.",
            "hotkey": "P"
          },
          {
            "control": "nobles",
            "text": "Nobles and administrators.",
            "hotkey": "n"
          },
          {
            "control": "objects",
            "text": "Objects: artifacts, symbols, named items, written content.",
            "hotkey": "O"
          },
          {
            "control": "orders",
            "text": "Fortress job list.",
            "hotkey": "t"
          },
          {
            "control": "smooth",
            "text": "Finish setting wall orders.",
            "hotkey": "v"
          },
          {
            "control": "squads",
            "text": "Military and squads.",
            "hotkey": "q"
          },
          {
            "control": "stockpile",
            "text": "Finish placing stockpiles.",
            "hotkey": "p"
          },
          {
            "control": "traffic",
            "text": "Set traffic designations.",
            "hotkey": "T"
          },
          {
            "control": "workorders",
            "text": "Open the work orders menu.",
            "hotkey": "o"
          },
          {
            "control": "worldmap",
            "text": "World and civilizations.",
            "hotkey": "Y"
          },
          {
            "control": "zone",
            "text": "Designate a zone.",
            "hotkey": "z"
          },
          {
            "control": "channel",
            "text": "Dig channels: click the first corner",
            "group": "Active-tool status"
          },
          {
            "control": "chop",
            "text": "Chopping trees",
            "group": "Active-tool status"
          },
          {
            "control": "claim",
            "text": "Claiming forbidden items and buildings",
            "group": "Active-tool status"
          },
          {
            "control": "convertmarker",
            "text": "Converting to marker mode",
            "group": "Active-tool status"
          },
          {
            "control": "convertstandard",
            "text": "Converting to standard mode",
            "group": "Active-tool status"
          },
          {
            "control": "dig",
            "text": "Regular mining: click the first corner",
            "group": "Active-tool status"
          },
          {
            "control": "dump",
            "text": "Designating items for dumping",
            "group": "Active-tool status"
          },
          {
            "control": "engrave",
            "text": "Engraving smooth walls",
            "group": "Active-tool status"
          },
          {
            "control": "erase",
            "text": "Erase designations: click the first corner",
            "group": "Active-tool status"
          },
          {
            "control": "forbid",
            "text": "Forbidding items and buildings",
            "group": "Active-tool status"
          },
          {
            "control": "fortify",
            "text": "Carving fortifications",
            "group": "Active-tool status"
          },
          {
            "control": "gather",
            "text": "Gathering fruit and leaves",
            "group": "Active-tool status"
          },
          {
            "control": "hide",
            "text": "Hiding items",
            "group": "Active-tool status"
          },
          {
            "control": "melt",
            "text": "Designating items for melting",
            "group": "Active-tool status"
          },
          {
            "control": "ramp",
            "text": "Dig ramps: click the first corner",
            "group": "Active-tool status"
          },
          {
            "control": "remove",
            "text": "Remove constructions: click the first corner",
            "group": "Active-tool status"
          },
          {
            "control": "smooth",
            "text": "Smoothing rough floors and walls",
            "group": "Active-tool status"
          },
          {
            "control": "stairs",
            "text": "Dig stairs: select the first z-level",
            "group": "Active-tool status"
          },
          {
            "control": "track",
            "text": "Carving minecart tracks",
            "group": "Active-tool status"
          },
          {
            "control": "traffic",
            "text": "Designating high traffic area",
            "group": "Active-tool status"
          },
          {
            "control": "undump",
            "text": "Cancelling dump designations",
            "group": "Active-tool status"
          },
          {
            "control": "unhide",
            "text": "Setting items visible",
            "group": "Active-tool status"
          },
          {
            "control": "unmelt",
            "text": "Cancelling melt designations",
            "group": "Active-tool status"
          }
        ]
      },
      {
        "id": "guides",
        "label": "Guides",
        "kind": "guides",
        "entries": [
          {
            "control": "burrows",
            "title": "Burrows",
            "body": [
              "Burrows are work and living areas where citizens can be assigned. Workers will try to limit their tasks to the confines of the Burrow, but they will sometimes form paths which pass through other areas.",
              "Burrows can be suspended and unsuspended freely. When a Burrow is suspended, assigned citizens will ignore it.",
              "It can be useful to assign all of your civilians to a safe emergency Burrow which you activate in case of intruders."
            ]
          },
          {
            "control": "hauling",
            "title": "Minecart routes",
            "body": [
              "Minecarts and Tracks are a convenient way to move a lot of objects around the fortress quickly, though they take a little effort to prepare. One Minecart can be assigned to each route, and workers will move the vehicle from Track Stop to Track Stop according to conditions you specify.",
              "Each Track Stop must be linked to a Stockpile for Items to be put on or removed from the Minecart.",
              "Only one condition needs to be satisfied for the Minecart to move to the next Track Stop.",
              "Minecarts that move too quickly around corners will spill their contents. When a route has a steep descent, consider using powered Rollers, extra curves, track \"stops\" between Stops with various friction settings, or a worker to guide the vehicle."
            ]
          },
          {
            "control": "justice",
            "title": "Justice",
            "body": [
              "If you have a law enforcement administrator like a Sheriff or Captain of the Guard, witnesses of crimes will make reports, which find their way here. Certain crimes are indicative of larger problems, so you should pay attention to them, and affected victims and family members get upset if crime is ignored.",
              "It's up to you to choose whom to convict. All available witness information is presented for each case. You can also interrogate suspects. This is particularly important for schemes where the witnesses might not have the full story.",
              "It is recommended to place a certain number of Cages and Chains and assign them to a Dungeon zone. Officers may opt for physical punishment if they cannot carry out custodial sentences."
            ]
          },
          {
            "control": "nobles",
            "title": "Nobles and administrators",
            "body": [
              "Here you can view your nobles, as well as assign your military leaders, and other officials.",
              "Militia Commanders are assigned here. Once the first leader is assigned, subsequent Captain positions will appear. These can also be assigned from the squad menu.",
              "Certain important functions in your fortress can only be performed by assigned administrators, such as the Manager and Bookkeeper. Once they are assigned, you can create work orders, run a Hospital, and count and appraise your hoard.",
              "Nobles and certain administrators require rooms, and some may also make demands."
            ]
          },
          {
            "control": "stocks",
            "title": "Stocks",
            "body": [
              "Here you can see every Item in the fortress. Click on category headings to collapse and expand them.",
              "If you don't have a Bookkeeper, or they don't have an Office to work in, numbers may be approximate."
            ]
          },
          {
            "control": "world",
            "title": "The World",
            "body": [
              "The world created at the beginning of the game is active, and others may take an interest in your outpost as it grows. Stolen Artifacts and kidnapped citizens can be recovered by preparing missions from this screen.",
              "You can also cause trouble if you'd like to raid your neighbors. Raids are created by clicking on any site not belonging to your civilization."
            ]
          },
          {
            "control": "zones",
            "title": "Zones",
            "body": [
              "Zones are areas you designate where your citizens will work, socialize, rest, or perform specific duties. There are several kinds of Zones, which you can see in the panel on the left.",
              "Zones are placed much like Stockpiles. Unlike Stockpiles, multiple Zones can overlap.",
              "Certain Zones like Bedrooms can be placed several at a time. Just make sure you have the correct Furniture placed in the rooms with Doors or vertical entries separating each room before you begin."
            ]
          }
        ]
      },
      {
        "id": "world3d",
        "label": "3D world viewer",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "3D world viewer",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "8 layers above and 8 below the live camera",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close (Esc)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Every cached map chunk across every z-level your fort has dug or built on",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Re-frame the whole slab (F)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rebuild (R)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rebuild from the current world state (R)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "The top 8 z-levels of your fort",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "audio",
        "label": "Audio",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Audio & music",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Audio & Music",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Hand music back to the game (season/siege)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Mute all audio",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Next track",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Play for everyone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous track",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "UI click sounds",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "build",
        "label": "Build menu & info panels",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Artwork selection is not available in the browser yet",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cancel job",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cancel this task",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Center and flash",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Choose this animal's trainer",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Engrave memorial slab",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Female",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Forbid / unforbid",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Forbid / unforbid group",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Hide / show",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Hide / show group",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Keep building after placement",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Locate on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Male",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Mark / cancel dump",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Mark / cancel dump for group",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Open / manage",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Open this stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Recenter on the task's building",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Recenter on this unit",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove task",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by [label]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This worker is not specialized and will do any free tasks that become available. Click to toggle.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This worker is specialized and will only do tasks that match their workshop assignments, work details, and occupations. Click to toggle.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle repeat",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View item",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View this item",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View this unit",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Zoom to item",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "bzs",
        "label": "Buildings, zones & stockpiles",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "[label]: [...] on screen",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "[title]: on/off",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Add a give/take link",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Allow inorganic materials (native toggle; state not wired yet)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Allow organic materials (native toggle; state not wired yet)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Allow/Disallow [label]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Assign a new or existing location to this zone. Locations are groups of zones and rooms with a larger purpose, like a tavern, a temple, a library, or a craft guildhall.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Assign squads to this archery range/barracks (1 squad assigned/[N] squads assigned)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Assigned here -- view [name] on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Back one level",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Back to zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Bury citizens here",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Bury pets here",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cancel",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cancel order",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Claim/Forbid seed stack",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close the task picker",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Done",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Farm Plot",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Gather fallen fruit in this zone.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Gather fruit and vegetables from shrubs in this zone.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Gather fruit in trees in and just above this zone. Requires a stepladder.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Generated by a manager work order",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Give to a stockpile: click a stockpile on the map to link it",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Go to seed stack",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "How many general work orders may run here (0-99)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "How many to make (0-9999)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Item filters",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Linked stockpiles (give to / take from)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Locate on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Name this zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Native shows one more sort control here (Z12-jt-2); what it sorts is unverified",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Native sorts a unit-category column here; the /zone-owners wire carries no category data yet",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Next frequency",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Next skill level",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Next zone on this tile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Part of this building",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Part of this engine",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Pit (drop)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Pond (fill with water)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Power networks",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous frequency",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous skill level",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous zone on this tile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Queue a new task",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Reload linked buildings",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove task",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove this farm plot",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove this siege engine",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove this workshop",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename farm plot -- UNVERIFIED: the server exposes no farm-plot rename route yet",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename this engine -- UNVERIFIED: the server exposes no siege-engine rename route",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename this workshop",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Repaint area -- extend this zone by painting a rectangle on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Save name",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Set details for the assigned location.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Shoot from the east",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Shoot from the north",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Shoot from the south",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Shoot from the west",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Show/Hide seed stack",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Stockpile links",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Stockpile links (give to / take from)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Storage and tools",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Take from a stockpile: click a stockpile on the map to link it",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Task details (native meaning of this slot is unread -- see ledger 0078 Q5)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle everything in [label]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle fertilizing this farm every season",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle repeat",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Unavailable: a safe native unlink operation has not been verified.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Unlink",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View seed stack",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Workshop",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Zone name -- Enter saves, Escape reverts",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "chat",
        "label": "Chat",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Chat",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Click a unit or a tile to ping it (Esc cancels)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close chat",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Ping a unit or location on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Send this message",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "combat",
        "label": "Combat reports",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Alerts",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Open all announcements",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Recenter",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View this fighter's reports",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View this fighter's unit sheet",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "analytics",
        "label": "Fortress activity",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Fortress activity",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "hospital",
        "label": "Hospital",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "' + _hospEsc(r.unitNote) + '",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This option allows long-term residents of the fortress to enter this location.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This option allows visitors from outside the fortress to enter this location.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This option indicates that the location is only open to fortress citizens.",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "kitchen",
        "label": "Kitchen",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "[name] cannot be [verb].",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Next item type",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous item type",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by brewing state",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by cooking state",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by count",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by item type",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by name",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "labor",
        "label": "Labor & work orders",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Add suggested condition",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Back to the order list",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Change adjective",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Change comparison",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Change how often this order repeats",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Change item type",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Change material",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Child does chores",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Chore enabled",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Condition amount (Enter to apply)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Conditions",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Decrease quantity",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Delete work detail",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Done",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Fewer workshops",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Increase quantity",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Max workshops that may run this order at once (0 = any)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "More workshops",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Move down",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Move up",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "New condition",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "New order condition (after another order)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "New work order",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Quantity (Enter to apply)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove condition",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove order",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename work detail",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Runs after that order completes",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Runs once that order activates",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Select tasks",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Select to use in non-economic jobs",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by skill",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Type the most workshops that may run this order",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "lobby",
        "label": "Lobby",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Change your display name (others will see it)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Connected roster entry; RTT not sampled yet",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cursor color on the map",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Host: runs the fort",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Last inbound frame [N]s ago; RTT not sampled yet",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Measured websocket round trip",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Players",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Players - [N]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This is you",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "admin",
        "label": "Nobles & justice",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Assign / unassign this position",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Assign a symbol -- the native symbols screen is not implemented, so this tile does",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Bookkeeper precision [N]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Category sorting needs a `category` field on /justice (not served)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Center the view on [name] and open their profile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dwarf Fortress must create the report and apply skill, relationship, crime, and plot effects together.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Effective/Ineffective; [...]; unread",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Interrogation reports are write-once records; changing one would desynchronise the linked evidence.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Pardon commutes this convict's serving sentence and clears any pending",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Profession sorting needs a `profession` field on /justice (not served)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Return to the case",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by name",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "This cosmetic write is guarded until its native write site is verified.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "View [name]",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "obligations",
        "label": "Obligations board",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Make [N] [what]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Obligations",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "locations",
        "label": "Saved map locations",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Delete this recenter location",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Location name (Enter saves, Esc reverts)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Recenter locations",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Rename this location",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Set this location to the current view",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "settings",
        "label": "Settings",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Click, then press the new key",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Forget every remembered panel position and size",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Open the audio & music popover",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Reset the UI scale to 100%",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Reset to default (",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Restore every keybind to its default",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Settings",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "topbar",
        "label": "Top bar & toolbar",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Cancel dump designations",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Cancel melt designations",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Carve fortification in smooth wall",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Carve minecart track in stone floor or ramp",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Claim forbidden items and buildings",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Convert existing designations to marker mode",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Convert existing designations to marker mode (server endpoint pending)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Convert existing designations to standard mode",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Convert existing designations to standard mode (server endpoint pending)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Designate items for dumping",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Designate items for melting",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Designation priority (1 = highest, default 4)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig channel",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig every tile selected (v)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig only gems selected",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig only ore and gems selected (o)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig only ore/gems selected, and automine any of the same type uncovered (Shift+V)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig ramp",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig stairs down",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig stairs up",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Dig up/down stairwell",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Engrave artwork into smooth stone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Erase-paint: repaint (trim) an existing stockpile's footprint",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Erase-paint: trim an existing zone's footprint",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Forbid items and buildings",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Hide items",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Marker mode: place designations as blueprint markers (not active until toggled live)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Marker mode: place wall/smoothing orders as blueprint markers (not active until toggled live)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "More dig options (priority, marker, mine mode)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "More plant order options (marker and priority)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "More smoothing order options (priority, marker)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "New stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint mode: free-hand paint",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Paint mode: rectangle corners",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Regular dig",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove an existing stockpile",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove an existing zone",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Remove stairs/ramps and constructions",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Set items visible",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Set plant gathering orders",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Set tree chopping orders",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Smooth rough stone",
            "hotkey": ""
          },
          {
            "control": "0x177",
            "text": "Recenter on the surface at this location",
            "hotkey": ""
          },
          {
            "control": "0x178",
            "text": "Recenter on the deepest discovered area",
            "hotkey": ""
          },
          {
            "control": "alerts",
            "text": "Announcements",
            "hotkey": ""
          },
          {
            "control": "analyticsBtn",
            "text": "Fortress activity",
            "hotkey": ""
          },
          {
            "control": "consoleBtn",
            "text": "Command console (DFHack)",
            "hotkey": ""
          },
          {
            "control": "followBtn",
            "text": "Stop following / clear camera lock",
            "hotkey": ""
          },
          {
            "control": "helpBtn",
            "text": "Help",
            "hotkey": ""
          },
          {
            "control": "liquidNumbersBtn",
            "text": "Toggle liquid numerals",
            "hotkey": ""
          },
          {
            "control": "lobbyBtn",
            "text": "Players / lobby",
            "hotkey": ""
          },
          {
            "control": "minimapGrid",
            "text": "Click to center your camera here",
            "hotkey": ""
          },
          {
            "control": "minimapZoomInBtn",
            "text": "Zoom in ([)",
            "hotkey": ""
          },
          {
            "control": "minimapZoomOutBtn",
            "text": "Zoom out (])",
            "hotkey": ""
          },
          {
            "control": "moon",
            "text": "Weather",
            "hotkey": ""
          },
          {
            "control": "pause",
            "text": "Pause",
            "hotkey": ""
          },
          {
            "control": "play",
            "text": "Play",
            "hotkey": ""
          },
          {
            "control": "rampArrowsBtn",
            "text": "Toggle ramp-down arrows",
            "hotkey": ""
          },
          {
            "control": "recenterLocationsBtn",
            "text": "Recenter locations (saved camera bookmarks)",
            "hotkey": ""
          },
          {
            "control": "settingsBtn",
            "text": "Settings",
            "hotkey": ""
          },
          {
            "control": "stocks",
            "text": "Stock levels and item management.",
            "hotkey": "k"
          },
          {
            "control": "world3dBtn",
            "text": "3D world viewer (Shift+V)",
            "hotkey": ""
          },
          {
            "control": "zScrollbar",
            "text": "Drag to change elevation",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "trade",
        "label": "Trade depot",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Accept the merchant's counter-offer (native click on the host).",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Click the name to expand a container inline; click the check tile to mark for trade",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close this view (leaves the host's trade session as it is)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Feeds one native LEAVESCREEN to DF (selections are discarded).",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Mark every item currently listed for trade",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Native's mandate-culling filter (hide goods that would violate export mandates).",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Opens the bring-goods screen. Marked items are hauled to the depot by your dwarves.",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Refuse the merchant's counter-offer (native click on the host).",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by distance to the depot",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Sort by value",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "unitsel",
        "label": "Unit selection",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Next unit on this tile (Tab)",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Previous unit on this tile (Shift+Tab)",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "units",
        "label": "Units & notifications",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Center the view on [name]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Click to generate a portrait",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Combat history",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Customize identity",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Knowledge details are not implemented yet -- no server route exists for this",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Open this unit",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle this dwarf's membership in the [name] work detail",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Toggle whether this dwarf only works its assigned work details",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Weather: [weather]",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Zoom to this room and open it",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Zoom to this unit",
            "hotkey": ""
          }
        ]
      },
      {
        "id": "world",
        "label": "World map",
        "kind": "tooltips",
        "entries": [
          {
            "control": "",
            "text": "Back to civilizations",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Civilizations",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Close",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Missions",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Native composes each sentence from about twenty-one fragments; the server has to",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "News and rumors",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Not implemented yet -- read endpoint pending (WD-31 backlog).",
            "hotkey": ""
          },
          {
            "control": "",
            "text": "Reports",
            "hotkey": ""
          }
        ]
      }
    ]
  };
  root.DFHelpCorpus = DFHelpCorpus;
  if (typeof module !== "undefined" && module.exports) module.exports = DFHelpCorpus;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
