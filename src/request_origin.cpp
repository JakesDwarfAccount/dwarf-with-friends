// SPDX-License-Identifier: AGPL-3.0-only
#include "request_origin.h"

#include "websocket.h"

namespace dwf {

bool origin_host_header_is_local(const std::string& host) {
    std::string value = host;
    if (!value.empty() && value.front() == '[') {
        const size_t close = value.find(']');
        value = close == std::string::npos ? value : value.substr(1, close - 1);
    } else {
        const size_t colon = value.find(':');
        if (colon != std::string::npos) value.resize(colon);
    }
    for (char& ch : value)
        if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
    if (value == "localhost" || value == "::1") return true;
    if (value.rfind("127.", 0) != 0) return false;
    for (char ch : value)
        if (!((ch >= '0' && ch <= '9') || ch == '.')) return false;
    return true;
}

RequestOrigin classify_request_origin(bool peer_is_loopback, bool forwarded,
                                      const std::string& host) {
    const bool local_host = origin_host_header_is_local(host);
    if (peer_is_loopback && !forwarded && local_host) return RequestOrigin::LocalHost;
    if (peer_is_loopback && forwarded && !local_host) return RequestOrigin::SupportedTunnel;
    if (!peer_is_loopback && !forwarded && !local_host) return RequestOrigin::RemotePlayer;
    return RequestOrigin::UntrustedProxyMetadata;
}

RequestOrigin request_origin(const httplib::Request& req) {
    const bool forwarded = req.has_header("X-Forwarded-For") ||
        req.has_header("CF-Connecting-IP") || req.has_header("Forwarded") ||
        req.has_header("X-Real-IP");
    return classify_request_origin(peer_ip_is_loopback(req.remote_addr), forwarded,
                                   req.get_header_value("Host"));
}

bool origin_has_host_authority(RequestOrigin origin) {
    return origin == RequestOrigin::LocalHost;
}

bool request_has_host_authority(const httplib::Request& req) {
    return origin_has_host_authority(request_origin(req));
}

const char* request_origin_name(RequestOrigin origin) {
    switch (origin) {
    case RequestOrigin::LocalHost: return "local-host";
    case RequestOrigin::SupportedTunnel: return "supported-tunnel";
    case RequestOrigin::RemotePlayer: return "remote-player";
    default: return "untrusted-proxy-metadata";
    }
}

} // namespace dwf
