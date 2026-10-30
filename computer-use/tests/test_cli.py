"""The installer integration contract, exercised against the real CLI.

These are subprocess tests on purpose: the contract is about argv and about
what leaves stdout, neither of which an in-process call can prove.

  command: [<absolute exe>, "--budget", "200"]
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def run_cli(argv, stdin=None, timeout=120):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "src")
    return subprocess.run(
        [sys.executable, "-m", "computeruse.cli", *argv],
        input=(stdin.encode("utf-8") if stdin else b""),
        capture_output=True,
        cwd=str(ROOT),
        env=env,
        timeout=timeout,
    )


def test_help_accepts_and_documents_budget():
    proc = run_cli(["--help"])
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0
    assert "--budget" in out
    assert "200" in out


def test_unknown_argument_fails_loudly_and_does_not_pollute_stdout():
    proc = run_cli(["--definitely-not-a-flag"])
    assert proc.returncode == 2
    assert proc.stdout == b""  # nothing on the protocol channel
    assert "unrecognized arguments" in proc.stderr.decode("utf-8", "replace")


def test_budget_flag_reaches_the_running_server(tmp_path):
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": "control_status", "arguments": {}}},
    ]
    stdin = "".join(json.dumps(r) + "\n" for r in reqs)
    proc = run_cli(["--budget", "7", "--audit-dir", str(tmp_path)], stdin=stdin)
    assert proc.returncode == 0

    lines = [line for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    # stdout is protocol only: every line must parse, the notification produced none.
    replies = [json.loads(line) for line in lines]
    assert len(replies) == 2
    status = json.loads(replies[1]["result"]["content"][0]["text"])
    assert status["budget"]["limit"] == 7
    assert status["budget"]["used"] == 0


def test_default_budget_is_200(tmp_path):
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
         "params": {"name": "control_status", "arguments": {}}},
    ]
    stdin = "".join(json.dumps(r) + "\n" for r in reqs)
    proc = run_cli(["--audit-dir", str(tmp_path)], stdin=stdin)
    replies = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    status = json.loads(replies[0]["result"]["content"][0]["text"])
    assert status["budget"]["limit"] == 200


def test_seven_tools_on_the_first_tools_list(tmp_path):
    """The host calls tools/list immediately; it must be right on call one."""
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    stdin = "".join(json.dumps(r) + "\n" for r in reqs)
    proc = run_cli(["--audit-dir", str(tmp_path)], stdin=stdin)
    replies = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    names = [t["name"] for t in replies[1]["result"]["tools"]]
    assert names == ["screenshot", "click", "type_text", "key", "scroll", "drag", "control_status"]


def test_stderr_carries_the_logs_not_stdout(tmp_path):
    reqs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}]
    proc = run_cli(["--audit-dir", str(tmp_path)], stdin="".join(json.dumps(r) + "\n" for r in reqs))
    err = proc.stderr.decode("utf-8", "replace")
    out = proc.stdout.decode("utf-8", "replace")
    assert "[computeruse] start" in err          # the log went to stderr
    lines = [line for line in out.splitlines() if line.strip()]
    assert len(lines) == 1                        # exactly one protocol reply
    assert "[computeruse]" not in out             # no log line on the protocol channel
    assert json.loads(lines[0])["id"] == 1        # and it is a clean JSON object
