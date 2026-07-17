# TEST-MAP — which tests cover which file

**Generated. Do not hand-edit.** Regenerate with `python tools/harness/build_test_map.py`.

You changed a file. Find it below. Run the tests listed next to it:

```
node tools/harness/<test-name>.mjs
```

No build step, no install. A test prints its own failures and exits non-zero.

- **121** source files have at least one specific test
- **15** have none — see *Blind spots* below
- **254** tests are mapped; **1** broad sweeps run against nearly everything

## Blind spots — files with no test

A change here can pass every gate and still be broken. Highest value place to add a test.

- `web/js/dwf-chrome.js`
- `web/js/dwf-keymap.js`
- `web/js/dwf-overlay-boxes.js`
- `src/chat.cpp`
- `src/image_encoder.cpp`
- `src/lever_link.cpp`
- `src/menu_oracle.cpp`
- `src/music_sync.cpp`
- `src/oracle_routes.cpp`
- `src/overlay_control.cpp`
- `src/sound_route.cpp`
- `src/stone_use.cpp`
- `src/tile_dump.cpp`
- `src/unit_sprites.cpp`
- `src/web_assets.cpp`

## Always-run sweeps

These read most of the codebase. Run them after any
change to shared code — DWFUI, core, the panel frame — regardless of what the map says.

- `node tools/harness/help_corpus_extractor.mjs`

## The map

### Browser client — web/js/

| file | tests to run |
| --- | --- |
| `dwf-adjacency.js` | `b235_worldseam_test.mjs` `b256_projectile_sprite_test.mjs` `b270_furniture_state_test.mjs` `b273_material_tint_test.mjs` `b27a_farmplot_test.mjs` `b36_wall_adjacency_test.mjs` `b47_construction_floor_test.mjs` `b54_claimed_wall_designation_test.mjs` `b62_trunk_walljoin_test.mjs` `b74_b93_surfaces_test.mjs` `construction_remainder_test.mjs` `flows_miasma_test.mjs` `gem_water_parity_test.mjs` `gl_core_test.mjs` `grass_under_pebbles_test.mjs` `groundart_tx6_species_test.mjs` `hatch_cover_item_map_test.mjs` `pause_anim_test.mjs` `renderer_wave_test.mjs` `t1_material_parity_test.mjs` `tx10_tx11_table_leather_test.mjs` `tx13_meat_sprites_test.mjs` `tx17_planned_construction_test.mjs` `tx1_barrel_peek_test.mjs` `tx4_farm_crops_test.mjs` `wallsfix_construction_test.mjs` `wb11_sparse_test.mjs` `wb12_buildings_test.mjs` `wb15_anim_test.mjs` `wc22_gl_proj_test.mjs` `wc6_wc8_machine_test.mjs` `wcclient_matrix_test.mjs` `window11_meatfish_test.mjs` `window12_corpse_test.mjs` `window13_component_tint_test.mjs` |
| `dwf-analytics-panel.js` | `analytics_fixture_test.mjs` `panel_frame_test.mjs` |
| `dwf-animclock.js` | `pause_anim_test.mjs` |
| `dwf-announce-taxonomy.js` | `b232_announce_screen_test.mjs` |
| `dwf-announcement-format.js` | `b232_announce_screen_test.mjs` `tx14_announce_test.mjs` |
| `dwf-announcements.js` | `announcement_parity_test.mjs` `b232_announce_screen_test.mjs` `panel_frame_test.mjs` `tx14_announce_test.mjs` |
| `dwf-attribution.js` | `attribution_fixture_test.mjs` |
| `dwf-audio.js` | `audio_client_test.mjs` `audio_map_fixture_test.mjs` `panel_frame_test.mjs` `panel_migration_test.mjs` |
| `dwf-bitmap-text.js` | `bitmap_interface_scale_test.mjs` |
| `dwf-build-info-panels.js` | `b114_place_candidates_test.mjs` `b229_places_depth_test.mjs` `b236_itemsheet_native_test.mjs` `b243_b244_construct_materials_test.mjs` `b254_labor_detail_test.mjs` `b279_activity_task_test.mjs` `b291_farm_placement_test.mjs` `b296_residents_parity_test.mjs` `b79_construction_menu_test.mjs` `burials_client_test.mjs` `cim_tasks_test.mjs` `color_surface_parity_test.mjs` `diplo_petitions_test.mjs` `dwfui_boot_test.mjs` `husbandry_client_test.mjs` `panel_frame_test.mjs` `siderail_flow_test.mjs` `small_ui_wavec_test.mjs` `tab_grammar_test.mjs` `uiflow_test.mjs` `v1_stale_honesty_test.mjs` `v1_stock_item_flags_test.mjs` `v1_twoclient_stale_audit.mjs` `w3_itemsheet_test.mjs` |
| `dwf-building-zone-stockpile-panels.js` | `b151_parity_test.mjs` `b166_barracks_test.mjs` `b174_wsrebuild_client_test.mjs` `b180_b191_wirelabels_test.mjs` `b213_savetrigger_test.mjs` `b217_zoneparity2_test.mjs` `b229_places_depth_test.mjs` `b231_hauling_test.mjs` `b246_art_desc_test.mjs` `b251_archery_squads_test.mjs` `b257_b266_shop_oracles_test.mjs` `b276_location_temple_test.mjs` `b286_building_removal_test.mjs` `b288_b289_art_panel_test.mjs` `b55_farmplot_client_test.mjs` `building_cage_client_test.mjs` `burials_client_test.mjs` `color_surface_parity_test.mjs` `dwfui_boot_test.mjs` `lever_link_client_test.mjs` `panel_frame_test.mjs` `portrait_identity_test.mjs` `s5_location_tavern_test.mjs` `small_ui_wavec_test.mjs` `stockpile_flow_wave_test.mjs` `stockpile_repaint_session_test.mjs` `stockpile_snapshot_test.mjs` `stockpile_ui_wave_test.mjs` `uiflow_test.mjs` `uipolish2_test.mjs` `v1_stale_honesty_test.mjs` `v1_twoclient_stale_audit.mjs` `w3_itemsheet_test.mjs` `wp3a_workers_profile_test.mjs` `zone_assignability_test.mjs` `zone_delete_guard_test.mjs` `zone_repaint_session_test.mjs` |
| `dwf-burrow-overlay.js` | `b230_burrow_symbol_test.mjs` `b238_burrow_refresh_test.mjs` |
| `dwf-cache-worker.js` | `b133_desig_range_test.mjs` `b204_black_glyphs_test.mjs` `cache_test.mjs` `f3_rebuildkey_test.mjs` `groundart_tx6_species_test.mjs` `tx4_farm_crops_test.mjs` |
| `dwf-cache.js` | `b133_desig_range_test.mjs` `b204_black_glyphs_test.mjs` `b269_mining_indicators_test.mjs` `cache_test.mjs` `f3_rebuildkey_test.mjs` `gl_core_test.mjs` `tx4_farm_crops_test.mjs` |
| `dwf-chat.js` | `b211_wt27_clientview_test.mjs` `chat_client_test.mjs` `panel_frame_test.mjs` `panel_migration_test.mjs` `tilelist_fixture_test.mjs` `uiflow_test.mjs` `wt11_world3d_dom_test.mjs` `wt20_touch_test.mjs` |
| `dwf-chrome.js` | _none_ |
| `dwf-combatlog-panel.js` | `b73_combat_history_test.mjs` `color_surface_parity_test.mjs` `combatlog_fixture_test.mjs` `panel_frame_test.mjs` |
| `dwf-console-panel.js` | `console_panel_test.mjs` |
| `dwf-control-shell.js` | `b217_zoneparity2_test.mjs` `b230_burrow_symbol_test.mjs` `b231_hauling_test.mjs` `b233_stub_sweep_test.mjs` `zone_delete_guard_test.mjs` |
| `dwf-controls-placement.js` | `b106_stair_range_test.mjs` `b133_desig_range_test.mjs` `b230_burrow_symbol_test.mjs` `b231_hauling_test.mjs` `b233_stub_sweep_test.mjs` `b238_burrow_refresh_test.mjs` `b267_b268_slopes_test.mjs` `b288_b289_art_panel_test.mjs` `b291_farm_placement_test.mjs` `b52_b53_designation_pipeline_test.mjs` `b69_surface_recenter_test.mjs` `bz_erase_zrange_test.mjs` `chat_client_test.mjs` `color_surface_parity_test.mjs` `onboarding_wave_e_test.mjs` `panel_frame_test.mjs` `presence_drag_broadcast_test.mjs` `s5_location_tavern_test.mjs` `settings_keybinds_test.mjs` `small_ui_wavec_test.mjs` `stockpile_flow_wave_test.mjs` `stockpile_repaint_session_test.mjs` `tilelist_fixture_test.mjs` `uiflow_test.mjs` `uipolish2_test.mjs` `v1_twoclient_stale_audit.mjs` `v1_weather_toggle_test.mjs` `waveb_designation_test.mjs` `wt11_world3d_dom_test.mjs` `wt20_touch_test.mjs` `zone_delete_guard_test.mjs` `zone_repaint_session_test.mjs` `zone_repaint_shape_test.mjs` `zone_repaint_status_test.mjs` |
| `dwf-core.js` | `b106_stair_range_test.mjs` `b133_desig_range_test.mjs` `b198_zone_border_test.mjs` `b217_zoneparity2_test.mjs` `b246_art_desc_test.mjs` `b263_zoomflash_test.mjs` `b284_bolt_search_test.mjs` `b288_b289_art_panel_test.mjs` `bz_erase_zrange_test.mjs` `camera_identity_transport_test.mjs` `cim_kitchen_test.mjs` `dwfui_boot_test.mjs` `native_popup_test.mjs` `onboarding_wave_e_test.mjs` `panel_frame_test.mjs` `portrait_sweep_test.mjs` `siderail_paint_clip_test.mjs` `spectate_client_test.mjs` `squads_view_fixture_test.mjs` `stockpile_repaint_session_test.mjs` `stockpile_ui_wave_test.mjs` `uiflow_test.mjs` `w3_itemsheet_test.mjs` `waveb_designation_test.mjs` `wt11_world3d_dom_test.mjs` `wt20_touch_test.mjs` `zone_repaint_session_test.mjs` `zone_repaint_shape_test.mjs` |
| `dwf-df-markup.js` | `df_color_palette_test.mjs` `df_markup_test.mjs` |
| `dwf-digest.js` | `digest_client_test.mjs` |
| `dwf-diplo.js` | `color_surface_parity_test.mjs` `diplo_petitions_test.mjs` |
| `dwf-escmenu.js` | `b213_savetrigger_test.mjs` |
| `dwf-farm-crops.js` | `tx4_farm_crops_test.mjs` |
| `dwf-fort-admin.js` | `b227_justice_ui_test.mjs` `b283_office_req_test.mjs` `cim_justice_test.mjs` `cim_nobles_test.mjs` `color_surface_parity_test.mjs` `diplo_petitions_test.mjs` `hostwrites_fixture_test.mjs` `v1_twoclient_stale_audit.mjs` |
| `dwf-fort-panels.js` | `b227_justice_ui_test.mjs` `b283_office_req_test.mjs` `cim_justice_test.mjs` `cim_nobles_test.mjs` `hostwrites_fixture_test.mjs` `panel_frame_test.mjs` |
| `dwf-gl-atlas.js` | `gl_atlas_test.mjs` `gl_core_test.mjs` |
| `dwf-gl.js` | `b108_claimed_designation_blink_test.mjs` `b127_priority_wall_glyph_test.mjs` `b204_black_glyphs_test.mjs` `b211_wt27_clientview_test.mjs` `b235_worldseam_test.mjs` `b248_status_priority_test.mjs` `b253_statue_test.mjs` `b256_projectile_sprite_test.mjs` `b267_b268_slopes_test.mjs` `b269_mining_indicators_test.mjs` `b270_furniture_state_test.mjs` `b278_late_unit_sprite_test.mjs` `b27a_farmplot_test.mjs` `b35_djobs_test.mjs` `b36_wall_adjacency_test.mjs` `b38_desig_wall_lighten_test.mjs` `b47_construction_floor_test.mjs` `b54_claimed_wall_designation_test.mjs` `b62_trunk_walljoin_test.mjs` `b63_workshop_test.mjs` `b71_grasstint_test.mjs` `b74_b93_surfaces_test.mjs` `construction_remainder_test.mjs` `flows_miasma_test.mjs` `g1_pan_hysteresis_test.mjs` `g2_machine_segment_test.mjs` `gem_water_parity_test.mjs` `gl_core_test.mjs` `grass_under_pebbles_test.mjs` `groundart_fixture_support.mjs` `groundart_tx6_species_test.mjs` `hatch_cover_item_map_test.mjs` `marker_recolor_test.mjs` `pause_anim_test.mjs` `presence_drag_broadcast_test.mjs` `r2_chunk_patch_test.mjs` `renderer_wave_test.mjs` `sb_predicate_ref.mjs` `sb_renderers.mjs` `sb_transport_test.mjs` `t1_material_parity_test.mjs` `treegrass_ghost_tint_test.mjs` `tx10_tx11_table_leather_test.mjs` `tx13_meat_sprites_test.mjs` `tx17_planned_construction_test.mjs` `tx1_barrel_peek_test.mjs` `tx4_farm_crops_test.mjs` `v1_weather_toggle_test.mjs` `wallsfix_construction_test.mjs` `waveb_designation_test.mjs` `wb11_sparse_test.mjs` `wb12_buildings_test.mjs` `wb13_units_test.mjs` `wb14_overlay_test.mjs` `wb15_anim_test.mjs` `wc14_tree_test.mjs` `wc22_gl_proj_test.mjs` `wc6_wc8_machine_test.mjs` `wcclient_matrix_test.mjs` `window11_meatfish_test.mjs` `window12_corpse_test.mjs` `window13_component_tint_test.mjs` `wt29_mood_subtype_test.mjs` `wt30_status_full_test.mjs` |
| `dwf-help-corpus.js` | `help_reference_test.mjs` |
| `dwf-help-curated.js` | `help_reference_test.mjs` |
| `dwf-help-panel.js` | `dwfui_boot_test.mjs` `help_reference_test.mjs` |
| `dwf-hospital-panel.js` | `b229_places_depth_test.mjs` `b276_location_temple_test.mjs` `color_surface_parity_test.mjs` `hospital_fixture_test.mjs` `panel_frame_test.mjs` |
| `dwf-hostpanel.js` | `hostpanel_test.mjs` `zone_delete_guard_test.mjs` |
| `dwf-hotkeys.js` | `b245_minimap_chrome_test.mjs` `panel_frame_test.mjs` `settings_keybinds_test.mjs` `wt12_locations_hotkey_test.mjs` |
| `dwf-interface-shell.js` | `b245_minimap_chrome_test.mjs` |
| `dwf-join.js` | `join_auth_test.mjs` `join_version_test.mjs` `lobby_rename_test.mjs` `onboarding_wave_e_test.mjs` `v1_twoclient_stale_audit.mjs` |
| `dwf-keymap.js` | _none_ |
| `dwf-kitchen.js` | `cim_kitchen_test.mjs` `dwfui_boot_test.mjs` `wave4_cpp_wire_test.mjs` |
| `dwf-labor-work-orders.js` | `b284_bolt_search_test.mjs` `b285_workorder_condition_editor_test.mjs` `b285_workorder_conditions_read_test.mjs` `cim_chores_test.mjs` `cim_petitions_test.mjs` `cim_standingorders_test.mjs` `color_surface_parity_test.mjs` `panel_frame_test.mjs` `parity_wave1_work_orders_test.mjs` `uiflow_test.mjs` `v1_twoclient_stale_audit.mjs` `v1_workorder_cancel_test.mjs` |
| `dwf-lobby.js` | `followcam_player_engage_test.mjs` `lobby_rename_test.mjs` `panel_frame_test.mjs` `spectate_client_test.mjs` |
| `dwf-location-panel.js` | `b229_places_depth_test.mjs` `b276_location_temple_test.mjs` `color_surface_parity_test.mjs` `s5_location_tavern_test.mjs` |
| `dwf-menu-tree.js` | `truemenu_client_test.mjs` `uiflow_test.mjs` |
| `dwf-obligations.js` | `obligations_test.mjs` |
| `dwf-overlay-boxes.js` | _none_ |
| `dwf-panelframe.js` | `panel_frame_test.mjs` `panel_migration_test.mjs` `siderail_paint_clip_test.mjs` `v1_shell_single_pop_test.mjs` `w3_itemsheet_test.mjs` |
| `dwf-pause.js` | `b213_savetrigger_test.mjs` `pause_anim_test.mjs` |
| `dwf-popup.js` | `native_popup_test.mjs` |
| `dwf-render.js` | `b211_wt27_clientview_test.mjs` `f3_rebuildkey_test.mjs` `gl_core_test.mjs` `r2_rebuildkey_test.mjs` `wc4_building_test.mjs` `wt20_touch_test.mjs` |
| `dwf-settings.js` | `autosave_interval_aux_test.mjs` `settings_keybinds_test.mjs` `tab_grammar_test.mjs` `v1_weather_toggle_test.mjs` |
| `dwf-squads.js` | `b233_stub_sweep_test.mjs` `b252_schedule_columns_test.mjs` `b295_squad_flow_parity_test.mjs` `color_surface_parity_test.mjs` `dwfui_boot_test.mjs` `milequip_wire_test.mjs` `panel_frame_test.mjs` `portraits_test.mjs` `squads_view_fixture_test.mjs` `ui_drift_guard_test.mjs` `uiflow_test.mjs` `v1_twoclient_stale_audit.mjs` `wave4_squads_parity_test.mjs` |
| `dwf-texture-lab.js` | `texture_lab_test.mjs` |
| `dwf-tiles.js` | `b108_claimed_designation_blink_test.mjs` `b133_desig_range_test.mjs` `b204_black_glyphs_test.mjs` `b211_wt27_clientview_test.mjs` `b235_worldseam_test.mjs` `b248_status_priority_test.mjs` `b253_statue_test.mjs` `b256_projectile_sprite_test.mjs` `b263_zoomflash_test.mjs` `b267_b268_slopes_test.mjs` `b269_mining_indicators_test.mjs` `b270_furniture_state_test.mjs` `b27a_farmplot_test.mjs` `b35_djobs_test.mjs` `b36_wall_adjacency_test.mjs` `b47_construction_floor_test.mjs` `b54_claimed_wall_designation_test.mjs` `b62_trunk_walljoin_test.mjs` `b63_workshop_test.mjs` `b74_b93_surfaces_test.mjs` `cache_test.mjs` `camera_identity_transport_test.mjs` `construction_remainder_test.mjs` `dropstale_test.mjs` `flows_miasma_test.mjs` `fog_canvas_test.mjs` `gem_water_parity_test.mjs` `gl_core_test.mjs` `grass_under_pebbles_test.mjs` `groundart_fixture_support.mjs` `hatch_cover_item_map_test.mjs` `join_auth_test.mjs` `marker_recolor_test.mjs` `pause_anim_test.mjs` `presence_drag_broadcast_test.mjs` `renderer_wave_test.mjs` `s3_s4_s5_staging_test.mjs` `sb_renderers.mjs` `t1_material_parity_test.mjs` `treegrass_ghost_tint_test.mjs` `tx10_tx11_table_leather_test.mjs` `tx13_meat_sprites_test.mjs` `tx17_planned_construction_test.mjs` `tx1_barrel_peek_test.mjs` `tx4_farm_crops_test.mjs` `v1_weather_toggle_test.mjs` `wallsfix_construction_test.mjs` `wave4_cpp_wire_test.mjs` `waveb_designation_test.mjs` `wb11_sparse_test.mjs` `wb12_buildings_test.mjs` `wb13_units_test.mjs` `wb14_overlay_test.mjs` `wc14_tree_test.mjs` `wc17_wc18_test.mjs` `wc4_building_test.mjs` `wc6_wc8_machine_test.mjs` `wcclient_matrix_test.mjs` `window11_meatfish_test.mjs` `window12_corpse_test.mjs` `window13_component_tint_test.mjs` `wt11_voxelizer_test.mjs` `wt20_touch_test.mjs` `wt29_mood_subtype_test.mjs` `wt30_status_full_test.mjs` |
| `dwf-tooltip.js` | `color_surface_parity_test.mjs` |
| `dwf-touch.js` | `wt20_touch_test.mjs` |
| `dwf-tradedepot-panel.js` | `hostwrites_fixture_test.mjs` `panel_frame_test.mjs` `tradedepot_fixture_test.mjs` |
| `dwf-tradescreen.js` | `hostwrites_fixture_test.mjs` |
| `dwf-ui-components.js` | `announcement_parity_test.mjs` `audio_client_test.mjs` `b151_parity_test.mjs` `b166_barracks_test.mjs` `b174_wsrebuild_client_test.mjs` `b217_zoneparity2_test.mjs` `b227_justice_ui_test.mjs` `b228_missions_test.mjs` `b229_places_depth_test.mjs` `b230_burrow_symbol_test.mjs` `b231_hauling_test.mjs` `b232_announce_screen_test.mjs` `b233_stub_sweep_test.mjs` `b236_itemsheet_native_test.mjs` `b245_minimap_chrome_test.mjs` `b246_art_desc_test.mjs` `b252_schedule_columns_test.mjs` `b254_labor_detail_test.mjs` `b276_location_temple_test.mjs` `b279_activity_task_test.mjs` `b283_office_req_test.mjs` `b285_workorder_condition_editor_test.mjs` `b285_workorder_conditions_read_test.mjs` `b286_building_removal_test.mjs` `b288_b289_art_panel_test.mjs` `b295_squad_flow_parity_test.mjs` `b296_residents_parity_test.mjs` `b55_farmplot_client_test.mjs` `b73_combat_history_test.mjs` `b88_worldmap_test.mjs` `charprofile_p2_test.mjs` `charprofile_structured_test.mjs` `charprofile_wording_test.mjs` `chat_client_test.mjs` `cim_chores_test.mjs` `cim_justice_test.mjs` `cim_kitchen_test.mjs` `cim_nobles_test.mjs` `cim_petitions_test.mjs` `cim_standingorders_test.mjs` `color_surface_parity_test.mjs` `console_panel_test.mjs` `df_color_palette_test.mjs` `digest_client_test.mjs` `diplo_petitions_test.mjs` `dwfui_boot_test.mjs` `hospital_fixture_test.mjs` `hostpanel_test.mjs` `hostwrites_fixture_test.mjs` `join_auth_test.mjs` `native_popup_test.mjs` `obligations_test.mjs` `parity_wave1_work_orders_test.mjs` `portrait_identity_test.mjs` `portraits_test.mjs` `s5_location_tavern_test.mjs` `siderail_flow_test.mjs` `siderail_paint_clip_test.mjs` `squads_view_fixture_test.mjs` `status_truth_test.mjs` `stockpile_flow_wave_test.mjs` `stockpile_ui_wave_test.mjs` `tab_grammar_test.mjs` `tilelist_fixture_test.mjs` `tradedepot_fixture_test.mjs` `tx14_announce_test.mjs` `ui_drift_guard_test.mjs` `v1_stock_item_flags_test.mjs` `v1_workorder_cancel_test.mjs` `vote_fixture_test.mjs` `w3_itemsheet_test.mjs` `wave4_squads_parity_test.mjs` `wt11_world3d_dom_test.mjs` |
| `dwf-unit-hud-notifications.js` | `announcement_parity_test.mjs` `b232_announce_screen_test.mjs` `b233_stub_sweep_test.mjs` `b279_activity_task_test.mjs` `b73_combat_history_test.mjs` `charprofile_p2_test.mjs` `charprofile_portraits_test.mjs` `charprofile_structured_test.mjs` `charprofile_wording_test.mjs` `color_surface_parity_test.mjs` `combatlog_fixture_test.mjs` `df_color_palette_test.mjs` `followcam_unit_persist_test.mjs` `notification_wave_test.mjs` `panel_frame_test.mjs` `pause_anim_test.mjs` `portrait_identity_test.mjs` `portraits_test.mjs` `siderail_paint_clip_test.mjs` `small_ui_wavec_test.mjs` `status_truth_test.mjs` `tab_grammar_test.mjs` `tx14_announce_test.mjs` `uiflow_test.mjs` `uipolish2_test.mjs` `unitsheet_live_test.mjs` `v1_twoclient_stale_audit.mjs` `w3_itemsheet_test.mjs` |
| `dwf-unitcycle.js` | `b288_b289_art_panel_test.mjs` `exact_tile_first_fixture_test.mjs` `ghost_clickable_fixture_test.mjs` `panel_frame_test.mjs` `siderail_flow_test.mjs` `siderail_paint_clip_test.mjs` `small_ui_wavec_test.mjs` `tilelist_fixture_test.mjs` `w3_itemsheet_test.mjs` |
| `dwf-vote.js` | `panel_frame_test.mjs` `vote_fixture_test.mjs` |
| `dwf-voxel-mesh.js` | `wt11_voxel_mesh_test.mjs` `wt11_world3d_dom_test.mjs` |
| `dwf-voxelizer.js` | `wt11_voxelizer_test.mjs` `wt11_world3d_dom_test.mjs` |
| `dwf-weather.js` | `v1_weather_toggle_test.mjs` `wc20_weather_test.mjs` |
| `dwf-wire-v1.js` | `b204_black_glyphs_test.mjs` `cache_test.mjs` `flows_miasma_test.mjs` `gen_wire_fixture.mjs` `groundart_tx6_species_test.mjs` `tx1_barrel_peek_test.mjs` `tx4_farm_crops_test.mjs` `wc17_wc18_test.mjs` `wire_decode_test.mjs` |
| `dwf-world3d-model.js` | `wt11_camera_test.mjs` `wt11_world3d_dom_test.mjs` |
| `dwf-world3d.js` | `wt11_world3d_dom_test.mjs` |
| `dwf-worldmap.js` | `b228_missions_test.mjs` `b88_worldmap_test.mjs` |
| `dwf-write-guards.js` | `b295_squad_flow_parity_test.mjs` `v1_safety_gate_test.mjs` `zone_delete_guard_test.mjs` |
| `dwf-ws.js` | `autosave_interval_aux_test.mjs` `b238_burrow_refresh_test.mjs` `b263_zoomflash_test.mjs` `diplo_petitions_test.mjs` `dropstale_test.mjs` `native_popup_test.mjs` `v1_twoclient_stale_audit.mjs` `vote_fixture_test.mjs` `wa5_conditional_test.mjs` |

### Plugin — src/

| file | tests to run |
| --- | --- |
| `announcements.cpp` | `b232_announce_screen_test.mjs` `notification_wave_test.mjs` `tx14_announce_test.mjs` |
| `art_desc.cpp` | `b246_art_desc_test.mjs` `b253_statue_test.mjs` `b288_b289_art_panel_test.mjs` |
| `attribution.cpp` | `analytics_fixture_test.mjs` |
| `auth.cpp` | `v1_twoclient_stale_audit.mjs` |
| `bake_sweep.cpp` | `bake_sweep_test.mjs` |
| `building_zone.cpp` | `b166_barracks_test.mjs` `b213_savetrigger_test.mjs` `b221_workshopstall_cache_test.mjs` `b229_places_depth_test.mjs` `b246_art_desc_test.mjs` `b251_archery_squads_test.mjs` `b276_location_temple_test.mjs` `b55_farmplot_client_test.mjs` `build_place_invariant_test.mjs` `husbandry_client_test.mjs` `s5_location_tavern_test.mjs` `small_ui_wavec_test.mjs` `ui_cache_purge_guard_test.mjs` `uiflow_test.mjs` `uipolish2_test.mjs` `v1_safety_gate_test.mjs` `zone_assignability_test.mjs` `zone_delete_guard_test.mjs` `zone_repaint_safety_test.mjs` `zone_repaint_status_test.mjs` |
| `burrows_panel.cpp` | `b230_burrow_symbol_test.mjs` `b238_burrow_refresh_test.mjs` `color_surface_parity_test.mjs` |
| `chat.cpp` | _none_ |
| `client_state.cpp` | `b69_surface_recenter_test.mjs` `first_join_camera_fixture_test.mjs` `lobby_rename_test.mjs` `presence_drag_broadcast_test.mjs` |
| `console_routes.cpp` | `console_panel_test.mjs` `console_route_gate_test.mjs` `v1_safety_gate_test.mjs` |
| `curses_palette.cpp` | `b230_burrow_symbol_test.mjs` |
| `diagnostics.cpp` | `wt24_crashdiag_test.mjs` |
| `diplo.cpp` | `diplo_petitions_test.mjs` |
| `dwf.cpp` | `portrait_sweep_test.mjs` `wt24_crashdiag_test.mjs` |
| `flight_recorder.cpp` | `flight_recorder_contract_test.mjs` |
| `flight_recorder_v3.cpp` | `flight_recorder_contract_test.mjs` |
| `fort_admin.cpp` | `b180_b191_wirelabels_test.mjs` `b233_stub_sweep_test.mjs` `b283_office_req_test.mjs` `b290_child_assignment_guards_test.mjs` `b293_noble_squad_availability_test.mjs` `diplo_petitions_test.mjs` `hostwrites_fixture_test.mjs` `rostertruth_classification_test.mjs` `v1_safety_gate_test.mjs` `v1_squad_asneeded_gates_test.mjs` |
| `hauling.cpp` | `b231_hauling_test.mjs` `v1_safety_gate_test.mjs` `zone_delete_guard_test.mjs` |
| `hospital.cpp` | `b292_job_activity_coverage_test.mjs` |
| `http_server.cpp` | `b238_burrow_refresh_test.mjs` `b256_projectile_sprite_test.mjs` `b269_mining_indicators_test.mjs` `b69_surface_recenter_test.mjs` `camera_identity_transport_test.mjs` `console_route_gate_test.mjs` `diplo_petitions_test.mjs` `flight_recorder_contract_test.mjs` `glyph_font_test.mjs` `lifecycle_guard_test.mjs` `native_popup_test.mjs` `presence_drag_broadcast_test.mjs` `sprites_img_cache_test.mjs` `uipolish2_test.mjs` `v1_safety_gate_test.mjs` `v1_twoclient_stale_audit.mjs` `vote_fixture_test.mjs` `wc14_tree_test.mjs` `wt24_crashdiag_test.mjs` |
| `hud.cpp` | `b69_surface_recenter_test.mjs` `rostertruth_classification_test.mjs` `unitlist_classification_test.mjs` |
| `image_encoder.cpp` | _none_ |
| `info_panel.cpp` | `b229_places_depth_test.mjs` `b233_stub_sweep_test.mjs` `b254_labor_detail_test.mjs` `b279_activity_task_test.mjs` `b292_job_activity_coverage_test.mjs` `b296_residents_parity_test.mjs` `charprofile_p2_test.mjs` `color_surface_parity_test.mjs` `rostertruth_classification_test.mjs` `small_ui_wavec_test.mjs` `unitlist_classification_test.mjs` `w3_itemsheet_test.mjs` |
| `interaction.cpp` | `b123_growth_item_name_test.mjs` `b170_flow_hover_test.mjs` `b213_savetrigger_test.mjs` `b236_itemsheet_native_test.mjs` `b246_art_desc_test.mjs` `b267_b268_slopes_test.mjs` `b288_b289_art_panel_test.mjs` `exact_tile_first_fixture_test.mjs` `ghost_clickable_fixture_test.mjs` `siderail_flow_test.mjs` `small_ui_wavec_test.mjs` `w3_itemsheet_test.mjs` |
| `json_util.cpp` | `camera_identity_transport_test.mjs` |
| `kitchen_panel.cpp` | `cim_kitchen_test.mjs` `small_ui_wavec_test.mjs` `wave4_cpp_wire_test.mjs` |
| `labor.cpp` | `b254_labor_detail_test.mjs` `unitlist_classification_test.mjs` |
| `lever_link.cpp` | _none_ |
| `lua_bridge.cpp` | `b114_place_candidates_test.mjs` `b229_places_depth_test.mjs` `b276_location_temple_test.mjs` `b285_workorder_condition_editor_test.mjs` `build_place_invariant_test.mjs` `console_route_gate_test.mjs` `stockpile_repaint_session_test.mjs` `stockpile_snapshot_test.mjs` |
| `menu_oracle.cpp` | _none_ |
| `missions.cpp` | `b228_missions_test.mjs` `diplo_petitions_test.mjs` |
| `music_sync.cpp` | _none_ |
| `native_popup.cpp` | `b246_art_desc_test.mjs` `native_popup_test.mjs` |
| `notifications.cpp` | `notification_wave_test.mjs` `tx14_announce_test.mjs` |
| `oracle_routes.cpp` | _none_ |
| `overlay_control.cpp` | _none_ |
| `pause_arbiter.cpp` | `diplo_petitions_test.mjs` `native_popup_test.mjs` |
| `placement.cpp` | `b106_stair_range_test.mjs` `b109_remove_slope_test.mjs` `b114_place_candidates_test.mjs` `b126_gather_shrub_rect_test.mjs` `b133_desig_range_test.mjs` `b233_stub_sweep_test.mjs` `b267_b268_slopes_test.mjs` `b52_b53_designation_pipeline_test.mjs` `bz_erase_zrange_test.mjs` `presence_drag_broadcast_test.mjs` `waveb_designation_test.mjs` |
| `portrait_sweep.cpp` | `portrait_sweep_test.mjs` |
| `sdl_capture.cpp` | `bake_sweep_test.mjs` |
| `session_routes.cpp` | `b213_savetrigger_test.mjs` `camera_identity_transport_test.mjs` `console_route_gate_test.mjs` `join_version_test.mjs` `v1_twoclient_stale_audit.mjs` `view_stamp_test.mjs` |
| `sound_route.cpp` | _none_ |
| `sprite_map.cpp` | `b241_groundrender_test.mjs` |
| `squads.cpp` | `b233_stub_sweep_test.mjs` `b252_schedule_columns_test.mjs` `b290_child_assignment_guards_test.mjs` `b293_noble_squad_availability_test.mjs` `b295_squad_flow_parity_test.mjs` `milequip_wire_test.mjs` `rostertruth_classification_test.mjs` `squads_view_fixture_test.mjs` `v1_safety_gate_test.mjs` `v1_squad_asneeded_gates_test.mjs` `wave4_squads_parity_test.mjs` `zone_delete_guard_test.mjs` |
| `standing_orders.cpp` | `cim_standingorders_test.mjs` |
| `status_harvest.cpp` | `status_harvest_test.mjs` |
| `status_truth.cpp` | `status_truth_test.mjs` |
| `stockpile_panel.cpp` | `stockpile_flow_wave_test.mjs` `stockpile_repaint_session_test.mjs` `stockpile_snapshot_test.mjs` `ui_cache_purge_guard_test.mjs` |
| `stone_use.cpp` | _none_ |
| `tile_dump.cpp` | _none_ |
| `tile_map_dump.cpp` | `b222_status_serializer_parity_test.mjs` `b278_late_unit_sprite_test.mjs` `b90_plant_identity_test.mjs` `sb_transport_test.mjs` `unit_visibility_filter_test.mjs` `unitlist_classification_test.mjs` `wt30_status_full_test.mjs` |
| `trade_depot.cpp` | `hostwrites_fixture_test.mjs` `small_ui_wavec_test.mjs` `tradedepot_fixture_test.mjs` |
| `ui_cache_purge.cpp` | `ui_cache_purge_guard_test.mjs` `v1_safety_gate_test.mjs` `zone_delete_guard_test.mjs` |
| `unit_activity.cpp` | `b292_job_activity_coverage_test.mjs` |
| `unit_portrait.cpp` | `b246_art_desc_test.mjs` `portrait_sweep_test.mjs` |
| `unit_sheet.cpp` | `b123_growth_item_name_test.mjs` `b233_stub_sweep_test.mjs` `b279_activity_task_test.mjs` `b292_job_activity_coverage_test.mjs` `charprofile_p2_test.mjs` `charprofile_portraits_test.mjs` `charprofile_structured_test.mjs` `charprofile_wording_test.mjs` `small_ui_wavec_test.mjs` |
| `unit_sprites.cpp` | _none_ |
| `vote.cpp` | `vote_fixture_test.mjs` |
| `web_assets.cpp` | _none_ |
| `websocket.cpp` | `camera_identity_transport_test.mjs` `chat_client_test.mjs` `lifecycle_guard_test.mjs` `lobby_rename_test.mjs` `s3_s4_s5_staging_test.mjs` `ws_upgrade_header_capacity_test.mjs` `wt24_crashdiag_test.mjs` |
| `wire_v1.cpp` | `b204_black_glyphs_test.mjs` `b269_mining_indicators_test.mjs` `b47_construction_floor_test.mjs` `b90_plant_identity_test.mjs` `cache_test.mjs` `flows_miasma_test.mjs` `gen_wire_fixture.mjs` `grass_under_pebbles_test.mjs` `groundart_b37_test.mjs` `groundart_tx6_species_test.mjs` `treegrass_ghost_tint_test.mjs` `tx4_farm_crops_test.mjs` `wb11_sparse_test.mjs` `window11_meatfish_test.mjs` `window12_corpse_test.mjs` `wire_decode_test.mjs` |
| `work_orders.cpp` | `b285_workorder_condition_editor_test.mjs` |
| `world_stream.cpp` | `autosave_interval_aux_test.mjs` `b108_claimed_designation_blink_test.mjs` `b122_b124_gather_job_validation_test.mjs` `b204_black_glyphs_test.mjs` `b222_status_serializer_parity_test.mjs` `b253_statue_test.mjs` `b256_projectile_sprite_test.mjs` `b263_zoomflash_test.mjs` `b273_material_tint_test.mjs` `b278_late_unit_sprite_test.mjs` `b35_djobs_test.mjs` `b54_claimed_wall_designation_test.mjs` `b63_workshop_test.mjs` `flows_miasma_test.mjs` `lifecycle_guard_test.mjs` `portrait_sweep_test.mjs` `s1_s2_scheduler_test.mjs` `s3_s4_s5_staging_test.mjs` `sb_transport_test.mjs` `tx17_planned_construction_test.mjs` `tx4_farm_crops_test.mjs` `unit_visibility_filter_test.mjs` `unitlist_classification_test.mjs` `waveb_designation_test.mjs` `wcclient_matrix_test.mjs` `wt02_wt05_roster_oracle.mjs` `wt29_mood_subtype_test.mjs` `wt30_status_full_test.mjs` |
| `worldmap_panel.cpp` | `b88_worldmap_test.mjs` |
| `write_guards.cpp` | `b295_squad_flow_parity_test.mjs` `v1_safety_gate_test.mjs` `zone_delete_guard_test.mjs` |

