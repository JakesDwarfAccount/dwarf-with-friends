# dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
# Copyright (C) 2026 Gabriel Rios
# Copyright (C) 2026 Jake Taplin
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, version 3 of the License.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# Runs on DFHack (Zlib); descends from DFPlex (Zlib) and webfort (ISC).
# Full license: see LICENSE. Third-party credits: see NOTICE.
#
# SPDX-License-Identifier: AGPL-3.0-only

project(dwf)

# Version-mismatch gate: bake the git short hash into the build so /version + hello_ack advertise
# a deploy identity the client compares against its own baked stamp. Prefer an explicit override
# (-DDFCAPTURE_BUILD_STAMP=... passed by the deploy script -- REQUIRED for the git-archive mirror
# build, which has no .git), else derive from the working tree, else "dev".
if(DEFINED DFCAPTURE_BUILD_STAMP)
    set(DFCAP_GIT "${DFCAPTURE_BUILD_STAMP}")
else()
    execute_process(
        COMMAND git rev-parse --short=9 HEAD
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        OUTPUT_VARIABLE DFCAP_GIT
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET)
    if(NOT DFCAP_GIT)
        set(DFCAP_GIT "dev")
    endif()
endif()

# Windows links GDI+ (image encode) + COM + winsock; Linux needs only libdl for
# runtime SDL symbol resolution (stb_image_write replaces GDI+, sockets are libc).
if(WIN32)
    set(DWF_PLATFORM_LIBS gdiplus ole32 ws2_32)
else()
    set(DWF_PLATFORM_LIBS ${CMAKE_DL_LIBS})
endif()

dfhack_plugin(dfcapture_public
    src/announcements.cpp
    src/art_desc.cpp
    src/attribution.cpp
    src/auth.cpp
    src/bake_sweep.cpp
    src/building_zone.cpp
    src/burrows_panel.cpp
    src/chat.cpp
    src/client_state.cpp
    src/console_routes.cpp
    src/curses_palette.cpp
    src/dwf.cpp
    src/diagnostics.cpp
    src/diplo.cpp
    src/flight_recorder.cpp
    src/flight_recorder_v3.cpp
    src/fort_admin.cpp
    src/hauling.cpp
    src/hospital.cpp
    src/hud.cpp
    src/http_server.cpp
    src/info_panel.cpp
    src/interaction.cpp
    src/image_encoder.cpp
    src/json_util.cpp
    src/json_mini.cpp
    src/kitchen_panel.cpp
    src/labor.cpp
    src/lever_link.cpp
    src/lua_bridge.cpp
    src/menu_oracle.cpp
    src/native_popup.cpp
    src/notifications.cpp
    src/oracle_routes.cpp
    src/overlay_control.cpp
    src/music_sync.cpp
    src/pause_arbiter.cpp
    src/placement.cpp
    src/portrait_sweep.cpp
    src/request_origin.cpp
    src/save_barrier.cpp
    src/sdl_capture.cpp
    src/session_routes.cpp
    src/sound_route.cpp
    src/missions.cpp
    src/sprite_map.cpp
    src/squads.cpp
    src/standing_orders.cpp
    src/status_truth.cpp
    src/status_harvest.cpp
    src/stockpile_panel.cpp
    src/stone_use.cpp
    src/worldmap_panel.cpp
    src/tile_dump.cpp
    src/tile_map_dump.cpp
    src/trade_depot.cpp
    src/ui_cache_purge.cpp
    src/unit_activity.cpp
    src/unit_portrait.cpp
    src/unit_sheet.cpp
    src/unit_sprites.cpp
    src/vote.cpp
    src/web_assets.cpp
    src/websocket.cpp
    src/wire_v1.cpp
    src/work_orders.cpp
    src/write_guards.cpp
    src/world_stream.cpp
    LINK_LIBRARIES ${DWF_PLATFORM_LIBS} lua ZLIB::ZLIB)

target_include_directories(dfcapture_public PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cpp-httplib"
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb"
    ${SDL2_INCLUDE_DIRS})

target_compile_definitions(dfcapture_public PRIVATE
    DFCAPTURE_GIT_HASH="${DFCAP_GIT}")

set_target_properties(dfcapture_public PROPERTIES OUTPUT_NAME dwf)

if(INSTALL_DATA_FILES)
    install(FILES dwf.lua
        DESTINATION ${DFHACK_LUA_DESTINATION}/plugins)
    install(FILES scripts/gui/dwf.lua
        DESTINATION ${DFHACK_DATA_DESTINATION}/scripts/gui)
endif()
