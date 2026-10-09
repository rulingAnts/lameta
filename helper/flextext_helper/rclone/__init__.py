# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Seth Johnston.
"""rclone, supervised by the helper (PLAN §1.4, §3): `rclone rcd` on loopback with a random
token (supervisor.py), driven through its remote-control API (rc.py); the backup/restore
methods are in methods.py, the pure request-building in backup.py."""
