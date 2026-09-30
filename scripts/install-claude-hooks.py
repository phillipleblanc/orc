#!/usr/bin/env python3
"""Register Orc's Claude session naming hooks while preserving other settings."""
import argparse
import copy
import json
import os
from pathlib import Path
import shlex
import stat
import sys
import tempfile


def managed(hook):
    if not isinstance(hook, dict) or hook.get("type") != "command":
        return False
    try:
        args = shlex.split(hook.get("command", ""))
    except (TypeError, ValueError):
        return False
    return len(args) == 3 and Path(args[0]).name == "orc" and args[1:] == ["hook", "claude-session-name"]


def configure(settings, cli):
    if not isinstance(settings, dict):
        raise ValueError("Claude settings must be a JSON object.")
    result = copy.deepcopy(settings)
    hooks = result.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Claude hooks must be a JSON object.")
    for event in ("SessionStart", "UserPromptSubmit"):
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            raise ValueError(f"Claude {event} hooks must be an array.")
        preserved = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                raise ValueError(f"Invalid Claude {event} hook entry.")
            remaining = [hook for hook in entry["hooks"] if not managed(hook)]
            if remaining or not entry["hooks"]:
                preserved.append(dict(entry, hooks=remaining))
        entry = {"hooks": [{"type": "command", "command": f"{shlex.quote(str(cli))} hook claude-session-name", "timeout": 2}]}
        if event == "SessionStart":
            entry["matcher"] = "^(startup|resume|fork)$"
        hooks[event] = [*preserved, entry]
    return result


def install(settings_file, cli, check=False):
    # Follow an existing dotfiles symlink instead of replacing it.
    settings_file = settings_file.resolve()
    original = settings_file.read_bytes() if settings_file.exists() else None
    settings = json.loads(original) if original is not None else {}
    result = configure(settings, cli)
    if check or result == settings:
        return
    settings_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    mode = stat.S_IMODE(settings_file.stat().st_mode) if original is not None else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".orc-hooks-", dir=settings_file.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), mode)
            json.dump(result, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        current = settings_file.read_bytes() if settings_file.exists() else None
        if current != original:
            raise ValueError("Claude settings changed during installation; run the installer again.")
        os.replace(temporary, settings_file)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    install(args.settings, args.cli, args.check)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"orc-claude-hooks: {error}", file=sys.stderr)
        sys.exit(1)
