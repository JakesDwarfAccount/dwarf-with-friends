// One server-authoritative interpretation of direct, LAN, and locally terminated tunnel traffic.
// SPDX-License-Identifier: AGPL-3.0-only
#pragma once

#include "httplib.h"

#include <string>

namespace dwf {

enum class RequestOrigin {
    LocalHost,
    SupportedTunnel,
    RemotePlayer,
    UntrustedProxyMetadata,
};

bool origin_host_header_is_local(const std::string& host);
RequestOrigin classify_request_origin(bool peer_is_loopback, bool has_forwarded_header,
                                      const std::string& host_header);
RequestOrigin request_origin(const httplib::Request& req);
bool request_has_host_authority(const httplib::Request& req);
bool origin_has_host_authority(RequestOrigin origin);
const char* request_origin_name(RequestOrigin origin);

} // namespace dwf
