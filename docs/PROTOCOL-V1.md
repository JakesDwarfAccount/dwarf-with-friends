# Dwarf With Friends protocol v1

Protocol v1 is the binary, acknowledged map stream sent from the plugin to each browser. The numeric constants are defined in `src/wire_v1.h` and mirrored by `web/js/dwf-wire-v1.js`. The decoder fixture exercises the production JavaScript decoder.

Every binary frame starts with ten bytes: magic `D5`, version, frame type, flags, and sequence. The
defined types are BLOCK_SET (`1`), AUX (`2`), and ITEMDEF_DICT (`3`). Deflated payloads use zlib and
set flag bit `1`.

A BLOCK_SET contains world-addressed 16×16 blocks. Each tile has a fixed 12-byte base record and may
refer to length-prefixed tail records for items, plants, spatter, flows, engraving, priority, vermin,
container contents, or farm crops. A tail body is at most 255 bytes because its size field is one
byte; an oversized tail is dropped before the count and payload are assembled.

The first designation byte uses bits 0-3 for the dig kind, bits 4-5 for smoothing, bit 6 for marker
mode, and bit 7 for DF's automining flag. Older clients safely ignore the added high bit; current
clients use it to render ordinary automining designations with the green automining tint.

Sequence acknowledgements control pacing, not world identity. Block updates are idempotent and keyed
by position/version; reconnect can resume from cached state and request missing blocks. AUX is
latest-wins state such as units, buildings, cameras, and presence. ITEMDEF_DICT is a one-shot
dictionary and is not part of the normal block/AUX sequencing contract.

REQ_BLOCKS is reliable but smoothed. Each connection coalesces requested block ids into a deduplicated
newest-wins pending set capped at 256 ids; the process-wide cap is 1024. The server drains at most 64
ids every 250ms, preserving the original DF-side cost envelope without refusing bursts. Local overflow
evicts the oldest id so current camera demand wins, and increments reqblocksCap. Diagnostics retain
reqblocksRate as a compatibility count of rate-window events and expose the honest name
reqblocksCoalesced; neither means requested blocks were discarded.

Text control messages are strict JSON objects. The client sends top-level `type` values including
`hello`, `ack`, `cam`, `pong`, `auxr`, `reqblocks`, `chat`, `cursor`, and `rename`. The server sends
controls such as `hello_ack`, `ping`, `auth_fail`, and `chat_rejected`. Unknown controls are ignored;
malformed JSON or wrong field types are rejected without partially applying a message.

Changing a number, base record layout, tail layout, or sequencing rule is a protocol change and
requires C++ self-tests, JavaScript decoder fixtures, golden byte updates, reconnect testing, and a
deliberate compatibility decision. Documentation edits alone never redefine the wire.
