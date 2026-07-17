#!/usr/bin/env perl
# w7-sub.pl -- W7 brand-rename content substitution for ONE file, in place.
#
# Part of the W7 "dfcapture -> dwf" pure-rename commit. See
# docs/superpowers/specs/2026-07-12-dwarf-with-friends-rebrand-design.md (W7 + W9).
#
# This does token substitution and NOTHING else -- it never touches logic. The rule:
#   1. A set of PROTECTED patterns (W9 plugin identity + runtime/deploy paths + read-state
#      config files + build/version identity + a deliberately-kept legacy env alias) are
#      swapped out to a per-file-unique sentinel BEFORE any substitution and swapped back to
#      their EXACT original bytes AFTER, so they survive verbatim. The patterns tolerate an
#      optional backslash before a `.` so that regex-escaped forms in tests/JS (e.g.
#      /dfcapture-hostwrites\.json/) are protected identically to the plain string -- and the
#      exact matched text (with or without the backslash) is what gets restored.
#   2. The plugin NAME used as a DFHack lifecycle command (`load/unload/disable/... dfcapture`)
#      is protected too -- the registered plugin name stays `dfcapture` until W9. But
#      `load dfcapture-tiles.js` (a JS filename) is NOT a command and DOES rename, hence the
#      (?![\w.-]) guard.
#   3. Then the case-variant map, longest-first: DFCAPTURE->DWF, DFCapture->Dwf, dfcapture->dwf.
#   4. Then the standalone abbreviation `dfcap` (e.g. hyphenated log/temp tags) -> dwf, but
#      ONLY when it is not glued to an identifier char -- so compound identifiers that are
#      internal/protocol contracts (dfcap_auth cookie, dfcapJoin* DOM ids, DFCAP_* build vars)
#      are left untouched.
#
# Byte mode throughout: BOMs, CRLF, and any non-ASCII bytes are preserved exactly. Text files
# that happen to embed a stray NUL are still processed (see the ratio-based binary guard);
# only genuine binaries (mostly-NUL) are skipped.

use strict;
use warnings;

my $path = $ARGV[0] or die "usage: w7-sub.pl <file>\n";

open(my $in, '<:raw', $path) or die "open $path: $!\n";
local $/;
my $s = <$in>;
close($in);
$s = '' unless defined $s;
my $orig = $s;
my $len = length($s);
exit 0 if $len == 0;

# Binary guard: skip only genuine binaries. A stray NUL in an otherwise-text file (some of our
# .js/.mjs embed control bytes in string data) must NOT disqualify it. True binaries are
# NUL-dense; text is not. (The caller also skips known binary extensions up front.)
my $nul = ($s =~ tr/\x00//);
exit 0 if $nul > 0 && ($nul * 100) > $len;   # >1% NUL bytes => treat as binary

# Per-file-unique sentinel base: guarantee it does not already occur in the file, so protection
# is collision-proof even for files that legitimately contain control bytes.
my $base = "\x01W7X";
my $suffix = 0;
while (index($s, $base) >= 0) { $base = "\x01W7X" . (++$suffix); }
my @cap;                         # captured original bytes, indexed by sentinel number
my $sent = sub { push @cap, $_[0]; return $base . $#cap . "\x01"; };

# --- 1. Protected patterns (optional backslash before dots), most-specific first. ---
#     Each captures and restores the EXACT matched bytes.
my @prot = (
    qr/DFHACK_PLUGIN\("dfcapture"\)/,        # registered plugin name (W9)
    qr/dfcapture-hostwrites\\?\.json/,       # host-writes safety flags file (read next to DF exe)
    qr/dfcapture_join_password\\?\.txt/,     # join-password file (read/written by host)
    qr/dfcapture\\?\.plug\\?\.dll/,          # DLL filename == OUTPUT_NAME (W9)
    qr/plugins\\?\.dfcapture/,               # lua module path DFHack resolves by filename (W9)
    qr/project\(dfcapture\)/,                # CMake project name (W9)
    qr/OUTPUT_NAME dfcapture/,               # CMake DLL output name (W9)
    qr{gui/dfcapture},                       # in-game script invocation == scripts/gui/dfcapture.lua (W9)
    qr/dfcapture-web/,                       # served web-root directory + C++ kWebRoot constant (W9)
    qr/dfcapture\\?\.json/,                  # dfhack-config/dfcapture.json host config (read)
    qr/dfcapture\\?\.lua/,                   # lua plugin/script filename (W9)
    qr/dfcapture_public/,                    # CMake target name (W9)
    qr/DFCAPTURE_GIT_HASH/,                  # build-stamp compile def (build identity + deploy coupling)
    qr/DFCAPTURE_BUILD/,                     # covers _BUILD / _BUILD_STAMP / __BUILD__ / window.DFCAPTURE_BUILD
    qr/DFCAPTURE_DF_ROOT/,                   # deliberately-kept LEGACY env alias (renaming deletes a feature)
);
for my $re (@prot) {
    $s =~ s/($re)/$sent->($1)/ge;
}

# --- 2. Plugin name as a DFHack lifecycle command (stays `dfcapture` until W9). ---
$s =~ s/((?:load|unload|disable|enable|reload)\s+)dfcapture(?![\w.-])/$1 . $sent->("dfcapture")/ge;

# --- 3. Case-variant brand map, longest-first. ---
$s =~ s/DFCAPTURE/DWF/g;
$s =~ s/DFCapture/Dwf/g;
$s =~ s/dfcapture/dwf/g;

# --- 4. Standalone `dfcap` abbreviation (not glued to an identifier char). ---
$s =~ s/(?<![A-Za-z0-9_])dfcap(?![A-Za-z0-9_])/dwf/g;

# --- restore protected bytes exactly ---
$s =~ s/\Q$base\E(\d+)\x01/$cap[$1]/g;

if ($s ne $orig) {
    open(my $out, '>:raw', $path) or die "write $path: $!\n";
    print $out $s;
    close($out);
    print "MODIFIED $path\n";
}
exit 0;
