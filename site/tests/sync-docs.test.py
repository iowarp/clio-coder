"""Regression checks for working-tree snapshots and immutable release sources."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "sync-docs.py"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="clio-docs-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        self.site.mkdir()
        self.guide = self.root / "docs/guide/start.md"
        self.guide.parent.mkdir(parents=True)
        self.guide.write_text("# Start\n\n## Run Clio\n\nRun `clio-coder`.\n\n## Internals\n\nPrivate development detail.\n")
        (self.root / "package.json").write_text('{"version":"1.0.0"}')
        (self.site / "product.json").write_text('{"version":"1.0.0"}')
        (self.site / "public-docs.json").write_text(json.dumps([{
            "source": "docs/guide/start.md", "path": "README.md", "title": "Start", "excerpt": "Open Clio.",
            "group": "Start", "sections": ["Run Clio"],
        }]))
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Clio snapshot test")
        self.git("config", "user.email", "snapshot-test@example.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "source")
        spec = importlib.util.spec_from_file_location("clio_sync_docs", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.SITE = self.site
        self.module.ROOT = self.root
        self.module.CONTENT = self.site / "content"
        self.module.DEST = self.site / "content/docs"
        self.module.INDEX = self.site / "content/index.json"
        self.module.MANIFEST = self.site / "content/docs-manifest.json"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def test_committing_snapshot_does_not_invalidate_its_base(self):
        self.module.sync("HEAD", True)
        base = json.loads(self.module.MANIFEST.read_text())["source"]["commit"]
        self.git("add", ".")
        self.git("commit", "-m", "generated public docs")
        self.assertNotEqual(base, self.git("rev-parse", "HEAD"))
        self.module.check()
        self.assertNotIn("Private development detail", (self.module.DEST / "README.md").read_text())
        self.guide.write_text(self.guide.read_text().replace("Run `clio-coder`.", "Run `clio-coder gui --open`."))
        with self.assertRaisesRegex(ValueError, "documentation drift"):
            self.module.check()

    def test_generated_bytes_and_search_index_are_validated(self):
        self.module.sync("HEAD", True)
        (self.module.DEST / "README.md").write_text("tampered content")
        with self.assertRaisesRegex(ValueError, "documentation drift"):
            self.module.check()
        self.module.sync("HEAD", True)
        self.module.INDEX.write_text("[]")
        with self.assertRaisesRegex(ValueError, "search index"):
            self.module.check()

    def test_repository_snapshot_is_immutable_without_a_release_tag(self):
        commit = self.git("rev-parse", "HEAD")
        self.module.sync(commit, False, True)
        source = json.loads(self.module.MANIFEST.read_text())["source"]
        self.assertEqual(source["mode"], "repository")
        self.assertEqual(source["ref"], commit)
        self.guide.write_text("# Later working content\n")
        self.module.check()
        manifest = json.loads(self.module.MANIFEST.read_text())
        manifest["files"][0]["sourceSha256"] = "0" * 64
        self.module.MANIFEST.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "source manifest"):
            self.module.check()

    def test_release_snapshot_ignores_later_working_tree_changes(self):
        self.git("tag", "v1.0.0")
        self.module.sync("v1.0.0", False)
        self.guide.write_text("# Different content\n")
        self.module.check()
        with self.assertRaisesRegex(ValueError, "require --source-ref"):
            self.module.sync("main", False)

    def test_public_summary_retains_pinned_source_and_detects_edits(self):
        commit = self.git("rev-parse", "HEAD")
        catalog_path = self.site / "public-docs.json"
        catalog = json.loads(catalog_path.read_text())
        catalog[0].pop("sections")
        catalog[0]["summary"] = "start.md"
        catalog_path.write_text(json.dumps(catalog))
        summary = self.site / "content/doc-summaries/start.md"
        summary.parent.mkdir(parents=True)
        summary.write_text("## Your first task\n\nAsk Clio to inspect the tests.\n")
        self.module.sync(commit, False, True)
        generated = (self.module.DEST / "README.md").read_text()
        self.assertIn("Your first task", generated)
        self.assertNotIn("Private development detail", generated)
        self.guide.write_text("# Later source changes\n")
        self.module.check()
        summary.write_text("## Different public advice\n")
        with self.assertRaisesRegex(ValueError, "documentation drift"):
            self.module.check()

    def test_summary_and_upstream_sources_cannot_escape_public_boundary(self):
        catalog_path = self.site / "public-docs.json"
        catalog = json.loads(catalog_path.read_text())
        catalog[0]["summary"] = "../private.md"
        catalog_path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, "invalid public summary"):
            self.module.sync("HEAD", True)
        catalog[0].pop("summary")
        catalog[0]["source"] = "docs/guide/private/notes.md"
        catalog_path.write_text(json.dumps(catalog))
        with self.assertRaisesRegex(ValueError, "not a public user guide"):
            self.module.sync("HEAD", True)


if __name__ == "__main__":
    unittest.main()
