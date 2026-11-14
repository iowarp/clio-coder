import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('html_scripts', Path(__file__).resolve().parents[1] / 'html_scripts.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ScriptParser = module.ScriptParser


class ScriptParserTests(unittest.TestCase):
    def scripts(self, source):
        parser = ScriptParser()
        parser.feed(source)
        parser.close()
        return parser.inline_scripts

    def test_attributed_and_uppercase_scripts_are_checked(self):
        self.assertEqual(
            self.scripts('<SCRIPT nonce="x">first()</SCRIPT><script data-note=">">second()</script >'),
            ['first()', 'second()'],
        )

    def test_external_scripts_and_jsonld_are_not_inline_code(self):
        self.assertEqual(
            self.scripts('<script src="/app.js">ignored()</script>'
                         '<script type="application/ld+json">{"@graph":[]}</script>'
                         '<script type="text/javascript; charset=utf-8">checked()</script>'),
            ['checked()'],
        )

    def test_script_bytes_and_module_bodies_are_preserved(self):
        body = '\nif (left < right && value === "&amp;") { /* <b> */ }\n'
        self.assertEqual(self.scripts(f'<script type="module">{body}</script>'), [body])


if __name__ == '__main__':
    unittest.main()
