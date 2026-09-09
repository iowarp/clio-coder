#!/usr/bin/env python3
"""
Unit tests for the physical-sanity checker. Deterministic, no network.

The most important tests are the *negative* ones: legitimately-negative or
in-range materials-science values must produce ZERO findings, because a
guardrail that cries wolf gets turned off.

Run:  python3 tests/test_check_physics.py     (or: python3 -m unittest)
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(_HERE, "..", "assets", "scripts",
                    "check_physics.py")
_spec = importlib.util.spec_from_file_location("check_physics", _MOD)
cp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cp)


def run(text):
    fnd = cp.Findings()
    for check in cp.CHECKS:
        check(text, "t.md", fnd)
    return fnd


class TestNoFalsePositives(unittest.TestCase):
    """Valid MS values, including legitimately-negative ones, must be silent."""

    CASES = [
        "DFT total energy: -8.35 eV/atom",
        "Formation enthalpy -45 kJ/mol at 0 K",
        "Residual stress -250 MPa (compressive)",
        "Ti-6Al-4V density 4.43 g/cm^3",
        "Anneal at 1200 K then 850 °C; cryogenic 77 K",
        "Relative density 99.8%, porosity 0.2%",
        "Scan window 250–300 W, hatch 5-10 µm",          # en-dash + hyphen range
        "Composition: Ti 90 wt%, Al 6 wt%, V 4 wt%",       # sums to 100
        "Volumetric energy density 105 J/mm^3",
        "Thermal expansion coefficient -1.2e-6 /K",         # negative is fine
    ]

    def test_no_findings(self):
        for text in self.CASES:
            fnd = run(text)
            self.assertEqual(fnd.errors, [], f"unexpected error for: {text}")
            self.assertEqual(fnd.warnings, [], f"unexpected warn for: {text}")


class TestTemperature(unittest.TestCase):
    def test_negative_kelvin(self):
        self.assertEqual(len(run("Cool to -5 K").errors), 1)

    def test_below_abs_zero_celsius(self):
        self.assertEqual(len(run("Bath at -300 °C").errors), 1)

    def test_implausibly_high_kelvin_warns(self):
        f = run("Furnace at 500000 K")
        self.assertEqual(f.errors, [])
        self.assertEqual(len(f.warnings), 1)

    def test_negative_rate_and_delta_not_flagged(self):
        # Temperature differences / rates / gradients are legitimately signed.
        for text in ("Cooling rate: -50 K/s during quench",
                     "Temperature change per pass: ΔT = -5 K",
                     "Thermal gradient -12 K/mm at the interface"):
            self.assertEqual(run(text).errors, [], f"false positive: {text}")

    def test_absolute_negative_kelvin_still_flagged(self):
        # No delta/rate/gradient context -> a genuine below-absolute-zero error.
        self.assertEqual(len(run("Cool the sample to -5 K").errors), 1)


class TestDensity(unittest.TestCase):
    def test_nonpositive_density(self):
        self.assertEqual(len(run("density -2.1 g/cm^3").errors), 1)
        self.assertEqual(len(run("density 0 g/cm^3").errors), 1)

    def test_kg_per_m3_normalized(self):
        # 4430 kg/m^3 == 4.43 g/cm^3 — valid, no finding.
        self.assertEqual(run("density 4430 kg/m^3").errors, [])
        self.assertEqual(run("density 4430 kg/m^3").warnings, [])

    def test_implausibly_high_warns(self):
        self.assertEqual(len(run("phase at 45 g/cm^3").warnings), 1)


class TestFractions(unittest.TestCase):
    def test_wt_percent_over_100(self):
        self.assertEqual(len(run("Cr 105 wt%").errors), 1)

    def test_bounded_bare_percent(self):
        self.assertEqual(len(run("Porosity: 120%").errors), 1)
        self.assertEqual(len(run("Impurity content -3%").errors), 1)

    def test_unbounded_bare_percent_ignored(self):
        # A bare % with no bounded-quantity keyword is not sign/range-checked.
        self.assertEqual(run("improved by 250% over baseline").errors, [])

    def test_relative_change_of_bounded_quantity_ignored(self):
        # "efficiency" is a bounded keyword, but a relative change can exceed
        # 100% and must not be flagged as impossible.
        self.assertEqual(run("Efficiency improved by 250% over baseline").errors, [])
        self.assertEqual(run("Yield increased 150% relative to control").errors, [])

    def test_absolute_bounded_percent_still_flagged(self):
        self.assertEqual(len(run("Measured porosity: 120%").errors), 1)


class TestComposition(unittest.TestCase):
    def test_inline_sums_off(self):
        f = run("Fe 70 wt%, Cr 18 wt%, Ni 9 wt%")   # 97
        self.assertEqual(len(f.warnings), 1)

    def test_inline_sums_ok(self):
        self.assertEqual(run("Ti 90 wt%, Al 6 wt%, V 4 wt%").warnings, [])

    def test_vertical_block(self):
        text = "| Fe | 70 wt% |\n| Cr | 18 wt% |\n| Ni | 9 wt% |\n"
        self.assertEqual(len(run(text).warnings), 1)

    def test_scattered_percentages_not_summed(self):
        text = ("Yield improved 40 wt% in trial one.\n\n"
                "Separately, additive was 30 wt% of the binder.\n")
        # Non-contiguous single values -> no bogus composition sum.
        self.assertEqual(run(text).warnings, [])


class TestExitAndJson(unittest.TestCase):
    def test_scan_and_counts(self):
        fnd = cp.scan([_MOD])   # scanning the source file itself: no findings
        self.assertEqual(fnd.errors, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
