"""
No route may be unreachable behind an earlier one.

A router matches in registration order, so a route with a placeholder registered first takes every
path that fits it: `POST /rules/{rule_id}/restore` answered `POST /rules/overlaps/restore` with
"overlaps" as the rule id, and restoring a dismissed checkup finding failed with "Trashed rule not
found". Tests that call an endpoint function directly cannot see this, so the check is over the
routers' own tables: each route is probed with a concrete path it serves, and no earlier route in the
same router may match that path first.
"""

from __future__ import annotations

import importlib
import pkgutil
import unittest

from fastapi import APIRouter
from starlette.routing import Match

import backend.routers as routers_package


def _routers() -> list[tuple[str, APIRouter]]:
    found, seen = [], set()
    for info in pkgutil.walk_packages(routers_package.__path__, routers_package.__name__ + "."):
        router = getattr(importlib.import_module(info.name), "router", None)
        if isinstance(router, APIRouter) and id(router) not in seen:
            seen.add(id(router))
            found.append((info.name, router))
    return found


class RouteShadowingTests(unittest.TestCase):
    def test_no_route_is_served_by_an_earlier_one(self):
        routers = _routers()
        self.assertGreater(len(routers), 10, "the router walk found too few routers to mean anything")
        shadowed = []
        for module, router in routers:
            routes = [route for route in router.routes if hasattr(route, "methods")]
            for index, later in enumerate(routes):
                # A placeholder segment probes as a plain word, which it accepts.
                probe = later.path_format.replace("{", "x").replace("}", "")
                for method in later.methods:
                    scope = {"type": "http", "method": method, "path": probe, "root_path": ""}
                    for earlier in routes[:index]:
                        if earlier.matches(scope)[0] == Match.FULL:
                            shadowed.append(f"{module}: {method} {later.path_format} is served by {earlier.path_format}")
                            break
        self.assertEqual(shadowed, [])


if __name__ == "__main__":
    unittest.main()
