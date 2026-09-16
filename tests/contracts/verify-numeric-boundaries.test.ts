import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	compareNumeric,
	describeNumericRule,
	MAX_ULP_TOLERANCE,
	type NumericPayload,
	type NumericTolerance,
	normalizeNumericTolerance,
	parseNumericPayload,
	renderNumericReport,
	reportedNumberValue,
	ulpDistance,
} from "../../src/tools/verify/numeric.js";

/**
 * Boundary fixtures for the numeric-compare judgement. Pure: no files, no
 * processes. Each fixture names the case a scientific validator actually hits
 * (a zero reference, an overflowed measurement, a ragged array) and the exact
 * verdict the declared rule produces for it.
 */

function key(report: ReturnType<typeof compareNumeric>, name = "v") {
	const entry = report.keys.find((candidate) => candidate.key === name);
	if (entry === undefined) throw new Error(`no key ${name} in report`);
	return entry;
}

describe("numeric-compare combination rule", () => {
	const tolerance: NumericTolerance = { relative: 1e-3, absolute: 1e-6 };
	const fixtures: Array<{ label: string; actual: number; expected: number; all: boolean; any: boolean }> = [
		{ label: "both bounds hold", actual: 1.0000001, expected: 1, all: true, any: true },
		{ label: "relative holds, absolute violated", actual: 1000.5, expected: 1000, all: false, any: true },
		{ label: "absolute holds, relative violated", actual: 1e-9 + 5e-7, expected: 1e-9, all: false, any: true },
		{ label: "neither bound holds", actual: 2, expected: 1, all: false, any: false },
		{ label: "exact equality", actual: 3.5, expected: 3.5, all: true, any: true },
		{ label: "exactly at the absolute bound", actual: 1e-6, expected: 0, all: false, any: true },
	];
	for (const fixture of fixtures) {
		it(`judges ${fixture.label} under all and any`, () => {
			const all = compareNumeric({ v: fixture.actual }, { v: fixture.expected }, tolerance);
			strictEqual(all.passed, fixture.all, `all: ${fixture.label}`);
			strictEqual(all.combine, "all");
			const any = compareNumeric({ v: fixture.actual }, { v: fixture.expected }, { ...tolerance, combine: "any" });
			strictEqual(any.passed, fixture.any, `any: ${fixture.label}`);
			strictEqual(any.combine, "any");
			// The per-bound facts are identical under both rules; only the verdict differs.
			deepStrictEqual(key(any).held, key(all).held);
			deepStrictEqual(key(any).violated, key(all).violated);
			deepStrictEqual(key(all).failed, fixture.all ? [] : key(all).violated);
			deepStrictEqual(key(any).failed, fixture.any ? [] : key(any).violated);
		});
	}

	it("names the element that needed combine any as the worst, not the clean element that deviated most", () => {
		// Element 0 passes only by absolute (its relative deviation is 5e5);
		// element 1 passes both bounds yet has the larger absolute deviation.
		const actual: NumericPayload = { v: [1e-9 + 5e-4, 1000.0009] };
		const expected: NumericPayload = { v: [1e-9, 1000] };
		const any = compareNumeric(actual, expected, { relative: 1e-3, absolute: 1e-3, combine: "any" });
		strictEqual(any.passed, true);
		strictEqual(key(any).worst?.index, 0);
		deepStrictEqual(key(any).held, ["absolute"]);
		deepStrictEqual(key(any).violated, ["relative"]);
		strictEqual(
			key(any).detail,
			"v: within tolerance by absolute (relative violated), worst[0] actual=0.000500001 expected=1e-9 abs=0.0005 rel=500000 ulp=Infinity",
		);
		const all = compareNumeric(actual, expected, { relative: 1e-3, absolute: 1e-3 });
		strictEqual(all.passed, false);
		strictEqual(key(all).worst?.index, 0);
		deepStrictEqual(key(all).failed, ["relative"]);
		// A failing element outranks a passing one with a violated bound, whatever their absolute deviations.
		const failing = compareNumeric(
			{ v: [1e-9 + 5e-4, 5] },
			{ v: [1e-9, 1] },
			{ relative: 1e-3, absolute: 1e-3, combine: "any" },
		);
		strictEqual(failing.passed, false);
		strictEqual(key(failing).worst?.index, 1);
		deepStrictEqual(key(failing).failed, ["relative", "absolute"]);
		// Inside the passing-with-violations tier the larger absolute deviation is the worst.
		const tier = compareNumeric(
			{ v: [1e-9 + 5e-4, 1e-9 + 9e-4] },
			{ v: [1e-9, 1e-9] },
			{ relative: 1e-3, absolute: 1e-3, combine: "any" },
		);
		strictEqual(tier.passed, true);
		strictEqual(key(tier).worst?.index, 1);
		deepStrictEqual(key(tier).violated, ["relative"]);
	});

	it("states the effective rule in words for one, two, and three bounds", () => {
		strictEqual(describeNumericRule({ relative: 1e-6 }), "relative<=1e-6 must hold; non-finite values fail");
		strictEqual(
			describeNumericRule({ relative: 1e-6, absolute: 1e-9 }),
			"all of relative<=1e-6, absolute<=1e-9 must hold; non-finite values fail",
		);
		strictEqual(
			describeNumericRule({ relative: 1e-6, absolute: 1e-9, ulp: 4, combine: "any", nonFinite: "match" }),
			"any of relative<=1e-6, absolute<=1e-9, ulp<=4 may hold; NaN matches NaN and same-signed infinities match",
		);
		const report = compareNumeric({ v: 1 }, { v: 1 }, { ulp: 0 });
		match(
			renderNumericReport(report),
			/^numeric-compare passed: 1 key\(s\) within tolerance\nrule: ulp<=0 must hold; non-finite values fail\ntolerance: \{"ulp":0\}\n- v: within tolerance/u,
		);
	});

	it("prints every digit of an integer and drops only trailing fraction zeros in the detail line", () => {
		const spellings: Array<[number, string]> = [
			[500000, "500000"],
			[1000, "1000"],
			[0.5, "0.5"],
			[1.5e-9, "1.5e-9"],
			[1e6, "1e+6"],
			[123456789, "1.23457e+8"],
		];
		for (const [value, text] of spellings) {
			const report = compareNumeric({ v: value }, { v: value }, { absolute: 0 });
			strictEqual(key(report).detail, `v: within tolerance, worst actual=${text} expected=${text} abs=0 rel=0 ulp=0`);
		}
	});

	it("does not fill defaults into the declared tolerance", () => {
		deepStrictEqual(normalizeNumericTolerance({ absolute: 1 }), { absolute: 1 });
		deepStrictEqual(normalizeNumericTolerance({ absolute: 1, combine: "all", nonFinite: "fail" }), {
			absolute: 1,
			combine: "all",
			nonFinite: "fail",
		});
		const report = compareNumeric({ v: 1 }, { v: 1 }, { absolute: 1 });
		deepStrictEqual(report.tolerance, { absolute: 1 });
		strictEqual(report.combine, "all");
		strictEqual(report.nonFinite, "fail");
	});

	it("names the field and the rule for every rejected tolerance", () => {
		const cases: Array<[unknown, string]> = [
			[{ absolute: 1, combine: "either" }, "tolerance.combine must be all or any"],
			[{ absolute: 1, combine: true }, "tolerance.combine must be all or any"],
			[{ absolute: 1, nonFinite: "ignore" }, "tolerance.nonFinite must be fail or match"],
			[{ absolute: 1, nonFinite: null }, "tolerance.nonFinite must be fail or match"],
			[{ combine: "any" }, "tolerance must name at least one of relative, absolute, or ulp"],
			[{ absolute: 1, epsilon: 1 }, "tolerance has unknown field(s): epsilon"],
			[{ relative: Number.POSITIVE_INFINITY }, "tolerance.relative must be a finite non-negative number"],
			[{ absolute: -1 }, "tolerance.absolute must be a finite non-negative number"],
			[{ ulp: 2.5 }, "tolerance.ulp must be a non-negative integer"],
			[{ ulp: Number.POSITIVE_INFINITY }, "tolerance.ulp must be a non-negative integer"],
			[{ ulp: Number.MAX_SAFE_INTEGER + 1 }, "tolerance.ulp must not exceed 9007199254740991 (Number.MAX_SAFE_INTEGER)"],
			[{ ulp: 2 ** 62 }, "tolerance.ulp must not exceed 9007199254740991 (Number.MAX_SAFE_INTEGER)"],
			[[], "tolerance must be an object with relative, absolute, or ulp"],
		];
		for (const [value, message] of cases) {
			const result = normalizeNumericTolerance(value);
			ok(result instanceof Error, JSON.stringify(value));
			strictEqual(result.message, message);
		}
		deepStrictEqual(normalizeNumericTolerance({ ulp: Number.MAX_SAFE_INTEGER }), { ulp: MAX_ULP_TOLERANCE });
	});

	it("judges every admissible ulp bound exactly at the edge of the safe-integer range", () => {
		// 4 - 2^-51 is the last double below 4; from 1 it is exactly 2^53 - 1
		// doubles away, and 4 itself is 2^53 away, past the range ulpDistance
		// can count. With the bound capped at MAX_SAFE_INTEGER the Infinity
		// sentinel fails a key only when the true distance does; the bound
		// 2^62 that would have failed 2^60 against 1 spuriously is refused
		// at normalization instead of judged.
		const edge = 4 - 2 ** -51;
		strictEqual(ulpDistance(edge, 1), Number.MAX_SAFE_INTEGER);
		strictEqual(ulpDistance(4, 1), Number.POSITIVE_INFINITY);
		const within = compareNumeric({ v: edge }, { v: 1 }, { ulp: MAX_ULP_TOLERANCE });
		strictEqual(within.passed, true);
		strictEqual(key(within).worst?.ulp, Number.MAX_SAFE_INTEGER);
		const beyond = compareNumeric({ v: 4 }, { v: 1 }, { ulp: MAX_ULP_TOLERANCE });
		strictEqual(beyond.passed, false);
		deepStrictEqual(key(beyond).failed, ["ulp"]);
		strictEqual(key(beyond).worst?.ulp, "Infinity");
		ok(normalizeNumericTolerance({ ulp: 2 ** 62 }) instanceof Error);
	});
});

describe("numeric-compare report serialization", () => {
	it("survives a JSON round trip with every non-finite value named and null kept for undefined", () => {
		const actual: NumericPayload = {
			nan: Number.NaN,
			inf: Number.POSITIVE_INFINITY,
			overflow: -Number.MAX_VALUE / 2,
			quotient: Number.MAX_VALUE,
			far: 4,
			zero: 1e-12,
			plain: 1.5,
		};
		const expected: NumericPayload = {
			nan: Number.NaN,
			inf: Number.NEGATIVE_INFINITY,
			overflow: Number.MAX_VALUE,
			quotient: Number.MIN_VALUE,
			far: 1,
			zero: 0,
			plain: 1,
		};
		const report = compareNumeric(actual, expected, { relative: 1, absolute: 1, nonFinite: "match" });
		const wire = JSON.parse(JSON.stringify(report)) as typeof report;
		deepStrictEqual(wire, report, "the report is its own wire format");
		deepStrictEqual(key(wire, "nan").worst, {
			actual: "NaN",
			expected: "NaN",
			absolute: 0,
			relative: 0,
			ulp: 0,
			nonFinite: "matched",
		});
		deepStrictEqual(key(wire, "inf").worst, {
			actual: "Infinity",
			expected: "-Infinity",
			absolute: "Infinity",
			relative: null,
			ulp: null,
			nonFinite: "mismatched",
		});
		const overflow = key(wire, "overflow").worst;
		strictEqual(overflow?.absolute, "Infinity", "a finite difference that overflows is named, not nulled");
		strictEqual(overflow?.relative, 1.5);
		strictEqual(overflow?.ulp, "Infinity");
		const quotient = key(wire, "quotient").worst;
		strictEqual(quotient?.absolute, Number.MAX_VALUE);
		strictEqual(quotient?.relative, "Infinity", "an overflowing quotient is named, not nulled");
		strictEqual(key(wire, "far").worst?.ulp, "Infinity", "a distance past the safe-integer range is named, not nulled");
		const zero = key(wire, "zero").worst;
		strictEqual(zero?.relative, null, "null still means undefined: the reference is zero");
		strictEqual(zero?.absolute, 1e-12);
		deepStrictEqual(key(wire, "plain").worst, {
			actual: 1.5,
			expected: 1,
			absolute: 0.5,
			relative: 0.5,
			ulp: 2251799813685248,
		});
		for (const [name, value] of [
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
			["-Infinity", Number.NEGATIVE_INFINITY],
			[2.5, 2.5],
		] as const) {
			ok(Object.is(reportedNumberValue(name), value), String(name));
		}
		deepStrictEqual(wire.failedKeys, ["far", "inf", "overflow", "quotient", "zero"]);
	});
});

describe("numeric-compare zero references", () => {
	it("passes an exact zero under every bound and reports relative as undefined otherwise", () => {
		const exact = compareNumeric({ v: 0 }, { v: 0 }, { relative: 0, absolute: 0, ulp: 0 });
		strictEqual(exact.passed, true);
		strictEqual(key(exact).worst?.relative, 0);
		const drift = compareNumeric({ v: 1e-12 }, { v: 0 }, { relative: 1e-3 });
		strictEqual(drift.passed, false);
		strictEqual(key(drift).worst?.relative, null);
		deepStrictEqual(key(drift).failed, ["relative"]);
		// The bit distance from zero to 1e-12 exceeds the safe-integer range, so ulp reads Infinity.
		match(key(drift).detail, /rel=undefined ulp=Infinity; relative undefined: reference is zero$/u);
	});

	it("passes a zero reference under combine any with an absolute bound and fails under all with only relative", () => {
		const any = compareNumeric({ v: 1e-12 }, { v: 0 }, { relative: 1e-3, absolute: 1e-9, combine: "any" });
		strictEqual(any.passed, true);
		deepStrictEqual(key(any).held, ["absolute"]);
		deepStrictEqual(key(any).violated, ["relative"]);
		match(
			key(any).detail,
			/^v: within tolerance by absolute \(relative violated\), worst .*; relative undefined: reference is zero$/u,
		);
		const all = compareNumeric({ v: 1e-12 }, { v: 0 }, { relative: 1e-3, absolute: 1e-9 });
		strictEqual(all.passed, false);
		deepStrictEqual(key(all).failed, ["relative"]);
		const relativeOnly = compareNumeric({ v: 1e-12 }, { v: 0 }, { relative: 1e-3, combine: "any" });
		strictEqual(relativeOnly.passed, false, "any over a single undefined relative bound has nothing to hold");
		deepStrictEqual(key(relativeOnly).failed, ["relative"]);
	});

	it("keeps a zero actual against a nonzero reference on the ordinary relative path", () => {
		const report = compareNumeric({ v: 0 }, { v: 2 }, { relative: 1 });
		strictEqual(report.passed, true);
		strictEqual(key(report).worst?.relative, 1);
		strictEqual(compareNumeric({ v: 0 }, { v: 2 }, { relative: 1 - Number.EPSILON }).passed, false);
	});
});

describe("numeric-compare non-finite policy", () => {
	const nan = Number.NaN;
	const inf = Number.POSITIVE_INFINITY;
	const ninf = Number.NEGATIVE_INFINITY;
	const pairings: Array<[string, number, number, boolean]> = [
		["NaN against NaN", nan, nan, true],
		["+Infinity against +Infinity", inf, inf, true],
		["-Infinity against -Infinity", ninf, ninf, true],
		["+Infinity against -Infinity", inf, ninf, false],
		["-Infinity against +Infinity", ninf, inf, false],
		["NaN against +Infinity", nan, inf, false],
		["+Infinity against NaN", inf, nan, false],
		["NaN against a finite value", nan, 1, false],
		["a finite value against NaN", 1, nan, false],
		["+Infinity against a finite value", inf, 1, false],
		["a finite value against -Infinity", 1, ninf, false],
		["+Infinity against MAX_VALUE", inf, Number.MAX_VALUE, false],
	];
	// Every bound is generous, so a failure here is the policy, never a bound.
	const generous: NumericTolerance = { relative: 1e9, absolute: Number.MAX_VALUE, ulp: Number.MAX_SAFE_INTEGER };
	for (const [label, actual, expected, matches] of pairings) {
		it(`fails ${label} under fail and ${matches ? "matches" : "fails"} it under match`, () => {
			const fail = compareNumeric({ v: actual }, { v: expected }, generous);
			strictEqual(fail.passed, false);
			deepStrictEqual(key(fail).failed, ["not-finite"]);
			strictEqual(key(fail).worst?.nonFinite, "mismatched");
			strictEqual(key(fail).worst?.absolute, "Infinity");
			const policy = compareNumeric({ v: actual }, { v: expected }, { ...generous, nonFinite: "match" });
			strictEqual(policy.passed, matches, label);
			strictEqual(policy.nonFinite, "match");
			if (matches) {
				deepStrictEqual(key(policy).failed, []);
				strictEqual(key(policy).worst?.nonFinite, "matched");
				strictEqual(key(policy).worst?.absolute, 0);
				match(
					key(policy).detail,
					/^v: non-finite values match by policy, worst actual=(NaN|-?Infinity) expected=(NaN|-?Infinity) \(non-finite values match by policy\)$/u,
				);
			} else {
				deepStrictEqual(key(policy).failed, ["not-finite"]);
				strictEqual(key(policy).worst?.nonFinite, "mismatched");
			}
		});
	}

	it("judges a matched non-finite element beside finite elements of the same array", () => {
		const actual: NumericPayload = { v: [1, nan, inf, 2.5] };
		const expected: NumericPayload = { v: [1, nan, inf, 2] };
		const strict = compareNumeric(actual, expected, { absolute: 0.1, nonFinite: "match" });
		strictEqual(strict.passed, false, "the finite element is still out of tolerance");
		strictEqual(key(strict).worst?.index, 3);
		deepStrictEqual(key(strict).failed, ["absolute"]);
		const loose = compareNumeric(actual, expected, { absolute: 1, nonFinite: "match" });
		strictEqual(loose.passed, true);
		strictEqual(key(loose).worst?.index, 3, "the worst finite deviation still names the array position");
		const defaultPolicy = compareNumeric(actual, expected, { absolute: 1 });
		strictEqual(defaultPolicy.passed, false);
		deepStrictEqual(key(defaultPolicy).failed, ["not-finite"]);
		strictEqual(key(defaultPolicy).worst?.index, 1, "the first non-finite element is the worst under fail");
	});

	it("receives an overflowed JSON literal as infinity and never NaN", () => {
		// JSON has no NaN spelling; JSON.parse maps 1e999 to Infinity, so a
		// validator that prints an overflowed measurement reaches the comparator
		// with an infinity and the nonFinite policy decides the verdict.
		const overflow = parseNumericPayload('{"v": 1e999, "w": [-1e999]}', "command output");
		ok(!(overflow instanceof Error));
		strictEqual(overflow.v, Number.POSITIVE_INFINITY);
		deepStrictEqual(overflow.w, [Number.NEGATIVE_INFINITY]);
		const reference = parseNumericPayload('{"v": 1e999, "w": [-1e999]}', "reference");
		ok(!(reference instanceof Error));
		strictEqual(compareNumeric(overflow, reference, { absolute: 0 }).passed, false);
		strictEqual(compareNumeric(overflow, reference, { absolute: 0, nonFinite: "match" }).passed, true);
		const notJson = parseNumericPayload('{"v": NaN}', "command output");
		ok(notJson instanceof Error);
		match(notJson.message, /^command output is not valid JSON: /u);
	});
});

describe("numeric-compare shapes and missing values", () => {
	it("passes empty arrays on both sides and fails an empty array against a filled one", () => {
		const empty = compareNumeric({ v: [] }, { v: [] }, { absolute: 0 });
		strictEqual(empty.passed, true);
		deepStrictEqual(key(empty), {
			key: "v",
			passed: true,
			failed: [],
			held: [],
			violated: [],
			detail: "v: empty array matches",
		});
		const filled = compareNumeric({ v: [] }, { v: [1] }, { absolute: 0 });
		strictEqual(filled.passed, false);
		deepStrictEqual(key(filled).failed, ["length-mismatch"]);
		strictEqual(key(filled).detail, "v: 0 element(s) in the command output but 1 in the reference");
	});

	it("fails a scalar against a one-element array in either direction", () => {
		const scalarVersusArray = compareNumeric({ v: 1 }, { v: [1] }, { absolute: 0 });
		deepStrictEqual(key(scalarVersusArray).failed, ["shape-mismatch"]);
		strictEqual(key(scalarVersusArray).detail, "v: scalar in the command output but array in the reference");
		const arrayVersusScalar = compareNumeric({ v: [1] }, { v: 1 }, { absolute: 0 });
		deepStrictEqual(key(arrayVersusScalar).failed, ["shape-mismatch"]);
		strictEqual(key(arrayVersusScalar).detail, "v: array in the command output but scalar in the reference");
		strictEqual(key(arrayVersusScalar).worst, undefined, "nothing was comparable");
	});

	it("reports one-element arrays without an index and longer arrays with the worst index", () => {
		const single = compareNumeric({ v: [1.5] }, { v: [1] }, { absolute: 0.1 });
		strictEqual(key(single).worst?.index, undefined);
		match(key(single).detail, /^v: failed absolute at worst actual=1\.5 expected=1 abs=0\.5/u);
		const ragged = compareNumeric({ v: [1, 2, 3] }, { v: [1, 2] }, { absolute: 0.1 });
		deepStrictEqual(key(ragged).failed, ["length-mismatch"]);
		const worst = compareNumeric({ v: [1, 1.2, 1.5] }, { v: [1, 1, 1] }, { absolute: 0.1 });
		strictEqual(key(worst).worst?.index, 2);
		match(key(worst).detail, /^v: failed absolute at worst\[2\] actual=1\.5 expected=1/u);
	});

	it("fails keys missing on either side and sorts the failed keys", () => {
		const report = compareNumeric({ b: 1, c: 1 }, { a: 1, b: 1 }, { absolute: 0 });
		strictEqual(report.passed, false);
		deepStrictEqual(report.failedKeys, ["a", "c"]);
		deepStrictEqual(
			report.keys.map((entry) => [entry.key, entry.failed, entry.held, entry.violated]),
			[
				["a", ["missing-actual"], [], []],
				["b", [], ["absolute"], []],
				["c", ["missing-reference"], [], []],
			],
		);
		strictEqual(report.summary, "numeric-compare failed: 2 of 3 key(s) out of tolerance (a, c)");
	});

	it("rejects null, string, boolean, nested, and mixed values, naming the key", () => {
		const cases: Array<[string, string]> = [
			['{"v": null}', "command output.v must be a number or an array of numbers"],
			['{"v": "1"}', "command output.v must be a number or an array of numbers"],
			['{"v": true}', "command output.v must be a number or an array of numbers"],
			['{"v": {"x": 1}}', "command output.v must be a number or an array of numbers"],
			['{"v": [1, null]}', "command output.v must be a number or an array of numbers"],
			['{"v": [[1]]}', "command output.v must be a number or an array of numbers"],
			["[1]", "command output must be a JSON object of string -> number | number[]"],
			["null", "command output must be a JSON object of string -> number | number[]"],
			['"1"', "command output must be a JSON object of string -> number | number[]"],
		];
		for (const [text, message] of cases) {
			const parsed = parseNumericPayload(text, "command output");
			ok(parsed instanceof Error, text);
			strictEqual(parsed.message, message);
		}
		deepStrictEqual(parseNumericPayload("{}", "command output"), {});
		strictEqual(compareNumeric({}, {}, { absolute: 0 }).passed, true);
		strictEqual(compareNumeric({}, {}, { absolute: 0 }).summary, "numeric-compare passed: 0 key(s) within tolerance");
	});
});
