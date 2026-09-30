import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("claude_hooks", Path(__file__).resolve().parents[1] / "install-claude-hooks.py")
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)


class ClaudeHookInstallTests(unittest.TestCase):
    def test_other_settings_and_hooks_survive_idempotent_install(self):
        old = {"type": "command", "command": "'/old app/orc' hook claude-session-name"}
        other = {"type": "command", "command": "existing-hook", "timeout": 15}
        settings = {"model": "opus", "permissions": {"deny": ["Read(.env)"]}, "hooks": {
            "SessionStart": [{"matcher": "resume", "hooks": [old, other]}, {"hooks": [old]}],
            "Stop": [{"hooks": [other]}]}}
        cli = Path("/a 'quoted' app/Orc.app/Contents/Resources/orc")
        result = hooks.configure(settings, cli)
        self.assertEqual(result["model"], settings["model"])
        self.assertEqual(result["permissions"], settings["permissions"])
        self.assertEqual(result["hooks"]["Stop"], settings["hooks"]["Stop"])
        self.assertEqual(result["hooks"]["SessionStart"][0], {"matcher": "resume", "hooks": [other]})
        self.assertEqual(len(settings["hooks"]["SessionStart"]), 2)
        for event in ["SessionStart", "UserPromptSubmit"]:
            managed = [h for entry in result["hooks"][event] for h in entry["hooks"] if hooks.managed(h)]
            self.assertEqual(len(managed), 1)
            self.assertEqual(shlex.split(managed[0]["command"]), [str(cli), "hook", "claude-session-name"])
        self.assertEqual(hooks.configure(result, cli), result)

    def test_file_install_preserves_symlink_permissions_and_unchanged_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "dotfiles.json"
            target.write_text('{"model":"opus"}')
            target.chmod(0o640)
            settings = Path(directory) / "settings.json"
            settings.symlink_to(target)
            hooks.install(settings, Path("/app/orc"), check=True)
            self.assertEqual(target.read_text(), '{"model":"opus"}')
            hooks.install(settings, Path("/app/orc"))
            self.assertTrue(settings.is_symlink())
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)
            before = (target.read_bytes(), target.stat().st_mtime_ns)
            hooks.install(settings, Path("/app/orc"))
            self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), before)
            self.assertEqual(json.loads(target.read_bytes())["model"], "opus")

    def test_invalid_settings_remain_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            for text in ["{", "[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}',
                         '{"hooks":{"UserPromptSubmit":[{}]}}']:
                settings.write_text(text)
                with self.assertRaises(ValueError):
                    hooks.install(settings, Path("/app/orc"))
                self.assertEqual(settings.read_text(), text)

    def test_fresh_install_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / ".claude/settings.json"
            hooks.install(settings, Path("/app/orc"))
            self.assertEqual(settings.stat().st_mode & 0o777, 0o600)
            self.assertEqual(set(json.loads(settings.read_bytes())["hooks"]), {"SessionStart", "UserPromptSubmit"})
