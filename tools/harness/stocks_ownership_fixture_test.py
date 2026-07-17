#!/usr/bin/env python3
"""Offline B297 ownership-model regression guard.

This is deliberately source/fixture based: the isolated wave sandbox cannot build the
DFHack tree. It pins the researched native model and proves that every shipped item-counting
surface names the shared predicate instead of growing another flag-only copy.
"""

from dataclasses import dataclass, field
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]


@dataclass
class ItemFixture:
    name: str
    expected: bool
    flags: set[str] = field(default_factory=set)
    holder: str = "none"


STOCK_BAD_FLAGS = {
    "hostile", "trader", "in_building", "garbage_collect", "removed",
    "dead_dwarf", "murder", "construction",
}


def native_stocks_model(item: ItemFixture) -> bool:
    if item.flags & STOCK_BAD_FLAGS:
        return False
    if item.holder in {"visitor", "resident", "diplomat", "mercenary", "caravan_guard", "invader"}:
        return False
    return True


# Exact pre-B297 info_panel.cpp predicate, retained only to prove the reported defect. It had no
# holder input, so identical citizen and visitor inventory both passed; trader happened to fail.
def pre_b297_serializer_model(item: ItemFixture) -> bool:
    old_bad = {"removed", "garbage_collect", "hidden", "hostile", "trader", "forbid", "rotten"}
    return not bool(item.flags & old_bad)


FIXTURES = [
    ItemFixture("fort ground steel weapon", True, {"on_ground"}),
    ItemFixture("fort soldier equipped steel weapon", True, {"in_inventory"}, "citizen"),
    ItemFixture("visitor equipped steel weapon", False, {"in_inventory"}, "visitor"),
    ItemFixture("long-term resident gear", False, {"in_inventory"}, "resident"),
    ItemFixture("diplomat gear", False, {"in_inventory"}, "diplomat"),
    ItemFixture("mercenary visitor gear", False, {"in_inventory"}, "mercenary"),
    ItemFixture("caravan guard gear", False, {"in_inventory"}, "caravan_guard"),
    ItemFixture("merchant pack-animal load", False, {"in_inventory", "trader"}, "caravan_guard"),
    ItemFixture("loose trader goods", False, {"trader"}),
    ItemFixture("hostile invader gear", False, {"hostile"}, "invader"),
    ItemFixture("non-hostile captive gear in cage", True, {"in_inventory"}, "caged_captive"),
    ItemFixture("imported foreign item now belonging to fort", True, {"foreign"}),
    ItemFixture("personally owned citizen item", True, {"owned"}, "citizen"),
    ItemFixture("forbidden fort item", True, {"forbid"}),
    ItemFixture("dump-designated fort item", True, {"dump"}),
    ItemFixture("fort artifact", True, {"artifact"}),
    ItemFixture("item on fire", True, {"on_fire"}),
    ItemFixture("spider web thread", True, {"spider_web"}),
    ItemFixture("encased item", True, {"encased"}),
    ItemFixture("building component", False, {"in_building"}),
    ItemFixture("construction material", False, {"construction"}),
    ItemFixture("garbage collected item", False, {"garbage_collect"}),
]


failures: list[str] = []


fort_carried = next(f for f in FIXTURES if f.name == "fort soldier equipped steel weapon")
visitor_carried = next(f for f in FIXTURES if f.name == "visitor equipped steel weapon")
trader_item = next(f for f in FIXTURES if f.name == "loose trader goods")
if not pre_b297_serializer_model(fort_carried):
    failures.append("pre-B297 reproduction no longer models the citizen control as included")
if not pre_b297_serializer_model(visitor_carried):
    failures.append("pre-B297 reproduction did not expose the visitor-holder defect")
if pre_b297_serializer_model(trader_item):
    failures.append("pre-B297 reproduction incorrectly says trader goods were not already filtered")


for fixture in FIXTURES:
    got = native_stocks_model(fixture)
    if got != fixture.expected:
        failures.append(f"reference fixture {fixture.name!r}: expected {fixture.expected}, got {got}")


def read(relative: str) -> str:
    path = ROOT / relative
    if not path.exists():
        failures.append(f"missing {relative}")
        return ""
    return path.read_text(encoding="utf-8")


header = read("src/fort_stock.h")
info = read("src/info_panel.cpp")
kitchen = read("src/kitchen_panel.cpp")
farm = read("src/building_zone.cpp")
trade = read("src/trade_depot.cpp")
lever = read("src/lever_link.cpp")
lua = read("dwf.lua")

for needle in (
    "bool is_fort_stock_item(",
    "FortItemPurpose::Stocks",
    "Items::getHolderUnit",
    "Units::isCitizen",
    "flags.bits.trader",
    "flags.bits.hostile",
):
    if needle not in header:
        failures.append(f"src/fort_stock.h does not pin {needle!r}")

if "bool is_counted_stock_item(" in info:
    failures.append("info_panel.cpp still owns its old flag-only stock predicate")
if info.count("is_fort_stock_item(item, FortItemPurpose::Stocks)") < 3:
    failures.append("Stocks count/category/search paths are not all routed through the shared Stocks policy")
if "is_fort_stock_item(item, FortItemPurpose::Kitchen)" not in kitchen:
    failures.append("Kitchen aggregation bypasses the shared ownership model")
if "is_fort_stock_item(item, FortItemPurpose::Available)" not in farm:
    failures.append("Farm seed availability bypasses the shared ownership model")
if "is_fort_stock_item(item, FortItemPurpose::TradeDepot)" not in trade:
    failures.append("Trade-depot goods bypass the shared ownership model")
if "is_fort_stock_item(item, FortItemPurpose::Available)" not in lever:
    failures.append("Lever mechanism availability bypasses the shared ownership model")
if "function is_fort_stock_item(item, purpose)" not in lua:
    failures.append("Lua item enumerators have no shared ownership predicate")
for marker in (
    "return is_fort_stock_item(item, 'available')",
    "is_fort_stock_item(it, 'presence')",
    "is_fort_stock_item(item, 'condition-material')",
):
    if marker not in lua:
        failures.append(f"Lua item surface does not use shared policy marker {marker!r}")

if failures:
    for failure in failures:
        print(f"FAIL {failure}")
    print(f"stocks_ownership_fixture_test: {len(failures)} FAILED")
    sys.exit(1)

print("PASS pre-B297 reproduction: citizen=true visitor=true trader=false")
print(f"PASS {len(FIXTURES)} corrected ownership fixtures")
print("PASS all audited item-counting surfaces use the shared ownership model")
print("stocks_ownership_fixture_test: PASS")
