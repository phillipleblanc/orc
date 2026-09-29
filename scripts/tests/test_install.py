import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "install.sh"


class InstallPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="orc-install-paths-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "dist/Orc.app").mkdir(parents=True)
        self.script = self.root / "scripts/install.sh"
        shutil.copyfile(INSTALLER, self.script)
        tools = self.root / "tools"
        tools.mkdir()
        # Stop at publication so path tests cannot replace an installed application.
        for name, body in {
            "python3": 'if [[ "$3" == --output ]]; then printf "app:%s\\n" "$4"; exit 73; fi\n',
            "mkdir": 'printf "mkdir:%s\\n" "$@"\n',
        }.items():
            tool = tools / name
            tool.write_text("#!/bin/bash\n" + body)
            tool.chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{tools}:/usr/bin:/bin")
        self.env.pop("ORC_INSTALL_ROOT", None)
        self.env.pop("ORC_CONFIG_DIR", None)

    def run_installer(self, **environment):
        return subprocess.run(["/bin/bash", str(self.script), "--offline"],
                              env=dict(self.env, **environment), capture_output=True, text=True, timeout=10)

    def test_default_app_is_system_wide_and_cli_stays_in_home(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["mkdir:-p", "mkdir:/Applications", f"mkdir:{self.home}/.local/bin",
                                                     "app:/Applications/Orc.app"])

    def test_override_keeps_app_and_user_files_in_disposable_root(self):
        root = self.root / "isolated install"
        result = self.run_installer(ORC_INSTALL_ROOT=str(root))
        self.assertEqual(result.returncode, 73, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ["mkdir:-p", f"mkdir:{root}/Applications", f"mkdir:{root}/.local/bin",
                                                     f"app:{root}/Applications/Orc.app"])

    def test_relative_override_is_rejected_before_creating_directories(self):
        result = self.run_installer(ORC_INSTALL_ROOT="relative")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ORC_INSTALL_ROOT must be absolute", result.stderr)
        self.assertEqual(result.stdout, "")
