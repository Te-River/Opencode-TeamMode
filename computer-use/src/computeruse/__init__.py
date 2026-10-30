"""computeruse — a minimal, auditable computer-use MCP server.

Seven tools over stdio JSON-RPC: screenshot / click / type_text / key / scroll /
drag / control_status.  Every mutating tool answers with a before/after frame
hash and a change verdict, because "the injection was delivered" is not the
same claim as "something happened".
"""

__version__ = "0.1.0"

# Single lowercase token on purpose: the host's action name is
# ``<server>_<tool>``, so any separator inside the server name would make the
# sanitised spelling ambiguous (and a mis-spelled deny is a silent no-op).
SERVER_NAME = "computeruse"
