#!/usr/bin/env python3
"""Test bundled phone grants over encrypted WebSockets using a disposable profile."""
from pathlib import Path
import subprocess

from orca_runtime import ROOT, load_lock, recipe_sha256

lock = load_lock()
work = sorted((ROOT / ".build/orca-runtime/work").glob(recipe_sha256(lock)[:12] + "-*"))
source_name = "orca-" + lock["upstream"]["commit"]
candidates = [path for path in work if (path / source_name / "node_modules/tweetnacl").exists()]
if not candidates:
    raise SystemExit("Build the locked runtime from source before running phone integration tests.")
selected = candidates[-1]
node = selected / "node" / lock["sourceBuild"]["node"]["directory"] / "bin/node"
raise SystemExit(subprocess.call([node, ROOT / "scripts/e2e-phone-pairing.mjs", selected / source_name]))
