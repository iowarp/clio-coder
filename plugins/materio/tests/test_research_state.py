"""Observable state/portability contracts. All mutations use temporary projects."""
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "assets/scripts"


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


state = module("research_state")
citations = module("verify_citations")
projection = module("project_plugin")


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="materials research ")
        self.project = Path(self.temp.name)
        self.root = self.project / ".research"
        self.root.mkdir()
        (self.root / "config.json").write_text(json.dumps(state.DEFAULTS))

    def tearDown(self):
        self.temp.cleanup()

    def test_default_record_never_initializes_git(self):
        self.assertFalse(state.record(self.root, "research", [".research/config.json"])["recorded"])
        self.assertFalse((self.project / ".git").exists())

    def test_config_rejects_ambiguous_or_nonboolean_authorization(self):
        for text in ['{"commit_research":false,"commit_research":true}',
                     '{"commit_research":"true"}', '{bad json}', '[]']:
            (self.root / "config.json").write_text(text)
            with self.assertRaises(ValueError):
                state.config(self.root)

    def test_ids_are_decimal_stable_and_include_archived_and_disk(self):
        (self.root / "WORKFLOW.md").write_text(
            "## Tasks\n### Task 07: current\n- **Dependencies**: none\n"
            "## Archived Tasks\n### Task 12: old\n")
        (self.root / "tasks/task-15").mkdir(parents=True)
        self.assertEqual(state.next_task(self.root), "16")
        self.assertEqual(state.task_number("08"), "08")
        self.assertEqual(state.task_number("100"), "100")
        self.assertEqual(state.validate_workflow(self.root)["active"], ["07"])

    def test_dependency_cycle_missing_and_archived_refs_rejected(self):
        cases = [
            "## Tasks\n### Task 01: a\n- **Dependencies**: Task 02\n### Task 02: b\n- **Dependencies**: Task 01\n",
            "## Tasks\n### Task 01: a\n- **Dependencies**: Task 09\n",
            "## Tasks\n### Task 01: a\n- **Dependencies**: Task 02\n## Archived Tasks\n### Task 02: b\n",
            "## Tasks\n### Task 01: a\n### Task 01: duplicate\n",
        ]
        for text in cases:
            (self.root / "WORKFLOW.md").write_text(text)
            with self.assertRaises(ValueError):
                state.validate_workflow(self.root)

    def test_next_task_follows_ready_dependencies_and_workflow_order_across_gaps(self):
        text = ("## Tasks\n"
                "### Task 09: downstream\n- **Dependencies**: Task 04\n- **Status**: ☐ pending\n"
                "### Task 02: completed\n- **Dependencies**: none\n- **Status**: ☑ complete\n"
                "### Task 12: reordered\n- **Dependencies**: Task 02\n- **Status**: ☐ pending\n"
                "### Task 04: prerequisite\n- **Dependencies**: none\n- **Status**: ☐ pending\n"
                "## Archived Tasks\n### Task 03: retired\n- **Status**: ☐ archived\n")
        path = self.root / "WORKFLOW.md"
        path.write_text(text)
        self.assertEqual(state.next_ready_task(self.root)["id"], "12")
        self.assertEqual(path.read_text(), text)
        text = text.replace("Task 12: reordered\n- **Dependencies**: Task 02\n- **Status**: ☐ pending",
                            "Task 12: reordered\n- **Dependencies**: Task 02\n- **Status**: ☑ complete")
        path.write_text(text)
        self.assertEqual(state.next_ready_task(self.root)["id"], "04")
        text = text.replace("Task 04: prerequisite\n- **Dependencies**: none\n- **Status**: ☐ pending",
                            "Task 04: prerequisite\n- **Dependencies**: none\n- **Status**: ☑ complete")
        path.write_text(text)
        self.assertEqual(state.next_ready_task(self.root)["id"], "09")
        path.write_text(text.replace("☐ pending", "☑ complete"))
        self.assertIsNone(state.next_ready_task(self.root)["id"])

    def test_next_task_cli_reports_real_id_without_mutating_workflow(self):
        path = self.root / "WORKFLOW.md"
        path.write_text("## Tasks\n### Task 17: ready\n- **Dependencies**: none\n- **Status**: ☐ pending\n")
        before = path.read_bytes()
        result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "research_state.py"),
                                 "--project", str(self.project), "next-task"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["id"], "17")
        self.assertEqual(path.read_bytes(), before)

    def test_checkpoint_roundtrip_replaces_state_preserves_data_and_archives(self):
        (self.root / "STATE.md").write_text("approved state")
        (self.root / "data").mkdir()
        (self.root / "data/observations.csv").write_text("x,y\n1,2\n")
        snapshot = state.checkpoint_save(self.root, "approved")
        (self.root / "STATE.md").write_text("later state")
        (self.root / "later.md").write_text("created later")
        (self.root / "data/observations.csv").write_text("x,y\n1,3\n")
        with self.assertRaises(ValueError):
            state.checkpoint_restore(self.root, snapshot["checkpoint"], False)
        receipt = state.checkpoint_restore(self.root, snapshot["checkpoint"], True)
        self.assertEqual(receipt["restored"], snapshot["checkpoint"])
        self.assertEqual((self.root / "STATE.md").read_text(), "approved state")
        self.assertFalse((self.root / "later.md").exists())
        self.assertEqual((self.root / "data/observations.csv").read_text(), "x,y\n1,3\n")
        self.assertTrue((self.root / "checkpoints" / snapshot["checkpoint"]).is_file())

    def test_checkpoint_names_do_not_collide_and_labels_cannot_escape(self):
        first = state.checkpoint_save(self.root, "same")
        second = state.checkpoint_save(self.root, "same")
        self.assertNotEqual(first["checkpoint"], second["checkpoint"])
        for label in ["../escape", "/tmp/escape", "x/y", "$(touch bad)"]:
            with self.assertRaises(ValueError):
                state.checkpoint_save(self.root, label)

    def test_checkpoint_preserves_empty_task_directories_and_executable_mode(self):
        (self.root / "tasks/task-01/figures").mkdir(parents=True)
        script = self.root / "tasks/task-01/run.sh"
        script.write_text("#!/bin/sh\necho prepared\n")
        script.chmod(0o750)
        snapshot = state.checkpoint_save(self.root, "modes")
        script.chmod(0o600)
        state.checkpoint_restore(self.root, snapshot["checkpoint"], True)
        self.assertTrue((self.root / "tasks/task-01/figures").is_dir())
        self.assertEqual(script.stat().st_mode & 0o777, 0o750)

    def test_malicious_archive_cannot_modify_state_or_escape(self):
        (self.root / "STATE.md").write_text("unchanged")
        directory = self.root / "checkpoints"
        directory.mkdir()
        for member_name, link in [("../escape", False), ("data/overwrite", False), ("link", True)]:
            with tarfile.open(directory / "attack.tgz", "w:gz") as archive:
                member = tarfile.TarInfo(member_name)
                if link:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "../../outside"
                    archive.addfile(member)
                else:
                    member.size = 4
                    archive.addfile(member, io.BytesIO(b"evil"))
            with self.assertRaises(ValueError):
                state.checkpoint_restore(self.root, "attack.tgz", True)
            self.assertEqual((self.root / "STATE.md").read_text(), "unchanged")
            self.assertFalse((self.project / "escape").exists())

    def test_checkpoint_detects_digest_mismatch_before_mutation(self):
        (self.root / "STATE.md").write_text("unchanged")
        (self.root / "checkpoints").mkdir()
        with tarfile.open(self.root / "checkpoints/changed.tgz", "w:gz") as archive:
            for name, data in [("STATE.md", b"changed"), (state.ARCHIVE_MANIFEST, b'{"version":1,"files":{"STATE.md":"wrong"}}')]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        with self.assertRaises(ValueError):
            state.checkpoint_restore(self.root, "changed.tgz", True)
        self.assertEqual((self.root / "STATE.md").read_text(), "unchanged")

    def test_data_collision_preserves_both_originals(self):
        source = self.project / "observations.csv"
        source.write_text("first")
        first = state.register_copy(self.root, source)
        self.assertTrue(first["copied"])
        self.assertFalse(state.register_copy(self.root, source)["copied"])
        source.write_text("second")
        with self.assertRaises(ValueError):
            state.register_copy(self.root, source)
        self.assertEqual((self.root / "data/observations.csv").read_text(), "first")
        self.assertEqual(source.read_text(), "second")

    def test_optional_record_preserves_unrelated_staged_changes(self):
        subprocess.run(["git", "init", "-q", str(self.project)], check=True)
        (self.root / "config.json").write_text('{"commit_research":true}')
        (self.project / "unrelated.txt").write_text("user work")
        subprocess.run(["git", "-C", str(self.project), "add", "unrelated.txt"], check=True)
        with self.assertRaises(ValueError):
            state.record(self.root, "research", [".research/config.json"])
        result = subprocess.run(["git", "-C", str(self.project), "diff", "--cached", "--name-only"], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "unrelated.txt")


class CitationAndCoverageTests(unittest.TestCase):
    def test_one_line_and_nested_braces_are_complete(self):
        text = '@article{a, title={Analysis of {LiFePO4} battery degradation}, year={2024}}'
        cites = citations.extract_bibtex(text, "source.bib")
        self.assertEqual(len(cites), 1)
        self.assertEqual(cites[0].title, "Analysis of LiFePO4 battery degradation")
        self.assertEqual(cites[0].year, "2024")

    def test_same_title_different_year_or_doi_is_not_silently_merged(self):
        first = citations.Cite(title="Materials characterization of thin films", year="2021", doi="10.1/first")
        second = citations.Cite(title=first.title, year="2024", doi="10.1/second")
        self.assertEqual(len(citations.dedup_truncated([first, second, first])), 2)

    def test_doi_year_conflict_requires_review(self):
        original = citations.crossref_by_doi
        try:
            citations.crossref_by_doi = lambda _: {"title": ["Materials characterization of thin films"], "issued": {"date-parts": [[2024]]}}
            cite = citations.Cite(title="Materials characterization of thin films", year="2010", doi="10.1/x")
            self.assertEqual(citations.verify_one(cite, False)[0], "MISMATCH")
        finally:
            citations.crossref_by_doi = original

    def test_missing_inputs_are_coverage_failures_for_all_checkers(self):
        for script in ["check_physics", "check_scripts", "verify_citations"]:
            argv = [sys.executable, "-B", str(SCRIPTS / (script + ".py")), "--json"]
            if script == "verify_citations":
                argv.append("--offline")
            result = subprocess.run(argv + ["/definitely/missing/materials-file.py"], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(json.loads(result.stdout)["coverage"]["files_read"], 0)


class ProjectionTests(unittest.TestCase):
    def test_action_invocations_and_role_bindings_resolve_to_exported_capabilities(self):
        with tempfile.TemporaryDirectory(prefix="materials bindings ") as temp:
            for target in ["codex", "claude", "gemini"]:
                output = Path(temp) / target
                report = projection.project(target, output)
                skills = {path.parent.name for path in (output / "skills").glob("*/SKILL.md")}
                guides = list((output / "assets/actions").glob("*.md"))
                guide_text = "\n".join(path.read_text() for path in guides)
                self.assertEqual(len(report["invocations"]), 17)
                for action, invocation in report["invocations"].items():
                    if target == "codex":
                        self.assertEqual(invocation["kind"], "skill")
                        self.assertIn(invocation["name"], skills)
                        self.assertIn(f"Run {action} using the {invocation['name']} skill", guide_text)
                    else:
                        self.assertEqual(invocation["name"], f"/materio:{action}")
                        path = output / "commands" / (action + ".md") if target == "claude" else output / "commands/materio" / (action + ".toml")
                        self.assertTrue(path.is_file())
                if target == "codex":
                    self.assertNotRegex(guide_text, r"/(?:materio|wtfp):[a-z-]+")
                    self.assertIn("wtf-p action new-paper", guide_text)
                if target == "claude":
                    registered = {"materio:" + path.stem for path in (output / "agents").glob("*.md")}
                    references = set(re.findall(r"registered agent `([^`]+)`", guide_text))
                    self.assertTrue(references)
                    self.assertTrue(references.issubset(registered))
                    self.assertNotRegex(guide_text, r"(?i)\b(?:spawn|dispatch) (?:the |a fresh )?materio-[a-z-]+")
                else:
                    self.assertEqual(report["agent_bindings"], {})
                    self.assertIn("This export registers no named agents", guide_text)
                    self.assertNotRegex(guide_text, r"(?i)\b(?:spawn|dispatch) (?:the |a fresh )?materio-[a-z-]+")
                self.assertNotIn("[N+1]", guide_text)

    def test_symlinked_destination_parent_cannot_write_inside_source(self):
        with tempfile.TemporaryDirectory() as temp:
            link = Path(temp) / "source-link"
            link.symlink_to(SCRIPTS.parents[1], target_is_directory=True)
            with self.assertRaises(ValueError):
                projection.project("codex", link / "nested-export")

    def test_all_peer_packages_have_resolvable_skill_assets_and_truthful_reports(self):
        with tempfile.TemporaryDirectory(prefix="materials peers ") as temp:
            for target in ["codex", "claude", "gemini"]:
                output = Path(temp) / target
                report = projection.project(target, output)
                self.assertEqual(len(list((output / "skills").glob("*/SKILL.md"))), 6)
                self.assertEqual(len(list((output / "assets/actions").glob("*.md"))), 17)
                self.assertIn("no native write-scope", report["fleet"])
                if target == "codex":
                    self.assertEqual(json.loads((output / "plugin.json").read_text())["name"], "materio")
                if target == "claude":
                    self.assertEqual(report["agents"], 6)
                    self.assertEqual(report["commands"], 17)
                    self.assertNotIn("AskUserQuestion", (output / "agents/task-executor.md").read_text())
                if target == "gemini":
                    import tomllib
                    for path in output.rglob("*.toml"):
                        self.assertIn("prompt", tomllib.loads(path.read_text()))
                with self.assertRaises(ValueError):
                    projection.project(target, output)


if __name__ == "__main__":
    unittest.main()
