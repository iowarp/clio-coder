#!/usr/bin/env python3
"""
Unit tests for the citation verifier. No network — Crossref lookups are
monkeypatched — so these run deterministically in CI and lock in the
extraction/classification precision the tool was tuned for.

Run:  python3 tests/test_verify_citations.py     (or: python3 -m unittest)
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(_HERE, "..", "assets", "scripts",
                    "verify_citations.py")
_spec = importlib.util.spec_from_file_location("verify_citations", _MOD)
vc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vc)


def item(title, year=None, doi="10.0/x", families=()):
    d = {"title": [title], "DOI": doi,
         "author": [{"family": f} for f in families]}
    if year:
        d["issued"] = {"date-parts": [[year]]}
    return d


KEY_PAPERS_HDR = "## Key Papers\n| Paper | Year | Why Important |\n|---|---|---|\n"


class TestExtraction(unittest.TestCase):
    def test_table_row_title_extracted(self):
        md = ('## Key Papers\n'
              '| Tang M., Pistorius P.C., *Additive Manufacturing* 14 — '
              '"Prediction of lack-of-fusion porosity for powder bed fusion" '
              '| 2017 | key |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertIn("lack-of-fusion", cites[0].title)
        self.assertEqual(cites[0].year, "2017")

    def test_prose_emphasis_not_extracted(self):
        # Quoted emphasis + a citation year + a markdown italic, but no table:
        # must NOT be treated as a paper title.
        md = ('VED as a *single* design parameter was shown to "fail to '
              'capture melt-pool physics" by several groups in 2017.\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites, [])

    def test_placeholder_inline_key_detected(self):
        md = "Recent work [ML domain-discovery 2024] confirms interest.\n"
        _, placeholders = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(placeholders), 1)

    def test_bibtex_extraction(self):
        bib = ('@article{k, title={A Real Title Here}, author={Doe, Jane}, '
               'year={2020}, doi={10.1/abc}\n}\n')
        cites = vc.extract_bibtex(bib, "r.bib")
        self.assertEqual(len(cites), 1)
        self.assertEqual(cites[0].doi, "10.1/abc")

    # -- (a) truncated / prefix duplicates -----------------------------------

    def test_ellipsis_truncated_title_dropped(self):
        md = (KEY_PAPERS_HDR +
              '| "On the limitations of Volumetric Energy Density as a design '
              'parameter for Selective Laser Melting" | 2017 | x |\n'
              '\n## References\n| Ref | Year |\n|---|---|\n'
              '| "On the limitations of Volumetric Energy Density..." | 2017 |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertTrue(cites[0].title.endswith("Selective Laser Melting"))

    def test_ellipsis_title_dropped_even_without_fuller_candidate(self):
        md = ('## References\n| Ref | Year |\n|---|---|\n'
              '| "Keyhole fluctuation and pore formation mechanisms…" | 2022 |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites, [])

    def test_distinct_complete_prefix_title_preserved(self):
        md = (KEY_PAPERS_HDR +
              '| "Keyhole fluctuation and pore formation mechanisms during '
              'laser powder bed fusion" | 2022 | x |\n'
              '\n## References\n| Ref | Year |\n|---|---|\n'
              '| "Keyhole fluctuation and pore formation mechanisms" | 2022 |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual([c.title for c in cites],
                         ["Keyhole fluctuation and pore formation mechanisms "
                          "during laser powder bed fusion",
                          "Keyhole fluctuation and pore formation mechanisms"])

    def test_complete_prefix_titles_preserved_across_files(self):
        full = vc.Cite(title="A long paper title about keyhole porosity")
        short = vc.Cite(title="A long paper title about keyhole")
        other = vc.Cite(title="A different paper about lack of fusion")
        kept = vc.dedup_truncated([short, full, other])
        self.assertEqual([c.title for c in kept], [short.title, full.title, other.title])

    # -- (b) authors only from a real author list -----------------------------

    def test_authors_from_et_al_prefix(self):
        md = (KEY_PAPERS_HDR +
              '| King W.E. et al. "Observation of keyhole-mode laser melting '
              'in LPBF" | 2014 | x |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites[0].authors, "King W.E. et al.")

    def test_authors_from_surname_and_surname_prefix(self):
        md = (KEY_PAPERS_HDR +
              '| W.E. King and R. Smith, "Observation of keyhole-mode laser '
              'melting in LPBF" | 2014 | x |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites[0].authors, "W.E. King and R. Smith")

    def test_authors_from_initials_list_prefix(self):
        md = (KEY_PAPERS_HDR +
              '| Tang M., Pistorius P.C., *Additive Manufacturing* 14 — '
              '"Prediction of lack-of-fusion porosity for powder bed fusion" '
              '| 2017 | key |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites[0].authors, "Tang M., Pistorius P.C.")

    def test_title_first_row_has_no_authors(self):
        # The literature agent's usual row: the quoted title starts the cell,
        # followed by a journal. Nothing here is an author string.
        md = (KEY_PAPERS_HDR +
              '| "Assessing Volumetric Energy Density as a Predictor of '
              'Defects" (*JOM*) | 2024 | Recent, rigorous test |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertIsNone(cites[0].authors)

    def test_non_papers_table_never_derives_authors(self):
        # A year-bearing row outside the Key Papers table: the first cell is
        # prose with commas, which must not be sent to Crossref as authors.
        md = ('## Datasets\n| Source | Notes |\n|---|---|\n'
              '| Zenodo, Ti-6Al-4V | "Processing, microstructure, mechanical '
              'property dataset for LPBF" (2023) |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertIsNone(cites[0].authors)
        self.assertEqual(cites[0].year, "2023")

    # -- (c) which parts of the document are scanned --------------------------

    def test_methodological_landscape_table_ignored(self):
        md = ('## Methodological Landscape\n'
              '| Approach | Strengths | Limitations | Key Papers |\n'
              '|---|---|---|---|\n'
              '| VED maps | Simple | Non-unique | "On the limitations of '
              'Volumetric Energy Density..."; "Assessing Volumetric Energy '
              'Density as a Predictor of Defects in LPBF 316L," *JOM* 2024 |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites, [])

    def test_landscape_table_ignored_by_heading_when_no_separator(self):
        md = ('## Methodological Landscape\n'
              '| In-situ monitoring | "Keyhole fluctuation and pore formation '
              'mechanisms during LPBF" (2022) |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites, [])

    def test_other_table_row_needs_a_year(self):
        md = ('## Sources\n| Source | Detail |\n|---|---|\n'
              '| A | "A quoted phrase long enough to look like a title" |\n'
              '| B | "Another quoted phrase long enough to be a title" 2021 |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual([c.year for c in cites], ["2021"])
        self.assertIn("Another", cites[0].title)

    def test_key_papers_row_extracted_without_year(self):
        md = (KEY_PAPERS_HDR +
              '| "Review of laser powder bed fusion fabricated Ti-6Al-4V" '
              '| in press | x |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertIsNone(cites[0].year)

    def test_bibtex_block_in_markdown_extracted(self):
        md = ('## References\n```bibtex\n'
              '@article{tang2017, title={Prediction of lack-of-fusion porosity '
              'for powder bed fusion}, author={Tang, Ming}, year={2017}, '
              'doi={10.1016/j.addma.2016.12.001}\n}\n```\n'
              'Prose quoting "a phrase long enough to look like a title" in 2017.\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(len(cites), 1)
        self.assertEqual(cites[0].doi, "10.1016/j.addma.2016.12.001")
        self.assertEqual(cites[0].year, "2017")

    def test_year_taken_from_year_column_not_title(self):
        md = (KEY_PAPERS_HDR +
              '| "AM-Bench 2018 round-robin results for LPBF Ti-6Al-4V" '
              '| 2020 | x |\n')
        cites, _ = vc.extract_markdown(md, "x.md")
        self.assertEqual(cites[0].year, "2020")


class TestSurnames(unittest.TestCase):
    def test_surname_first_format(self):
        self.assertIn("king", vc._surnames("King W.E. et al."))

    def test_surname_last_format(self):
        self.assertIn("king", vc._surnames("W.E. King and R. Smith"))

    def test_compound_surname(self):
        s = vc._surnames("Scipioni Bertoli U. et al.")
        self.assertIn("scipioni", s)
        self.assertIn("bertoli", s)

    def test_item_surnames_tokenizes_compound(self):
        it = item("t", families=["Scipioni Bertoli"])
        surns = vc._item_surnames(it)
        self.assertIn("scipioni", surns)
        self.assertIn("bertoli", surns)


class TestClassification(unittest.TestCase):
    # Tests patch the two Crossref functions; restore them so later test
    # classes (and any other order) see the real implementations.
    def setUp(self):
        self._saved = (vc.crossref_by_title, vc.crossref_by_doi)

    def tearDown(self):
        vc.crossref_by_title, vc.crossref_by_doi = self._saved

    def _title(self, c, patch_items):
        vc.crossref_by_title = lambda *a, **k: patch_items
        return vc.verify_one(c, offline=False)

    def test_verified_exact(self):
        c = vc.Cite(title="Prediction of lack-of-fusion porosity for PBF",
                    year="2017")
        status, _ = self._title(c, [item(
            "Prediction of lack-of-fusion porosity for PBF", 2017)])
        self.assertEqual(status, "VERIFIED")

    def test_mismatch_by_year(self):
        c = vc.Cite(title="A study of grain growth in nickel alloys",
                    year="2010")
        status, d = self._title(c, [item(
            "A study of grain growth in nickel alloys", 2024)])
        self.assertEqual(status, "MISMATCH")
        self.assertIn("year", d["reason"])

    def test_not_found(self):
        c = vc.Cite(title="A totally unique fabricated paper title xyzzy")
        status, _ = self._title(c, [item("Something completely different")])
        self.assertEqual(status, "NOT_FOUND")

    def test_abbreviated_title_rescued_by_author_year(self):
        # Weak title similarity, but author surname + year corroborate.
        c = vc.Cite(
            title="Observation of keyhole-mode laser melting in LPBF",
            year="2014", authors="King W.E. et al.")
        matched = item(
            "Observation of keyhole-mode laser melting in laser "
            "powder-bed fusion additive manufacturing systems",
            2014, families=["King"])
        status, d = self._title(c, [matched])
        self.assertEqual(status, "VERIFIED")
        self.assertIn("author", d["reason"])

    def test_no_results_not_found(self):
        c = vc.Cite(title="Anything at all here")
        status, _ = self._title(c, [])
        self.assertEqual(status, "NOT_FOUND")

    def test_network_error_unverifiable(self):
        c = vc.Cite(title="Anything at all here")
        vc.crossref_by_title = lambda *a, **k: None   # None == network failure
        status, _ = vc.verify_one(c, offline=False)
        self.assertEqual(status, "UNVERIFIABLE")

    def test_other_agency_doi_is_unverifiable(self):
        c = vc.Cite(title="Paper registered by another DOI agency", doi="10.9/other")
        vc.crossref_by_doi = lambda doi: vc.DOI_ABSENT
        status, d = vc.verify_one(c, offline=False)
        self.assertEqual(status, "UNVERIFIABLE")
        self.assertIn("another registration agency", d["reason"])

    def test_offline_is_unverifiable(self):
        c = vc.Cite(title="Any title", doi="10.1/x")
        status, _ = vc.verify_one(c, offline=True)
        self.assertEqual(status, "UNVERIFIABLE")

    def test_no_title_is_unverifiable(self):
        c = vc.Cite(title=None)
        status, _ = vc.verify_one(c, offline=False)
        self.assertEqual(status, "UNVERIFIABLE")


class TestRetry(unittest.TestCase):
    """_get retries once on 429/5xx; urlopen is the only thing patched."""

    def _run(self, codes):
        import io
        import urllib.error
        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append(req.full_url)
            code = codes[len(calls) - 1]
            if code != 200:
                raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
            return io.BytesIO(b'{"message": {"items": []}}')

        saved = (vc.urllib.request.urlopen, vc.RETRY_BACKOFF)
        vc.urllib.request.urlopen, vc.RETRY_BACKOFF = fake_urlopen, 0
        try:
            return vc.crossref_by_title("Some title"), len(calls)
        finally:
            vc.urllib.request.urlopen, vc.RETRY_BACKOFF = saved

    def test_503_then_ok_is_retried(self):
        items, n = self._run([503, 200])
        self.assertEqual(items, [])
        self.assertEqual(n, 2)

    def test_429_then_ok_is_retried(self):
        items, n = self._run([429, 200])
        self.assertEqual(items, [])
        self.assertEqual(n, 2)

    def test_second_failure_is_network_error(self):
        items, n = self._run([503, 503])
        self.assertIsNone(items)
        self.assertEqual(n, 2)

    def test_404_is_not_retried(self):
        items, n = self._run([404, 200])
        self.assertIsNone(items)
        self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
