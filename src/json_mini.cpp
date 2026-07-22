// dwf - multiplayer Dwarf Fortress in the browser, as a DFHack plugin
// Copyright (C) 2026 Gabriel Rios
// Copyright (C) 2026 Jake Taplin
// SPDX-License-Identifier: AGPL-3.0-only

#include "json_mini.h"

#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace dwf::json_mini {
namespace {

class Parser {
public:
    explicit Parser(std::string_view input) : input_(input) {}

    Doc run() {
        Doc doc;
        if (input_.size() > kMaxInputBytes) return fail_doc("input exceeds 4096 bytes");
        skip_ws();
        if (!value(doc.root, 0)) return fail_doc(error_);
        skip_ws();
        if (pos_ != input_.size()) return fail_doc("trailing data");
        doc.ok = true;
        return doc;
    }

private:
    std::string_view input_;
    size_t pos_ = 0;
    std::string error_;

    Doc fail_doc(const std::string& message) {
        Doc doc;
        doc.error = message + " at byte " + std::to_string(pos_);
        return doc;
    }

    void skip_ws() {
        while (pos_ < input_.size() && (input_[pos_] == ' ' || input_[pos_] == '\t' ||
               input_[pos_] == '\r' || input_[pos_] == '\n')) ++pos_;
    }

    bool fail(const char* message) {
        if (error_.empty()) error_ = message;
        return false;
    }

    bool take(char expected) {
        if (pos_ >= input_.size() || input_[pos_] != expected) return false;
        ++pos_;
        return true;
    }

    bool literal(std::string_view text, Value& out, Type type, bool boolean = false) {
        if (input_.substr(pos_, text.size()) != text) return fail("invalid literal");
        pos_ += text.size();
        out.type = type;
        out.boolean = boolean;
        return true;
    }

    static int hex(char ch) {
        if (ch >= '0' && ch <= '9') return ch - '0';
        if (ch >= 'a' && ch <= 'f') return 10 + ch - 'a';
        if (ch >= 'A' && ch <= 'F') return 10 + ch - 'A';
        return -1;
    }

    bool hex4(uint32_t& out) {
        if (pos_ + 4 > input_.size()) return fail("truncated unicode escape");
        out = 0;
        for (int i = 0; i < 4; ++i) {
            int digit = hex(input_[pos_++]);
            if (digit < 0) return fail("invalid unicode escape");
            out = (out << 4) | static_cast<uint32_t>(digit);
        }
        return true;
    }

    static void append_utf8(std::string& out, uint32_t cp) {
        if (cp <= 0x7f) out.push_back(static_cast<char>(cp));
        else if (cp <= 0x7ff) {
            out.push_back(static_cast<char>(0xc0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        } else if (cp <= 0xffff) {
            out.push_back(static_cast<char>(0xe0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        } else {
            out.push_back(static_cast<char>(0xf0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3f)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3f)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3f)));
        }
    }

    bool quoted(std::string& out) {
        if (!take('"')) return fail("expected string");
        while (pos_ < input_.size()) {
            unsigned char ch = static_cast<unsigned char>(input_[pos_++]);
            if (ch == '"') return true;
            if (ch < 0x20) return fail("unescaped control character");
            if (ch != '\\') {
                out.push_back(static_cast<char>(ch));
                continue;
            }
            if (pos_ >= input_.size()) return fail("truncated escape");
            char esc = input_[pos_++];
            switch (esc) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u': {
                uint32_t cp = 0;
                if (!hex4(cp)) return false;
                if (cp >= 0xd800 && cp <= 0xdbff) {
                    if (pos_ + 2 > input_.size() || input_[pos_] != '\\' || input_[pos_ + 1] != 'u')
                        return fail("missing low surrogate");
                    pos_ += 2;
                    uint32_t low = 0;
                    if (!hex4(low)) return false;
                    if (low < 0xdc00 || low > 0xdfff) return fail("invalid low surrogate");
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                } else if (cp >= 0xdc00 && cp <= 0xdfff) {
                    return fail("unexpected low surrogate");
                }
                append_utf8(out, cp);
                break;
            }
            default: return fail("invalid escape");
            }
        }
        return fail("unterminated string");
    }

    bool number_value(Value& out) {
        size_t start = pos_;
        if (take('-') && pos_ == input_.size()) return fail("truncated number");
        if (take('0')) {
            if (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9')
                return fail("leading zero");
        } else {
            if (pos_ >= input_.size() || input_[pos_] < '1' || input_[pos_] > '9')
                return fail("invalid number");
            while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
        }
        if (take('.')) {
            if (pos_ >= input_.size() || input_[pos_] < '0' || input_[pos_] > '9')
                return fail("invalid fraction");
            while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
        }
        if (pos_ < input_.size() && (input_[pos_] == 'e' || input_[pos_] == 'E')) {
            ++pos_;
            if (pos_ < input_.size() && (input_[pos_] == '+' || input_[pos_] == '-')) ++pos_;
            if (pos_ >= input_.size() || input_[pos_] < '0' || input_[pos_] > '9')
                return fail("invalid exponent");
            while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') ++pos_;
        }
        std::string token(input_.substr(start, pos_ - start));
        char* end = nullptr;
        errno = 0;
        double value = std::strtod(token.c_str(), &end);
        if (errno == ERANGE || !end || *end != '\0' || !std::isfinite(value))
            return fail("number out of range");
        out.type = Type::Number;
        out.number = value;
        return true;
    }

    bool array_value(Value& out, int depth) {
        if (depth >= kMaxDepth) return fail("maximum depth exceeded");
        take('['); out.type = Type::Array;
        skip_ws();
        if (take(']')) return true;
        while (true) {
            Value child;
            if (!value(child, depth + 1)) return false;
            out.array.push_back(std::move(child));
            skip_ws();
            if (take(']')) return true;
            if (!take(',')) return fail("expected array comma");
            skip_ws();
        }
    }

    bool object_value(Value& out, int depth) {
        if (depth >= kMaxDepth) return fail("maximum depth exceeded");
        take('{'); out.type = Type::Object;
        skip_ws();
        if (take('}')) return true;
        while (true) {
            std::string key;
            if (!quoted(key)) return false;
            if (out.object.find(key) != out.object.end()) return fail("duplicate object key");
            skip_ws();
            if (!take(':')) return fail("expected object colon");
            skip_ws();
            Value child;
            if (!value(child, depth + 1)) return false;
            out.object.emplace(std::move(key), std::move(child));
            skip_ws();
            if (take('}')) return true;
            if (!take(',')) return fail("expected object comma");
            skip_ws();
        }
    }

    bool value(Value& out, int depth) {
        skip_ws();
        if (pos_ >= input_.size()) return fail("expected value");
        switch (input_[pos_]) {
        case '{': return object_value(out, depth);
        case '[': return array_value(out, depth);
        case '"': out.type = Type::String; return quoted(out.string);
        case 't': return literal("true", out, Type::Boolean, true);
        case 'f': return literal("false", out, Type::Boolean, false);
        case 'n': return literal("null", out, Type::Null);
        default: return number_value(out);
        }
    }
};

const Value* member(const Value& object, const char* key) {
    if (object.type != Type::Object) return nullptr;
    auto it = object.object.find(key);
    return it == object.object.end() ? nullptr : &it->second;
}

} // namespace

Doc parse(std::string_view input) { return Parser(input).run(); }

Get number(const Value& scope, const char* key, double& out) {
    const Value* value = member(scope, key);
    if (!value) return scope.type == Type::Object ? Get::Absent : Get::Malformed;
    if (value->type != Type::Number) return Get::Malformed;
    out = value->number;
    return Get::Ok;
}

Get string(const Value& scope, const char* key, std::string& out) {
    const Value* value = member(scope, key);
    if (!value) return scope.type == Type::Object ? Get::Absent : Get::Malformed;
    if (value->type != Type::String) return Get::Malformed;
    out = value->string;
    return Get::Ok;
}

Get object(const Value& scope, const char* key, const Value*& out) {
    const Value* value = member(scope, key);
    if (!value) return scope.type == Type::Object ? Get::Absent : Get::Malformed;
    if (value->type != Type::Object) return Get::Malformed;
    out = value;
    return Get::Ok;
}

Get int_triples(const Value& scope, const char* key,
                std::vector<std::array<int, 3>>& out, size_t max_count) {
    const Value* value = member(scope, key);
    if (!value) return scope.type == Type::Object ? Get::Absent : Get::Malformed;
    if (value->type != Type::Array) return Get::Malformed;
    std::vector<std::array<int, 3>> parsed;
    for (const Value& row : value->array) {
        if (parsed.size() == max_count) break;
        if (row.type != Type::Array || row.array.size() != 3) return Get::Malformed;
        std::array<int, 3> triple{};
        for (size_t i = 0; i < 3; ++i) {
            const Value& item = row.array[i];
            if (item.type != Type::Number || std::floor(item.number) != item.number ||
                    item.number < std::numeric_limits<int>::min() ||
                    item.number > std::numeric_limits<int>::max()) return Get::Malformed;
            triple[i] = static_cast<int>(item.number);
        }
        parsed.push_back(triple);
    }
    out.swap(parsed);
    return Get::Ok;
}

bool selftest() {
    double n = -1;
    std::string s;
    const Value* nested = nullptr;
    Doc good = parse(R"({"x":0,"s":"\u20ac","cam":{"x":7},"blocks":[[1,2,3]]})");
    if (!good.ok || number(good.root, "x", n) != Get::Ok || n != 0) return false;
    if (string(good.root, "s", s) != Get::Ok || s != "\xe2\x82\xac") return false;
    if (object(good.root, "cam", nested) != Get::Ok || !nested ||
            number(*nested, "x", n) != Get::Ok || n != 7) return false;
    std::vector<std::array<int, 3>> triples;
    if (int_triples(good.root, "blocks", triples, 64) != Get::Ok || triples.size() != 1) return false;
    if (number(good.root, "missing", n) != Get::Absent) return false;
    if (parse(R"({"x":"abc"})").root.object.at("x").type != Type::String) return false;
    for (std::string_view bad : {R"({"x":1e+})", R"({"s":"\u12"})", R"({"x":1,"x":2})",
                                 R"({"a":{"b":{"c":{"d":{"e":1}}}}})", R"({"x":1e999})"})
        if (parse(bad).ok) return false;
    return true;
}

} // namespace dwf::json_mini
