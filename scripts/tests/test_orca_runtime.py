import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location("orca_runtime", Path(__file__).resolve().parents[1] / "orca_runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = b"locked release bytes"
        self.item = {"url": "https://example.invalid/Orca.zip", "sha256": hashlib.sha256(self.content).hexdigest()}

    def test_repository_lock_and_license_are_consistent(self):
        lock = runtime.load_lock()
        self.assertEqual(lock["purpose"], "development-bundle")

    def test_offline_cache_hit_verifies_without_network(self):
        cached = self.root / self.item["sha256"]
        cached.write_bytes(self.content)
        with patch.object(runtime, "run") as run:
            self.assertEqual(runtime.fetch(self.item, self.root, offline=True), cached)
        run.assert_not_called()

    def test_offline_miss_never_downloads(self):
        with patch.object(runtime, "run") as run:
            with self.assertRaisesRegex(runtime.RuntimeError, "missing"):
                runtime.fetch(self.item, self.root, offline=True)
        run.assert_not_called()

    def test_corrupt_cache_is_rejected_even_when_online(self):
        cached = self.root / self.item["sha256"]
        cached.write_bytes(b"corrupt")
        for offline in (True, False):
            with self.subTest(offline=offline), patch.object(runtime, "run") as run:
                with self.assertRaisesRegex(runtime.RuntimeError, "SHA-256 mismatch"):
                    runtime.fetch(self.item, self.root, offline)
                run.assert_not_called()

    def test_download_is_verified_before_it_is_published(self):
        def download(*args):
            Path(args[args.index("--output") + 1]).write_bytes(b"wrong bytes")
        with patch.object(runtime, "run", side_effect=download):
            with self.assertRaisesRegex(runtime.RuntimeError, "SHA-256 mismatch"):
                runtime.fetch(self.item, self.root)
        self.assertFalse((self.root / self.item["sha256"]).exists())
        self.assertEqual(list(self.root.glob("download-*")), [])

    def test_valid_download_is_published(self):
        def download(*args):
            Path(args[args.index("--output") + 1]).write_bytes(self.content)
        with patch.object(runtime, "run", side_effect=download):
            cached = runtime.fetch(self.item, self.root)
        self.assertEqual(cached.read_bytes(), self.content)
        self.assertEqual(list(self.root.glob("download-*")), [])

    def archive(self, entries):
        path = self.root / "runtime.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name, data, link in entries:
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = ((stat.S_IFLNK if link else stat.S_IFREG) | 0o755) << 16
                archive.writestr(info, data)
        return path

    def test_framework_symlinks_are_preserved(self):
        archive = self.archive([
            ("Orca.app/Contents/Frameworks/Electron.framework/Versions/A/Electron", "binary", False),
            ("Orca.app/Contents/Frameworks/Electron.framework/Versions/Current", "A", True),
            ("Orca.app/Contents/Frameworks/Electron.framework/Electron", "Versions/Current/Electron", True),
        ])
        runtime.validate_archive(archive)

    def test_archive_paths_cannot_escape_or_write_through_links(self):
        cases = [
            [("../escaped", "bad", False)],
            [("/tmp/escaped", "bad", False)],
            [("Orca.app/../../escaped", "bad", False)],
            [("Other.app/Contents/file", "bad", False)],
            [("Orca.app/link", "/tmp", True)],
            [("Orca.app/link", "../escaped", True)],
            [("Orca.app/link", "Contents", True), ("Orca.app/link/file", "bad", False)],
        ]
        for entries in cases:
            with self.subTest(entries=entries), self.assertRaises(runtime.RuntimeError):
                runtime.validate_archive(self.archive(entries))

    def fake_app(self, source_build=False):
        lock = runtime.load_lock()
        bundle = lock["sourceBuild"]["bundle"] if source_build else lock["bundle"]
        app = self.root / "Orca.app"
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        info = {
            "CFBundleIdentifier": bundle["identifier"],
            "CFBundleVersion": bundle["version"],
            "CFBundleShortVersionString": bundle["version"],
            "CFBundleExecutable": "Orca",
        }
        if source_build:
            info.update(CFBundleName=bundle["displayName"], LSUIElement=bundle["accessoryBundle"])
            helper_name = bundle["displayName"] + " Helper"
            helper = contents / "Frameworks" / (helper_name + ".app") / "Contents/MacOS" / helper_name
            helper.parent.mkdir(parents=True)
            helper.write_bytes(b"fixture")
            (contents / "Resources").mkdir()
            (contents / "Resources/orc-build.json").write_text(json.dumps({"recipeSHA256": runtime.recipe_sha256(lock)}))
        (contents / "Info.plist").write_bytes(plistlib.dumps(info))
        executable = contents / "MacOS/Orca"
        executable.write_bytes(b"fixture")
        executable.chmod(0o755)
        return app, lock

    def test_wrong_architecture_is_rejected(self):
        app, lock = self.fake_app()
        with patch.object(runtime, "run", return_value="x86_64\n"):
            with self.assertRaisesRegex(runtime.RuntimeError, "architecture"):
                runtime.verify_runtime(app, lock)

    def test_invalid_sealed_resources_are_rejected(self):
        app, lock = self.fake_app()
        with patch.object(runtime, "run", side_effect=["arm64\n", runtime.RuntimeError("sealed resource invalid")]):
            with self.assertRaisesRegex(runtime.RuntimeError, "sealed resource"):
                runtime.verify_runtime(app, lock)

    def test_ad_hoc_signature_cannot_replace_upstream_identity(self):
        app, lock = self.fake_app()
        with patch.object(runtime, "run", side_effect=["arm64\n", "", "Signature=adhoc\n"]):
            with self.assertRaisesRegex(runtime.RuntimeError, "signing identity"):
                runtime.verify_runtime(app, lock)

    def test_version_mismatch_fails_before_signature_tools(self):
        app, lock = self.fake_app()
        lock = copy.deepcopy(lock)
        lock["bundle"]["version"] = "0.0.0"
        with patch.object(runtime, "run") as run:
            with self.assertRaisesRegex(runtime.RuntimeError, "does not match"):
                runtime.verify_runtime(app, lock)
        run.assert_not_called()

    def test_stage_does_not_merge_into_existing_bundle(self):
        output = self.root / "Orc.app"
        output.mkdir()
        marker = output / "keep"
        marker.write_text("existing build")
        with patch.object(runtime, "require_host"), patch.object(runtime, "run") as run:
            with self.assertRaisesRegex(runtime.RuntimeError, "already exists"):
                runtime.stage(self.root / "host.app", output, runtime.load_lock(), self.root)
        run.assert_not_called()
        self.assertEqual(marker.read_text(), "existing build")

    def test_changed_patch_fails_lock_validation(self):
        lock = runtime.load_lock()
        lock["sourceBuild"]["inputs"][0]["sha256"] = "0" * 64
        path = self.root / "lock.json"
        path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(runtime.RuntimeError, "SHA-256 mismatch"):
            runtime.load_lock(path)

    def test_unpinned_patch_is_rejected(self):
        lock = runtime.load_lock()
        lock["sourceBuild"]["patches"].append("runtime/unverified.patch")
        path = self.root / "lock.json"
        path.write_text(json.dumps(lock))
        with self.assertRaisesRegex(runtime.RuntimeError, "pinned checksum"):
            runtime.load_lock(path)

    def test_source_cache_requires_the_exact_recipe_and_archive(self):
        lock = runtime.load_lock()
        recipe = runtime.recipe_sha256(lock)
        build = self.root / "builds" / recipe
        build.mkdir(parents=True)
        archive = build / "runtime.zip"
        archive.write_bytes(self.content)
        receipt = {"schemaVersion": 1, "recipeSHA256": recipe, "artifactSHA256": self.item["sha256"]}
        (build / "receipt.json").write_text(json.dumps(receipt))
        self.assertEqual(runtime.source_archive(lock, self.root), (archive, receipt))
        archive.write_bytes(b"tampered")
        with self.assertRaisesRegex(runtime.RuntimeError, "SHA-256 mismatch"):
            runtime.source_archive(lock, self.root)

    def test_source_receipt_from_another_recipe_is_rejected(self):
        lock = runtime.load_lock()
        build = self.root / "builds" / runtime.recipe_sha256(lock)
        build.mkdir(parents=True)
        (build / "receipt.json").write_text(json.dumps({"schemaVersion": 1, "recipeSHA256": "wrong"}))
        with self.assertRaisesRegex(runtime.RuntimeError, "receipt does not match"):
            runtime.source_archive(lock, self.root)

    def test_source_cache_miss_never_downloads(self):
        with patch.object(runtime, "fetch") as fetch:
            with self.assertRaisesRegex(runtime.RuntimeError, "build-orca-runtime.py"):
                runtime.source_archive(runtime.load_lock(), self.root)
        fetch.assert_not_called()

    def source_signature(self, lock):
        bundle = lock["sourceBuild"]["bundle"]

        def run(*args):
            if "-archs" in args:
                return "arm64\n"
            if "--display" in args:
                return "\n".join(["Identifier=" + bundle["identifier"],
                                  "Authority=" + bundle["signingAuthority"],
                                  "TeamIdentifier=" + bundle["teamIdentifier"]])
            return ""
        return run

    def test_source_bundle_requires_the_locked_keychain_name(self):
        app, lock = self.fake_app(source_build=True)
        plist = app / "Contents/Info.plist"
        info = plistlib.loads(plist.read_bytes())
        info["CFBundleName"] = "Orca"
        plist.write_bytes(plistlib.dumps(info))
        with patch.object(runtime, "run", side_effect=self.source_signature(lock)):
            with self.assertRaisesRegex(runtime.RuntimeError, "Keychain"):
                runtime.verify_runtime(app, lock, source_build=True)

    def test_source_bundle_requires_accessory_policy(self):
        app, lock = self.fake_app(source_build=True)
        plist = app / "Contents/Info.plist"
        info = plistlib.loads(plist.read_bytes())
        info["LSUIElement"] = False
        plist.write_bytes(plistlib.dumps(info))
        with patch.object(runtime, "run", side_effect=self.source_signature(lock)):
            with self.assertRaisesRegex(runtime.RuntimeError, "activation policy"):
                runtime.verify_runtime(app, lock, source_build=True)

    def test_source_bundle_requires_signed_provenance(self):
        app, lock = self.fake_app(source_build=True)
        (app / "Contents/Resources/orc-build.json").write_text(json.dumps({"recipeSHA256": "old recipe"}))
        with patch.object(runtime, "run", side_effect=self.source_signature(lock)):
            with self.assertRaisesRegex(runtime.RuntimeError, "different source inputs"):
                runtime.verify_runtime(app, lock, source_build=True)

    def test_source_bundle_requires_helpers_matching_its_name(self):
        app, lock = self.fake_app(source_build=True)
        for helper in (app / "Contents/Frameworks").glob("*.app/Contents/MacOS/*"):
            helper.unlink()
        with patch.object(runtime, "run", side_effect=self.source_signature(lock)):
            with self.assertRaisesRegex(runtime.RuntimeError, "Electron helper layout"):
                runtime.verify_runtime(app, lock, source_build=True)


if __name__ == "__main__":
    unittest.main()
