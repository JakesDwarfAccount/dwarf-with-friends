# Maintainers and authorship

Jake Taplin owns product direction, supported releases, and final merge decisions for Dwarf With
Friends. Contributors retain authorship of their commits and should be credited for substantive
work. Gabriel Rios and the upstream projects remain credited according to `UPSTREAM.md` and
`NOTICE`.

AI assistance is allowed and should be disclosed when it materially produced code. It does not own
decisions or replace review: the human submitting or merging a change is responsible for its data
flow, invariants, failure behavior, tests, and rollback.

Changes involving DF memory writes, save/load lifecycle, authentication, native threading, wire
bytes, packaging, or release provenance require focused review and evidence appropriate to their
risk. A green source-pattern test alone is not proof of live native behavior.
