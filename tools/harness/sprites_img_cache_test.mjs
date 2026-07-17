// SPDX-License-Identifier: AGPL-3.0-only
//
// This file is part of dwf.
//
// dwf is free software: you can redistribute it and/or modify it under the terms of the
// GNU Affero General Public License as published by the Free Software Foundation, version 3.
//
// dwf is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
// even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along with dwf.
// If not, see <https://www.gnu.org/licenses/>.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../../src/http_server.cpp"), "utf8");
const start = source.indexOf('server.Get(R"(/sprites/img/(.+))"');
// B212: the routes that used to follow /sprites/img moved to their domain modules; the
// next registration remaining in this file is the POST catch-all.
const end = source.indexOf('server.Post(".*"', start);
assert.ok(start >= 0 && end > start, "could not isolate /sprites/img route");
const route = source.slice(start, end);

function assertRevalidates(text) {
  assert.match(text, /std::string etag = content_etag\(bytes\);/,
               "sheet response must use a content-derived ETag");
  assert.match(text, /res\.set_header\("Cache-Control", "no-cache"\);/,
               "sheet response must revalidate rather than remain fresh for a day");
  assert.match(text, /res\.set_header\("ETag", etag\);/,
               "sheet response must emit its validator");
  assert.match(text, /req\.get_header_value\("If-None-Match"\) == etag/,
               "sheet response must evaluate a conditional request");
  assert.match(text, /res\.status = 304;/,
               "matching validators must receive 304");
  assert.doesNotMatch(text, /public, max-age=86400/,
                      "sheet route must not leave vanilla PNGs fresh for 24 hours");
}

assertRevalidates(route);

// TEST-THE-TEST: restore the exact stale-cache policy and prove this contract rejects it.
assert.throws(
  () => assertRevalidates(route.replace('res.set_header("Cache-Control", "no-cache");',
                                        'res.set_header("Cache-Control", "public, max-age=86400");')),
  /revalidate|fresh|24 hours/,
  "the test must reject the historical 24-hour cache policy"
);

console.log("sprites_img_cache_test: PASS (route revalidates by ETag; stale policy rejected)");
