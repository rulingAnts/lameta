# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""Entry point: `python -m flextext_helper [--parent-pid N] [--adapter real|fake] [--log-level L]`

Also the PyInstaller entry (flextext-helper.spec). Environment:
    FLEXTEXT_FLEX_ADAPTER   real (default on Windows) | fake
    FLEXTEXT_FAKE_FIXTURE   path to a JSON fixture for the fake adapter
    FLEXTEXT_RCLONE         path to the rclone executable (default: beside the helper, or PATH)
    FLEXTEXT_LOG_LEVEL      DEBUG | INFO | WARNING (default INFO)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys


def build_server(adapter_name: str, parent_pid: int = 0, rclone_path: str | None = None):
    from .server import Server
    from .flex.methods import FlexMethods
    from .rclone.methods import RcloneMethods

    if adapter_name == "fake":
        from .flex.fake import FakeFlexicon

        fixture = os.environ.get("FLEXTEXT_FAKE_FIXTURE")
        adapter = FakeFlexicon.from_file(fixture) if fixture else FakeFlexicon()
    else:
        from .flex.real import RealFlexicon

        adapter = RealFlexicon()

    server = Server(parent_pid=parent_pid)
    flex = FlexMethods(adapter)
    server.register_all(flex.table(), lane="flex")
    server.on_shutdown(flex.close)

    rclone = RcloneMethods(rclone_path=rclone_path)
    server.register_all(rclone.table(), lane="general")
    server.on_shutdown(rclone.close)
    return server


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="flextext-helper")
    ap.add_argument("--parent-pid", type=int, default=0)
    ap.add_argument("--adapter", choices=["real", "fake"], default=os.environ.get("FLEXTEXT_FLEX_ADAPTER") or ("real" if os.name == "nt" else "fake"))
    ap.add_argument("--rclone", default=os.environ.get("FLEXTEXT_RCLONE"))
    ap.add_argument("--log-level", default=os.environ.get("FLEXTEXT_LOG_LEVEL", "INFO"))
    ap.add_argument("--no-job-object", action="store_true", help="(tests) skip the Windows job object")
    args = ap.parse_args(argv)

    # stdout is protocol only: UTF-8, line-buffered. Logs go to stderr.
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
        sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    logging.basicConfig(
        stream=sys.stderr,
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("flextext")

    if not args.no_job_object:
        from .jobobject import assign_self_to_kill_on_close_job

        assign_self_to_kill_on_close_job()

    server = build_server(args.adapter, parent_pid=args.parent_pid, rclone_path=args.rclone)

    if args.parent_pid:
        from .watchdog import start_watchdog

        def orphaned():
            # The main thread is blocked in readline() on a pipe that may never close, and a
            # file object cannot be closed from another thread while it is mid-read. So: arm a
            # hard exit first (the guarantee), then do the orderly part (close the project,
            # stop rclone) and exit.
            import threading

            def hard_exit():
                import time

                time.sleep(3.0)
                os._exit(0)

            threading.Thread(target=hard_exit, daemon=True).start()
            try:
                server.stop()
            finally:
                os._exit(0)

        start_watchdog(args.parent_pid, orphaned)

    log.info("helper starting: adapter=%s parent=%s pid=%s", args.adapter, args.parent_pid, os.getpid())
    server.serve()
    log.info("helper stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
