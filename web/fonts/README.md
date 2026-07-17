# Font asset provenance

`df-curses.ttf` is the project-generated trace of Dwarf Fortress's 8×12 curses atlas
(`data/art/curses_640x300.png`), produced by `tools/ws2/build_df_font.mjs`. The glyph shapes are
Bay 12 Games' artwork and are not covered by this project's licence; the full provenance,
regeneration command, and contingency plan are in the repository [NOTICE](../../NOTICE). The
generator's tests and the glyph-font harness suite cover this file.

No other font ships in this directory. Any face added for local comparison must have its licence
verified before it can be selected by the live game UI or packaged in a release.
