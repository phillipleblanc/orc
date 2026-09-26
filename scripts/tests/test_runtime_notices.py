import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("build_runtime", SCRIPTS / "build-orca-runtime.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class RuntimeNoticeTests(unittest.TestCase):
    def test_notices_avoid_packager_exclusions_and_preserve_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            inputs = ["node_modules/.pnpm/library@1/node_modules/library/LICENSE-MIT",
                      "mobile/node_modules/.pnpm/mobile@2/node_modules/mobile/NOTICE",
                      "node_modules/electron/dist/LICENSE",
                      "node_modules/electron/dist/LICENSES.chromium.html", "LICENSE"]
            for index, name in enumerate(inputs):
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"complete license {index}\n")
            self.assertEqual(builder.collect_notices(source), len(inputs))
            files = [path for path in (source / "orc-notices").rglob("*") if path.is_file()]
            self.assertEqual({path.read_text() for path in files}, {f"complete license {i}\n" for i in range(len(inputs))})
            for path in files:
                self.assertNotIn("node_modules", path.parts)
                self.assertNotIn(".pnpm", path.parts)


if __name__ == "__main__":
    unittest.main()
