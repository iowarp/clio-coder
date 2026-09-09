#!/usr/bin/env python3
"""
Unit tests for the runnable-by-construction script checker. Deterministic,
no third-party deps. Nothing is executed — only parsed.

Run:  python3 tests/test_check_scripts.py     (or: python3 -m unittest)
"""
import importlib.util
import os
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(_HERE, "..", "assets", "scripts",
                    "check_scripts.py")
_spec = importlib.util.spec_from_file_location("check_scripts", _MOD)
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)


def run_py(text, local=None):
    fnd = cs.Findings()
    cs.check_python(text, "t.py", fnd, local or set())
    return fnd


class TestStdlibFallback(unittest.TestCase):
    def test_works_without_sys_stdlib_module_names(self):
        # Python < 3.10 has no sys.stdlib_module_names; simulate that.
        import sys
        saved = getattr(sys, "stdlib_module_names", None)
        if saved is not None:
            del sys.stdlib_module_names
        try:
            names = cs.stdlib_names()
            self.assertTrue({"os", "sys", "json", "re", "pathlib"} <= names)
            f = run_py("import os, json\nfrom pathlib import Path\n")
            self.assertEqual(f.warnings, [])
            self.assertEqual(f.errors, [])
        finally:
            if saved is not None:
                sys.stdlib_module_names = saved

    def test_uses_sys_stdlib_module_names_when_present(self):
        import sys
        if not hasattr(sys, "stdlib_module_names"):
            self.skipTest("interpreter lacks sys.stdlib_module_names")
        self.assertEqual(cs.stdlib_names(), set(sys.stdlib_module_names))


class TestSyntax(unittest.TestCase):
    def test_syntax_error_is_error(self):
        f = run_py("def f(:\n    pass\n")
        self.assertEqual(len(f.errors), 1)
        self.assertEqual(f.errors[0][2], "syntax")

    def test_valid_is_clean(self):
        code = ("import os\nimport numpy as np\nfrom scipy import optimize\n"
                "x = np.arange(10)\nprint(os.getcwd(), optimize, x[...])\n")
        f = run_py(code)
        self.assertEqual(f.errors, [])
        self.assertEqual(f.warnings, [])


class TestImports(unittest.TestCase):
    def test_hallucinated_import_warns(self):
        f = run_py("import nummpy as np\n")
        self.assertEqual([w[2] for w in f.warnings], ["import"])

    def test_stdlib_and_known_and_local_ok(self):
        code = ("import json\nimport pymatgen\nimport helpers\n"
                "from collections import defaultdict\n")
        f = run_py(code, local={"helpers"})
        self.assertEqual(f.warnings, [])

    def test_relative_import_skipped(self):
        f = run_py("from . import sibling\nfrom .utils import thing\n")
        self.assertEqual(f.warnings, [])


class TestStubs(unittest.TestCase):
    def test_pass_only_function(self):
        f = run_py("def analyze():\n    pass\n")
        self.assertTrue(any(w[2] == "stub" for w in f.warnings))

    def test_docstring_then_pass_is_stub(self):
        f = run_py('def analyze():\n    "does things"\n    pass\n')
        self.assertTrue(any(w[2] == "stub" for w in f.warnings))

    def test_not_implemented(self):
        f = run_py("def run():\n    raise NotImplementedError\n")
        self.assertTrue(any("NotImplementedError" in w[3] for w in f.warnings))

    def test_bare_ellipsis_flagged(self):
        f = run_py("def run():\n    ...\n")
        self.assertTrue(any(w[2] == "stub" for w in f.warnings))

    def test_ellipsis_indexing_not_flagged(self):
        # numpy `a[...]` is a Subscript, not a bare Ellipsis statement.
        f = run_py("import numpy as np\na = np.zeros((2, 2))\nb = a[...]\n")
        self.assertEqual([w for w in f.warnings if w[2] == "stub"], [])

    def test_real_function_not_a_stub(self):
        f = run_py("def add(a, b):\n    return a + b\n")
        self.assertEqual(f.warnings, [])


class TestPlaceholders(unittest.TestCase):
    def test_path_placeholder(self):
        f = run_py('data = "path/to/data.csv"\n')
        self.assertTrue(any(w[2] == "placeholder" for w in f.warnings))

    def test_angle_placeholder(self):
        f = run_py('url = "http://host/<endpoint>"\n')
        self.assertTrue(any(w[2] == "placeholder" for w in f.warnings))


class TestShell(unittest.TestCase):
    def _shell(self, content):
        fnd = cs.Findings()
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as fh:
            fh.write(content)
            name = fh.name
        try:
            cs.check_shell(name, fnd)
        finally:
            os.unlink(name)
        return fnd

    def test_valid_shell_clean(self):
        f = self._shell("#!/bin/bash\nfor i in 1 2 3; do echo $i; done\n")
        self.assertEqual(f.errors, [])

    def test_broken_shell_is_error(self):
        f = self._shell("#!/bin/bash\nfor i in 1 2 3 do echo $i\n")
        self.assertEqual(len(f.errors), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
