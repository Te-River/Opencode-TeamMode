"""computeruse — a minimal, auditable computer-use MCP server.

Seven tools over stdio JSON-RPC: screenshot / click / type_text / key / scroll /
drag / control_status.  Every mutating tool answers with a before/after frame
hash and a change verdict, because "the injection was delivered" is not the
same claim as "something happened".
"""

# The wheel's metadata is the ONE source of truth for the version.  A hardcoded string
# here drifted from pyproject.toml and made an installed 0.0.2 wheel report itself as
# 0.1.0 (measured on the live server, 2026-10-30) — the same "one version, two
# contradictory descriptions" defect this project bans.  A bare source tree says so.
try:
    from importlib.metadata import version as _dist_version

    __version__ = _dist_version("computeruse-mcp")
except Exception:  # pragma: no cover - only an uninstalled source checkout
    __version__ = "0.0.0+source"

# Single lowercase token on purpose: the host's action name is
# ``<server>_<tool>``, so any separator inside the server name would make the
# sanitised spelling ambiguous (and a mis-spelled deny is a silent no-op).
SERVER_NAME = "computeruse"
