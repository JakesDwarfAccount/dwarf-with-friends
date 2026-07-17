# Sprite and token-map builders

This directory generates JSON maps and bitmap assets consumed by the browser client.
Builders read DF raws and graphics through the shared DF-root policy.

Read first:

- `build_building_map.py` — building and overlay tokens.
- `build_creature_map.py` — creature and vermin mappings.
- `build_item_map.py` — item mappings.
- `build_df_font.mjs` — deterministic bitmap font.
- `tests/` — generator contracts.

Do not hand-edit generated maps when a builder owns the field.
Never hardcode a DF install; use the resolver and skip cleanly without raws.
Add no dependencies. Run focused tests and inspect generated diffs for unexplained churn.
