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

#pragma once

#include "camera.h"
#include "httplib.h"

#include <cstdint>
#include <string>
#include <vector>

namespace dwf {

// One entry from world->status.reports -- the full event log, distinct from
// world->status.announcements, which holds only what scrolled through the top-of-screen banner.
struct ReportEntry {
    int32_t id = -1;
    int type = -1;
    int alert_type = 0;
    std::string type_key;
    std::string text;
    int color = 7;
    bool bright = false;
    int32_t duration = 0;
    int32_t repeat_count = 0;
    bool continuation = false;
    bool announcement = false;
    int32_t year = 0;
    int32_t time = 0;
    int zoom_type = -1;
    bool has_pos = false;
    Camera pos;
    int zoom_type2 = -1;
    bool has_pos2 = false;
    Camera pos2;
    int32_t activity_id = -1;
    int32_t activity_event_id = -1;
    int32_t speaker_id = -1;
    int section = 0;            // taxonomy::SECTION_MISC
    int taxonomy_flags = 0;     // taxonomy::AnnounceFlag bitfield
};

struct ReportsQuery {
    int32_t since_id = -1;    // > this id. -1 = no lower bound.
    int32_t before_id = -1;   // < this id. -1 = no upper bound (start at the newest).
    int category = -1;        // -1 = no filter; else an announcement_alert_type value (0..36)
    int section = -1;         // -1 = no filter; else a taxonomy::Section id (0..6)
    int max_reports = 200;    // cap on matching LEAD entries (continuation tails are free)
    int scan_budget = 20000;  // cap on entries EXAMINED, so one request cannot stall the render
                              // thread on a huge log; exhausting it is not an error
    bool want_counts = false; // one extra O(N) classification pass
};

struct ReportsPage {
    int32_t next_report_id = 0;  // pass back as `since` to follow the tail, regardless of filter
    int32_t next_before_id = -1; // resume cursor: the oldest id EXAMINED, not the oldest MATCHED,
                                 // so a filter that matched nothing still advances
    ReportsQuery query;
    bool truncated = false;         // hit max_reports -- there are more matches in this direction
    bool budget_exhausted = false;  // hit scan_budget -- resume from next_before_id
    bool reached_oldest = false;    // walked off the front of the vector; there is no older page
    int32_t scanned = 0;            // entries examined (perf/observability; surfaced on the wire)
    int32_t total_reports = 0;      // world.status.reports.size()
    bool has_counts = false;
    int32_t section_counts[8] = {0, 0, 0, 0, 0, 0, 0, 0}; // by taxonomy::Section id
    std::vector<ReportEntry> reports; // oldest -> newest
};

bool reports_on_render_thread(const ReportsQuery& query, ReportsPage& page,
                              std::string* err = nullptr);
std::string reports_json(const std::string& player, const ReportsPage& page);

// section key or numeric id; -1 (no filter) when absent, "all", or unrecognised
int resolve_section_param(const httplib::Request& req);

// numeric announcement_alert_type or its enum key name (case-insensitive); -1 = no filter
int resolve_category_param(const httplib::Request& req);

// --- Per-unit combat log -- `unit.reports.log[type]` holds LEAD report ids only ----------------
// Continuation lines are the next consecutive ids; the collector attaches them to their lead.
struct UnitReportEntry {
    ReportEntry report;
    int log_type = -1;      // unit_report_type value (0 Combat / 1 Sparring / 2 Hunting)
    std::string log_key;    // "Combat" / "Sparring" / "Hunting"
};

struct UnitReportsPage {
    int32_t unit_id = -1;
    bool unit_found = false;
    int log_filter = -1;        // -1 = all logs; else a unit_report_type value
    int32_t since_id = -1;      // only leads with id > since_id are returned
    int32_t next_report_id = 0; // world.status.next_report_id, the follow cursor
    bool truncated = false;
    std::vector<UnitReportEntry> entries; // oldest -> newest by report id
};

// log query param: numeric unit_report_type OR name ("combat"/"sparring"/"hunting"); -1 = all.
int resolve_unit_log_param(const httplib::Request& req);
bool unit_reports_on_render_thread(int32_t unit_id, int log_filter, int32_t since_id,
                                   int max_reports, UnitReportsPage& page, std::string* err = nullptr);
std::string unit_reports_json(const std::string& player, const UnitReportsPage& page);

void register_reports_routes(httplib::Server& server);

} // namespace dwf
