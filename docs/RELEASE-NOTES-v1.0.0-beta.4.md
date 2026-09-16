# Dwarf With Friends v1.0.0-beta.4

Beta 3 was about the code underneath: making it readable, making it easy for other people to
contribute to, and improving stability.

Beta 4 is about improving overall functionality and playability. Levers work. Animals can be
chained. Siege engines have a real control panel. Work orders include more job types.
Improved menu functionality. And a large number of panels across the whole mod have been rebuilt.

## Work orders

- Work orders support additional job types.
- Orders no longer eat economic stone. Queuing rock blocks was happily consuming platinum and coal.
- Recipes no longer ask for an ingredient the game does not, which used to send dwarves after the
  wrong thing whenever something was stored in a container, like dye in a bag.

## Building and workshops

- Greatly expanded functionality of many menus. There is still a lot of jank, this is one of the most challenging things about this mod. But, the overall goal for now is to increase functionality and decrease userflows that are genuinely broken.

- The farm crop picker has been rebuilt too. Pick a crop for each season, or leave it fallow.

## Levers and chains

- You can now link levers.
- You can add creatures to restraints.
- Removing a lever link and unchaining an animal are both still switched off. We have not confirmed
  how the game does either one safely, and we would rather show you a dead button than corrupt a
  save.

## Siege engines

- Siege engines now have functionality. You can choose their direction and set their firing states.
- This sheet is a bit janky, there is no display for ammo quantity, and the UI is a bit weird. But it works!

## Squads

- Individual soldiers can be given orders. Tick the names you want and the order buttons act on
  them.
- Squads show each soldier's actual order instead of claiming a squad had none when its members did.
- Squads made in the browser now have the correct emblem.
- Disbanding asks yes or no.
- Shrinking the squads panel no longer hides the selected-soldier controls below the bottom of the window.

## Hospital & Justice System

- Improved hospital and justice functionality and UI.

## The world screen

- The world map has some improved functionality as a foundation for future updates, but still isn't very practically useful from the browser. You'll still need to send missions and do diplomacy from the Steam client.

## The minimap

- Fixed minimap showing a strange chunk glitch visual underground.
- It shows the one z-level your camera is on, like the game, instead of every level composited into
  one picture.

## Odds and ends

- The game now defaults to native controls. No more shift+scroll to change elevation.
- Names with accented letters no longer break out of the game font halfway through a word.
- Dead and off-map units come through with a name.
- Stockpile painting behaves like the game: paint adds, erase removes, reshaping keeps your
  settings, extending keeps the tiles it already had.
- Hauling routes and their stops can be renamed. Cage and workshop worker lists have search boxes.
- The traffic overlay only draws when you have the traffic tool out, and the weights sit behind the
  game's advanced toggle.
- Selecting work details is fast. It used to visibly stall.
- You can hire a temple performer.
- The livestock trainer picker has been rebuilt. You can pick a particular dwarf, any trainer,
  any unassigned trainer, or none.
- Escape backs out one thing at a time, including help and settings windows. It should no longer
  close several things at once.
- Unit sheets keep your place when they redraw, including when a portrait arrives.
- Fixed controls that were supposed to be hidden but were still showing up. Help also stops Tab
  and zoom shortcuts from changing things behind it.

## Sprites and the map

- A great deal of art was wrong and is now right: trees, spatter, cave moss and fungus, cut gems,
  ammunition, several item categories, and a long tail of tiles that drew nothing at all.
- Grass under a mushroom is the right species, cavern fungus grows in coherent fields, locked doors
  look locked, instrument parts draw as parts, drawbridges raise the way they actually raise, and
  bolts fired below your camera are visible.
- Stone walls got a full pass: ordinary
  stones no longer draw from the ore vein sheet: that was the white bloom over plain rock, and
  constructions report their true material.
- Vampires, zombies and husks were being filed as corpses and left invisible. They draw now.
- The map is sharp on high-DPI displays instead of blurry and shimmering.
- By default the game no longer interpolates movement of sprites, which caused a rubberbanding look. Interpolation might help reduce the appearance of lag for some, so you can enable it in the settings "Smooth creature motion."

## Loading performance

- In prior versions, several refreshes were often required to load the game properly. We've implemented loading performance updates to improve this significantly.
- Arriving before the host is ready tells you so and recovers on its own, dropping gives you a
  reconnect banner rather than silence, and joining a fort that is already busy no longer times out.

## The 3D viewer

This is just a fun side project we have been working on. It is not really an essential part of
Dwarf With Friends, but we like it :)

- The viewer supports a wider vertical range than the previous 48-layer slice. A Z-range slider and a fit-to-fort button help navigate it.
- Water and magma render instead of appearing as a black mass, and the view is no longer mirrored.
- Textured floors, wall sides, see-under floors, waterfalls, trees and markers.

## Still beta

Beta 4 has known interface rough edges, including Labor layout and selection styling and occasional long announcement text overflow. No new full live gameplay test pass was performed for this release. If these issues get in your way, [beta 3](https://github.com/JakesDwarfAccount/dwarf-with-friends/releases/tag/v1.0.0-beta.3) remains the more stable fallback. Its Windows and Linux packages require Dwarf Fortress 0.53.15 with DFHack 53.15-r2; beta 4 requires Dwarf Fortress 0.53.16 with DFHack 53.16-r1. Follow beta 3’s own setup instructions in a compatible installation. Do not assume a save opened in a newer Dwarf Fortress version can be downgraded.

- Some controls are deliberately disabled and say so when you hover them. There is still much to do.
- Siege controls have rough layout and no ammunition quantity display.
- Linux has had less real-world testing than Windows. If you host on Linux, tell us what breaks.
