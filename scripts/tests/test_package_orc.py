import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("package_orc", SCRIPTS / "package-orc.py")
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
HELPERS = Path("Contents/Helpers")
EXECUTABLE = HELPERS / "Orca.app/Contents/MacOS/Orca"
RESOURCE = HELPERS / "Orca.app/Contents/Resources/asset"


@unittest.skipUnless(sys.platform == "darwin", "macOS bundle installation")
class AppPublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="orc-publication-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source/Orc.app"
        self.output = self.root / "installed/Orc.app"
        for path in [EXECUTABLE, Path("Contents/MacOS/Orc"), Path("Contents/Resources/orc")]:
            destination = self.source / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile("/bin/sleep", destination)
            destination.chmod(0o755)
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(destination)],
                           check=True, capture_output=True)
        asset = self.source / RESOURCE
        asset.parent.mkdir(parents=True)
        asset.write_text("runtime resource")
        (asset.parent / "linked-asset").symlink_to("asset")
        (self.source / "Contents/Resources/frontend-version").write_text("old frontend")
        shutil.copytree(self.source, self.output, symlinks=True)
        (self.source / "Contents/Resources/frontend-version").write_text("new frontend")
        # Fixtures exercise copying, runtime comparison, process detection, and the
        # macOS atomic exchange. Signed bundles are covered by e2e-bundled.py.
        verification = patch.object(package, "verify")
        self.verify = verification.start()
        self.addCleanup(verification.stop)

    def start(self, executable=EXECUTABLE):
        process = subprocess.Popen([str(self.output / executable), "60"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def stop():
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
        self.addCleanup(stop)
        self.assertIsNone(process.poll())
        return process

    def identities(self):
        return {str(path.relative_to(self.output)): (path.stat().st_dev, path.stat().st_ino)
                for path in (self.output / HELPERS).rglob("*") if path.is_file() and not path.is_symlink()}

    def test_frontend_update_preserves_live_runtime_files_and_process(self):
        process = self.start()
        self.assertTrue(package.bundle_in_use(self.output))
        identities = self.identities()
        stale = self.output / "Contents/Resources/stale"
        stale.write_text("remove on install")
        package.publish(self.source, self.output, {})
        self.assertIsNone(process.poll())
        self.assertEqual(self.identities(), identities)
        self.assertEqual((self.output / RESOURCE).read_text(), "runtime resource")
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "new frontend")
        self.assertEqual(os.readlink((self.output / RESOURCE).parent / "linked-asset"), "asset")
        self.assertFalse(stale.exists())
        self.assertFalse(list(self.output.parent.glob(".orc-install-*")))
        self.assertTrue(package.bundle_in_use(self.output))
        (self.source / RESOURCE).write_text("different runtime after frontend update")
        with self.assertRaisesRegex(package.RuntimeError, "runtime differs"):
            package.publish(self.source, self.output, {})

    def test_frontend_and_cli_processes_can_remain_running_with_identical_runtime(self):
        gui = self.start(Path("Contents/MacOS/Orc"))
        cli = self.start(Path("Contents/Resources/orc"))
        package.publish(self.source, self.output, {})
        self.assertIsNone(gui.poll())
        self.assertIsNone(cli.poll())
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "new frontend")

    def test_changed_runtime_resources_are_refused_without_touching_live_bundle(self):
        process = self.start()
        identities = self.identities()
        (self.source / RESOURCE).write_text("different runtime with the same version labels")
        with self.assertRaisesRegex(package.RuntimeError, "runtime differs"):
            package.publish(self.source, self.output, {})
        self.assertEqual(self.identities(), identities)
        self.assertEqual((self.output / RESOURCE).read_text(), "runtime resource")
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "old frontend")
        self.assertIsNone(process.poll())

    def test_runtime_permissions_symlink_targets_and_file_inventory_must_match(self):
        self.start()
        changes = [lambda: (self.source / RESOURCE).chmod(0o700),
                   lambda: (self.source / RESOURCE).parent.joinpath("extra").write_text("extra"),
                   lambda: (self.source / RESOURCE).parent.joinpath("linked-asset").unlink()]
        for change in changes:
            with self.subTest(change=change):
                shutil.rmtree(self.source / HELPERS)
                shutil.copytree(self.output / HELPERS, self.source / HELPERS, symlinks=True)
                change()
                with self.assertRaisesRegex(package.RuntimeError, "runtime differs"):
                    package.publish(self.source, self.output, {})
        link = (self.source / RESOURCE).parent / "linked-asset"
        link.symlink_to("other-asset")
        with self.assertRaisesRegex(package.RuntimeError, "runtime differs"):
            package.publish(self.source, self.output, {})

    def test_changed_runtime_installs_when_destination_is_idle(self):
        (self.source / RESOURCE).write_text("updated runtime")
        package.publish(self.source, self.output, {})
        self.assertEqual((self.output / RESOURCE).read_text(), "updated runtime")

    def test_failed_exchange_preserves_original_install_and_runtime_file_links(self):
        process = self.start()
        identities = self.identities()
        links = (self.output / EXECUTABLE).stat().st_nlink
        with patch.object(package, "atomic_swap", side_effect=OSError("exchange failed")):
            with self.assertRaisesRegex(OSError, "exchange failed"):
                package.publish(self.source, self.output, {})
        self.assertEqual(self.identities(), identities)
        self.assertEqual((self.output / EXECUTABLE).stat().st_nlink, links)
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "old frontend")
        self.assertIsNone(process.poll())

    def test_failed_verification_of_linked_stage_preserves_running_install(self):
        process = self.start()
        self.verify.side_effect = [None, None, package.RuntimeError("invalid staged signature")]
        identities = self.identities()
        with self.assertRaisesRegex(package.RuntimeError, "invalid staged signature"):
            package.publish(self.source, self.output, {})
        self.assertEqual(self.identities(), identities)
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "old frontend")
        self.assertIsNone(process.poll())

    def test_aliases_and_nested_destinations_are_rejected(self):
        alias = self.root / "source-alias"
        alias.symlink_to(self.source.parent, target_is_directory=True)
        for destination in [self.source, alias / "Orc.app", self.source / "nested/Orc.app"]:
            with self.subTest(destination=destination), self.assertRaisesRegex(package.RuntimeError, "separate"):
                package.publish(self.source, destination, {})
        self.verify.assert_not_called()

    def test_first_install_publishes_complete_bundle(self):
        shutil.rmtree(self.output)
        package.publish(self.source, self.output, {})
        self.assertEqual(package.runtime_tree(self.output / HELPERS), package.runtime_tree(self.source / HELPERS))
        self.assertEqual((self.output / "Contents/Resources/frontend-version").read_text(), "new frontend")


if __name__ == "__main__":
    unittest.main()
