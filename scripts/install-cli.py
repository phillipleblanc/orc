#!/usr/bin/env python3
"""Install the CLI with its verified runtime without replacing a running Orc application."""
import argparse
import hashlib
import os
from pathlib import Path
import sys
import uuid

from orca_runtime import RuntimeError, load_lock, require_host
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location("package_orc", ROOT / "scripts/package-orc.py")
package = module_from_spec(spec)
spec.loader.exec_module(package)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", nargs="?", type=Path, default=ROOT / "dist/Orc.app")
    parser.add_argument("--prefix", type=Path, default=Path.home() / ".local")
    args = parser.parse_args()
    require_host()
    lock = load_lock()
    source = args.app.resolve()
    package.verify(source, lock)
    digest = hashlib.sha256((source / "Contents/_CodeSignature/CodeResources").read_bytes()).hexdigest()
    prefix = args.prefix.expanduser().absolute()
    target = prefix / "share/orc/cli" / digest / "Orc.app"
    link = prefix / "bin/orc"
    if link.exists() and not link.is_symlink():
        raise RuntimeError(f"{link} is a regular file; move it aside before installing the CLI.")
    if target.exists():
        package.verify(target, lock)
        if (target / "Contents/_CodeSignature/CodeResources").read_bytes() != (source / "Contents/_CodeSignature/CodeResources").read_bytes():
            raise RuntimeError("The installed bundle does not match its content address.")
    else:
        package.publish(source, target, lock)
    link.parent.mkdir(parents=True, exist_ok=True)
    temporary = link.with_name(".orc-" + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target / "Contents/Resources/orc")
        os.replace(temporary, link)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Installed {link} -> {target / 'Contents/Resources/orc'}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"orc-install-cli: {error}", file=sys.stderr)
        sys.exit(1)
