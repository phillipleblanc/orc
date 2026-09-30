import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_orc", SCRIPTS / "package-orc.py")
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


@unittest.skipUnless(sys.platform == "darwin", "macOS bundle installation")
class AppPublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="orc-publication-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source/Orc.app"
        self.output = self.root / "installed/Orc.app"
        for relative in package.EXECUTABLES:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile("/bin/sleep", path)
            path.chmod(0o755)
            # A copied platform binary is not valid code at its new path; sign it like the build does.
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(path)], check=True, capture_output=True)
        for relative in package.FILES:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
        (self.source / "Contents/Resources/version").write_text("old")
        shutil.copytree(self.source, self.output, symlinks=True)
        (self.source / "Contents/Resources/version").write_text("new")

    def test_missing_runtime_parts_fail_verification(self):
        (self.source / package.RUNTIME / "orc-holder").unlink()
        with self.assertRaisesRegex(package.PackageError, "orc-holder"):
            package.verify(self.source)
        (self.source / package.RUNTIME / "frontend/src/main.ts").unlink()
        with self.assertRaisesRegex(package.PackageError, "missing"):
            package.verify(self.source)

    def test_update_replaces_the_bundle_while_its_programs_keep_running(self):
        process = subprocess.Popen([str(self.output / package.RUNTIME / "node"), "60"], stdin=subprocess.DEVNULL)
        self.addCleanup(lambda: (process.terminate(), process.wait(timeout=5)))
        with patch.object(package, "verify"):
            package.publish(self.source, self.output)
        self.assertEqual((self.output / "Contents/Resources/version").read_text(), "new")
        self.assertIsNone(process.poll())

    def test_failed_exchange_preserves_original_install(self):
        with patch.object(package, "verify"), patch.object(package, "atomic_swap", side_effect=OSError("exchange failed")):
            with self.assertRaisesRegex(OSError, "exchange failed"):
                package.publish(self.source, self.output)
        self.assertEqual((self.output / "Contents/Resources/version").read_text(), "old")

    def test_aliases_and_nested_destinations_are_rejected(self):
        alias = self.root / "source-alias"
        alias.symlink_to(self.source.parent, target_is_directory=True)
        with patch.object(package, "verify") as verify:
            for destination in [self.source, alias / "Orc.app", self.source / "nested/Orc.app"]:
                with self.subTest(destination=destination), self.assertRaisesRegex(package.PackageError, "separate"):
                    package.publish(self.source, destination)
            verify.assert_not_called()

    def test_first_install_publishes_complete_bundle(self):
        shutil.rmtree(self.output)
        with patch.object(package, "verify"):
            package.publish(self.source, self.output)
        self.assertEqual((self.output / "Contents/Resources/version").read_text(), "new")


@unittest.skipUnless(sys.platform == "darwin", "macOS process inspection")
class RuntimeRestartTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="orc-restart-")
        self.addCleanup(temporary.cleanup)
        self.profile = Path(temporary.name).resolve() / "runtime"
        self.profile.mkdir()

    def serve(self, lock=True, on_term="exit(0)"):
        # A stand-in whose command line looks like a frontend; `lock` makes it hold the profile's lock.
        script = f"import signal, time; signal.signal(signal.SIGTERM, lambda *_: {on_term}); print('ready', flush=True); time.sleep(60)"
        process = subprocess.Popen([sys.executable, "-c", script, "frontend/src/main.ts", "--profile", str(self.profile)],
                                   stdout=subprocess.PIPE, text=True)
        self.assertEqual(process.stdout.readline().strip(), "ready")
        self.addCleanup(lambda: (process.poll() is None and process.kill(), process.wait(timeout=5), process.stdout.close()))
        (self.profile / "orca-runtime.json").write_text(json.dumps({"pid": process.pid}))
        (self.profile / "frontend.lock").write_text(str(process.pid if lock else process.pid + 1))
        return process

    def test_stops_the_frontend_serving_the_profile(self):
        process = self.serve()
        self.assertTrue(package.restart_runtime(self.profile))
        self.assertEqual(process.wait(timeout=5), 0)

    def test_kills_a_frontend_that_does_not_finish_stopping(self):
        process = self.serve(on_term="None")
        self.assertTrue(package.restart_runtime(self.profile, timeout=0.5))
        self.assertEqual(process.wait(timeout=5), -9)

    def test_leaves_other_processes_and_missing_runtimes_alone(self):
        process = self.serve(lock=False)
        self.assertFalse(package.restart_runtime(self.profile))
        self.assertIsNone(process.poll())
        (self.profile / "orca-runtime.json").unlink()
        self.assertFalse(package.restart_runtime(self.profile))


if __name__ == "__main__":
    unittest.main()
