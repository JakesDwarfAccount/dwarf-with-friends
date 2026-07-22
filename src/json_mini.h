// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <array>
#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace dwf::json_mini {

constexpr size_t kMaxInputBytes = 4096;
constexpr int kMaxDepth = 4;

enum class Type { Null, Boolean, Number, String, Array, Object };
enum class Get { Ok, Absent, Malformed };

struct Value {
    Type type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string string;
    std::vector<Value> array;
    std::map<std::string, Value> object;
};

struct Doc {
    bool ok = false;
    std::string error;
    Value root;
};

Doc parse(std::string_view input);
Get number(const Value& object, const char* key, double& out);
Get string(const Value& object, const char* key, std::string& out);
Get object(const Value& object, const char* key, const Value*& out);
Get int_triples(const Value& object, const char* key,
                std::vector<std::array<int, 3>>& out, size_t max_count);
bool selftest();

} // namespace dwf::json_mini
