"""Developer-tool regressions; no live services, model inference or credentials."""
import json
import pathlib
import subprocess
import sys
import unittest
import tempfile
import shutil
import sqlite3
import hashlib
import importlib.util
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools/update-forge-data.py"


class ForgeDataUpdateTests(unittest.TestCase):
    def module(self):
        spec = importlib.util.spec_from_file_location("forge_updater", TOOL)
        assert spec is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = pathlib.Path(temp.name)
        repo, data = root / "source", root / "data"
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(repo), *args], text=True, stderr=subprocess.DEVNULL).strip()
        git("init", "--initial-branch=main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("remote", "add", "origin", "https://github.com/yoimtrashgaming-prog/PromptForge-Public.git")
        shutil.copyfile(ROOT / "LICENSE", repo / "LICENSE")
        (repo / "README.md").write_text("## License\nGPL-3.0-or-later\n")
        (repo / "config").mkdir()
        (repo / "config/randomizer.json").write_text('{"categories":[]}')
        git("add", ".")
        git("commit", "-m", "fixture baseline")
        sha = git("rev-parse", "HEAD")
        git("update-ref", "refs/remotes/origin/main", sha)
        shutil.copytree(ROOT / "src-tauri/forge-data", data)
        pack = json.loads(self.module().decompress((data / "forge-pack.json").read_bytes()))
        pack["source"]["commit"] = sha
        raw = (json.dumps(pack, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        (data / "forge-pack.json").write_bytes(raw)
        manifest = json.loads((data / "MANIFEST.json").read_text(encoding='utf-8'))
        manifest["commit"] = sha
        manifest["files"]["forge-pack.json"].update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
        (data / "MANIFEST.json").write_text(json.dumps(manifest))
        return repo, data, git

    def test_check_preserves_dirty_checkout(self):
        repo, data, git = self.fixture()
        (repo / "README.md").write_text("uncommitted private edit")
        before = git("status", "--porcelain")
        result = subprocess.run([sys.executable, str(TOOL), "--check", "--no-fetch", "--repo", str(repo), "--data-dir", str(data)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "current")
        self.assertEqual(git("status", "--porcelain"), before)
        self.assertEqual((repo / "README.md").read_text(encoding='utf-8'), "uncommitted private edit")

    def test_update_refuses_changed_license_before_execution(self):
        repo, data, git = self.fixture()
        old = (data / "MANIFEST.json").read_bytes()
        (repo / "LICENSE").write_text("changed license fixture")
        git("add", "LICENSE")
        git("commit", "-m", "license change")
        git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"))
        result = subprocess.run([sys.executable, str(TOOL), "--update", "--no-fetch", "--repo", str(repo), "--data-dir", str(data)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "review-required")
        self.assertEqual((data / "MANIFEST.json").read_bytes(), old)

    def test_failed_publish_and_failed_rollback_preserve_recovery_copy(self):
        repo, data, git = self.fixture()
        spec = importlib.util.spec_from_file_location("forge_updater", TOOL)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = (data / "MANIFEST.json").read_bytes()
        candidate = data.parent / "candidate"
        shutil.copytree(data, candidate)
        (candidate / "MANIFEST.json").write_text("candidate marker")
        real_replace = module.os.replace
        calls = 0
        def fail_after_backup(src, dst):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("simulated destination failure")
            real_replace(src, dst)
        with mock.patch.object(module.os, "replace", side_effect=fail_after_backup):
            with self.assertRaises(OSError):
                module.replace_data(candidate, data, json.loads(original))
        self.assertTrue(any(p.read_bytes() == original for p in data.parent.rglob("MANIFEST.json")), "Failed rollback must retain the original data for recovery")

    def test_missing_supported_model_names_the_gap(self):
        repo, data, git = self.fixture()
        spec = importlib.util.spec_from_file_location("forge_updater", TOOL)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        pack = json.loads((data / "forge-pack.json").read_text(encoding='utf-8'))
        pack["models"].pop("moss")
        raw = (json.dumps(pack, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        (data / "forge-pack.json").write_bytes(raw)
        manifest = json.loads((data / "MANIFEST.json").read_text(encoding='utf-8'))
        manifest["files"]["forge-pack.json"].update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
        (data / "MANIFEST.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError) as error:
            module.validate_data(data)
        self.assertIn("moss", str(error.exception))

    def test_readonly_database_uri_preserves_spaces_unicode_and_fragments(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "tags 猫 # 100%.sqlite"
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE sample (value TEXT)")
                db.execute("INSERT INTO sample VALUES ('held')")
            db.close()
            connection = module.database(path)
            try:
                self.assertEqual(connection.execute("SELECT value FROM sample").fetchone(), ("held",))
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("DELETE FROM sample")
            finally:
                connection.close()

    def test_validation_closes_databases_before_scratch_cleanup(self):
        module = self.module()
        connections = []
        connect = module.database
        def track(path):
            connection = connect(path)
            connections.append(connection)
            return connection
        with mock.patch.object(module, "database", side_effect=track):
            module.validate_data(ROOT / "src-tauri/forge-data")
        self.assertEqual(len(connections), 2)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_verify_current_bundled_data(self):
        result = subprocess.run([sys.executable, str(TOOL), "--verify"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "verified")


if __name__ == "__main__":
    unittest.main()
