"""`computeruse` entry point: run the MCP server, or run a self-test.

**Integration contract with the installer** (pinned by `tests/test_cli.py`):

* the config's `command` array is `[<absolute exe>, "--budget", "200"]`, so
  `--budget <int>` must be accepted, defaults to 200, and is described in
  `--help`;
* an unknown argument is a LOUD failure — argparse prints
  `unrecognized arguments: …` on **stderr** and exits 2. It is never ignored,
  because a typo'd flag that silently changes nothing is the failure mode this
  contract exists to prevent;
* in server mode **stdout carries JSON-RPC and nothing else**. `main()` grabs
  the real stdout buffer and rebinds `sys.stdout` to stderr *before*
  `server.start()`, so even a print from a dependency during start-up cannot
  corrupt the stream. Everything the server says goes to stderr or to the
  audit directory.

`--selftest` is what the installer calls after `uv tool install`: it prints the
version, the DPI state and the virtual-screen geometry in a form a shell script
can grep (`dpi_aware: true`), and it touches nothing — no mouse, no keyboard, no
capture unless `--capture-probe` is passed.  A pack that cannot even start on
this machine must fail here, before a config file is written.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys

from . import SERVER_NAME, __version__


def _versions() -> dict:
    import mss
    from PIL import __version__ as pillow_version

    return {"python": platform.python_version(), "mss": getattr(mss, "__version__", "unknown"), "pillow": pillow_version}


def run_selftest(capture_probe: bool = False) -> tuple[dict, int]:
    from . import capture, dpi

    report = dpi.dpi_report()
    versions = _versions()
    payload: dict = {
        "server": SERVER_NAME,
        "version": __version__,
        "runtime": versions,
        "dpi_aware": report["dpi_aware"],
        "dpi_method": report["method"],
        "dpi_error": report["error"],
        "dpi": report["dpi"],
        "scale": report["scale"],
        "virtual_screen": None,
        "monitors": None,
        "capture": None,
    }
    exit_code = 0 if report["dpi_aware"] else 1
    try:
        payload["virtual_screen"] = capture.virtual_screen()
        payload["monitors"] = capture.monitors()
    except Exception as exc:
        payload["screen_error"] = f"{type(exc).__name__}: {exc}"
        exit_code = 1
    if capture_probe:
        try:
            payload["capture"] = capture.probe()["capture"]
        except Exception as exc:
            payload["capture"] = {"error": f"{type(exc).__name__}: {exc}"}
            exit_code = 1
    return payload, exit_code


def _print_selftest_text(payload: dict) -> None:
    vs = payload.get("virtual_screen") or {}
    print(f"computeruse-selftest {payload['version']} ({SERVER_NAME})")
    print(f"python: {payload['runtime']['python']}")
    print(f"mss: {payload['runtime']['mss']}")
    print(f"pillow: {payload['runtime']['pillow']}")
    print(f"dpi_aware: {'true' if payload['dpi_aware'] else 'false'}")
    print(f"dpi_method: {payload['dpi_method']}")
    if payload.get("dpi_error"):
        print(f"dpi_error: {payload['dpi_error']}")
    print(f"dpi: {payload['dpi']}  scale: {payload['scale']}")
    if vs:
        print(f"virtual_screen: x={vs['x']} y={vs['y']} w={vs['w']} h={vs['h']}")
    else:
        print(f"virtual_screen: unavailable ({payload.get('screen_error')})")
    print(f"monitors: {len(payload.get('monitors') or [])}")
    if payload.get("capture"):
        cap = payload["capture"]
        if "error" in cap:
            print(f"capture: FAILED {cap['error']}")
        else:
            print(f"capture: {cap['width']}x{cap['height']} sha1={cap['sha1']} bytes={cap['bytes']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="computeruse",
        description="Computer-use MCP server for OpenCode Team Mode (7 tools, before/after change verdicts).",
    )
    parser.add_argument("--budget", type=int, default=200, help="mutating actions allowed per process (default 200)")
    parser.add_argument("--audit-ttl-days", type=int, default=7, help="days of audit rows/frames to keep (default 7)")
    parser.add_argument("--audit-dir", default=None, help="override the audit root (default %%LOCALAPPDATA%%/te-river/computeruse/audit)")
    parser.add_argument("--selftest", action="store_true", help="print DPI + virtual screen and exit")
    parser.add_argument("--capture-probe", action="store_true", help="with --selftest: also grab one frame and print its sha1")
    parser.add_argument("--json", action="store_true", help="with --selftest: print JSON instead of key: value lines")
    parser.add_argument("--version", action="store_true", help="print the package version and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.version:
        print(f"{SERVER_NAME} {__version__}")
        return 0

    if args.selftest:
        payload, code = run_selftest(capture_probe=args.capture_probe)
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            _print_selftest_text(payload)
        return code

    from .server import ComputerUseServer, serve

    # stdout is the protocol channel from this point on — and that includes
    # `server.start()`, which arms the panic hotkey and sweeps the audit dir.
    # Capture the real buffer FIRST, then point sys.stdout at stderr, so a stray
    # print anywhere below lands in the log instead of inside the JSON-RPC
    # stream (one unparsable line and the host drops the connection).
    protocol_out = getattr(sys.stdout, "buffer", None)
    try:
        sys.stdout = sys.stderr
    except Exception:
        pass

    server = ComputerUseServer(budget=args.budget, ttl_days=args.audit_ttl_days, audit_root=args.audit_dir)
    try:
        server.start()
        return serve(server, stdout=protocol_out)
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        try:
            server.shutdown()
        except Exception:
            pass


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
