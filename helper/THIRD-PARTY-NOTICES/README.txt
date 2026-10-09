Third-party notices for FlexText Metadata (for lameta)
======================================================

FlexText Metadata is a fork of lameta (https://github.com/onset/lameta), which is
MIT-licensed; lameta's own licence and attribution are kept unchanged in the
application's LICENSE file. The additions made in this fork are licensed
AGPL-3.0-or-later (Copyright (C) 2026 Seth Johnston).

The bundled helper ships these third-party components:

flexicon (PyPI "pyflexicon", https://github.com/MattGyverLee/flexicon)
    LGPL-2.1-or-later. Bundled as plain, unmodified .py source files under
    flextext-helper/_internal/flexicon, so the library can be replaced
    (see flexicon-LICENSE.txt). flexicon is a fork of cdfarrow/flexlibs.

pythonnet (Python.NET, https://github.com/pythonnet/pythonnet)
    MIT. The wheel ships no licence file, so the text is added here by hand
    (pythonnet-LICENSE.txt).

clr_loader (https://github.com/pythonnet/clr-loader)
    MIT (clr_loader-LICENSE.txt).

rclone (https://rclone.org, https://github.com/rclone/rclone)
    MIT (rclone-LICENSE.txt). Shipped as the unmodified official
    windows-amd64 build, checksum-verified at build time.

Python (https://www.python.org) and its standard library
    PSF License, bundled by PyInstaller.

psutil (https://github.com/giampaolo/psutil)
    BSD-3-Clause.

PyInstaller bootloader (https://pyinstaller.org)
    GPL-2.0-or-later with the bootloader exception, which permits bundling
    programs under any licence.
