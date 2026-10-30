"""Tool surface, argument validation, and the JSON-RPC framing."""

import io
import json

import pytest

from computeruse import SERVER_NAME
from computeruse.server import (
    MUTATING,
    TOOL_SPECS,
    ComputerUseServer,
    ToolFailure,
    serve,
    validate,
)


def server(tmp_path):
    return ComputerUseServer(budget=5, ttl_days=1, audit_root=str(tmp_path), log=lambda _m: None)


# --- the surface itself ---------------------------------------------------

def test_exactly_seven_tools_with_the_designed_names():
    names = [t["name"] for t in TOOL_SPECS]
    assert names == ["screenshot", "click", "type_text", "key", "scroll", "drag", "control_status"]
    assert len(names) == 7


def test_every_mutating_tool_is_in_the_budget_set():
    assert MUTATING == {"click", "type_text", "key", "scroll", "drag"}
    assert set(t["name"] for t in TOOL_SPECS) - MUTATING == {"screenshot", "control_status"}


def test_every_schema_rejects_extra_fields():
    for spec in TOOL_SPECS:
        assert spec["inputSchema"]["additionalProperties"] is False, spec["name"]
        assert spec["inputSchema"]["type"] == "object"


def test_type_text_and_key_require_expect_title():
    for name in ("type_text", "key"):
        spec = next(t for t in TOOL_SPECS if t["name"] == name)
        assert "expect_title" in spec["inputSchema"]["required"]


def test_tools_list_is_static_and_ready_on_the_first_call(tmp_path):
    response = server(tmp_path).handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert len(response["result"]["tools"]) == 7


# --- validation -----------------------------------------------------------

def schema_of(name):
    return next(t for t in TOOL_SPECS if t["name"] == name)["inputSchema"]


def test_unknown_field_is_rejected():
    errors = validate(schema_of("click"), {"x": 1, "y": 2, "wat": True})
    assert any("unknown field" in e for e in errors)


def test_missing_required_field_is_rejected():
    assert validate(schema_of("click"), {"x": 1})
    assert any("required" in e for e in validate(schema_of("type_text"), {"text": "hi"}))


def test_range_and_enum_are_enforced():
    assert any("<= 2000" in e for e in validate(schema_of("click"), {"x": 1, "y": 2, "settle_ms": 9999}))
    assert any("one of" in e for e in validate(schema_of("click"), {"x": 1, "y": 2, "clicks": 3}))
    assert any("one of" in e for e in validate(schema_of("click"), {"x": 1, "y": 2, "button": "thumb"}))


def test_booleans_are_not_integers():
    assert validate(schema_of("click"), {"x": True, "y": 2})


def test_valid_args_pass():
    assert validate(schema_of("click"), {"x": 10, "y": 20}) == []
    assert validate(schema_of("type_text"), {"text": "hi", "expect_title": "Notepad"}) == []


def test_bad_args_come_back_as_is_error_not_as_a_crash(tmp_path):
    response = server(tmp_path).handle(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "click", "arguments": {"x": 1, "y": 2, "bogus": 1}},
        }
    )
    assert response["result"]["isError"] is True
    assert "unknown field" in response["result"]["content"][0]["text"]


def test_unknown_tool_is_an_error(tmp_path):
    with pytest.raises(ToolFailure):
        server(tmp_path).call_tool("rm_rf", {})


# --- JSON-RPC framing -----------------------------------------------------

def test_initialize_echoes_a_supported_protocol(tmp_path):
    response = server(tmp_path).handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "clientInfo": {"name": "opencode", "version": "2.2.1"}},
        }
    )
    result = response["result"]
    assert result["protocolVersion"] == "2025-11-25"
    assert result["serverInfo"]["name"] == SERVER_NAME
    assert "tools" in result["capabilities"]


def test_unknown_protocol_falls_back_to_the_newest_we_speak(tmp_path):
    response = server(tmp_path).handle(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2999-01-01"}}
    )
    assert response["result"]["protocolVersion"] == "2025-11-25"


def test_notifications_are_never_answered(tmp_path):
    assert server(tmp_path).handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    assert server(tmp_path).handle({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {}}) is None


def test_unknown_method_is_minus_32601(tmp_path):
    response = server(tmp_path).handle({"jsonrpc": "2.0", "id": 9, "method": "no/such"})
    assert response["error"]["code"] == -32601


def test_serve_answers_line_delimited_requests(tmp_path):
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    stdin = io.BytesIO(b"".join(json.dumps(r).encode("utf-8") + b"\n" for r in requests))
    stdout = io.BytesIO()
    serve(server(tmp_path), stdin=stdin, stdout=stdout)
    lines = stdout.getvalue().decode("utf-8").strip().splitlines()
    assert len(lines) == 2  # the notification produced no line
    replies = [json.loads(line) for line in lines]
    assert [r["id"] for r in replies] == [1, 2]
    assert len(replies[1]["result"]["tools"]) == 7


def test_serve_survives_a_malformed_line(tmp_path):
    stdin = io.BytesIO(b"{not json}\n" + json.dumps({"jsonrpc": "2.0", "id": 3, "method": "ping"}).encode() + b"\n")
    stdout = io.BytesIO()
    serve(server(tmp_path), stdin=stdin, stdout=stdout)
    lines = [json.loads(line) for line in stdout.getvalue().decode().strip().splitlines()]
    assert lines[0]["error"]["code"] == -32700
    assert lines[1]["result"] == {}


def test_control_status_is_read_only_and_names_the_budget(tmp_path):
    result = server(tmp_path).call_tool("control_status", {})
    payload = json.loads(result["content"][0]["text"])
    assert result["isError"] is False
    assert payload["state"] in ("ai", "user")
    assert payload["panic_hotkey"] == "Ctrl+Alt+Shift+F12"
    assert payload["budget"]["limit"] == 5
    assert payload["verdict"] in ("ready", "budget-exhausted", "user-took-control")
    assert payload["runtime"]["dpi_aware"] is True
