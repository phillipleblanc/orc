#!/usr/bin/env python3
"""Prepare a private SDK overlay for Zig 0.15's Mach-O stub reader.

Apple's arm64e-only TBD entries also serve arm64 clients. Zig 0.15 cannot
resolve these entries. Only the build-local copy is normalized.
"""
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(sys.argv[1])
sdk = Path(subprocess.check_output(['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip())
overlay = root / 'MacOSX.sdk'
stamp = root / 'sdk-source.txt'
if not stamp.exists() or stamp.read_text() != str(sdk):
    if overlay.exists():
        import shutil
        shutil.rmtree(overlay)
    subprocess.run(['cp', '-cR', str(sdk.resolve()), str(overlay)], check=True)
    for directory, _, files in os.walk(overlay):
        for name in files:
            path = Path(directory) / name
            if path.suffix != '.tbd' or path.is_symlink(): continue
            contents = path.read_text()
            def targets(match):
                values = match[1].replace('arm64e-', 'arm64-').split(',')
                return 'targets: [ ' + ', '.join(dict.fromkeys(v.strip() for v in values)) + ' ]'
            changed = re.sub(r'targets:\s*\[([^]]+)\]', targets, contents)
            if changed != contents: path.write_text(changed)
    stamp.write_text(str(sdk))
bin_dir = root / 'sdk-bin'
bin_dir.mkdir(exist_ok=True)
wrapper = bin_dir / 'xcrun'
import shlex
wrapper.write_text('#!/bin/bash\nfor arg in "$@"; do\n  if [[ "$arg" == --show-sdk-path ]]; then\n    printf "%s\\n" ' + shlex.quote(str(overlay)) + '\n    exit 0\n  fi\ndone\nexec /usr/bin/xcrun "$@"\n')
wrapper.chmod(0o755)
