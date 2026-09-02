/**
 * Frozen workspace fixtures the scenario corpus seeds into each trial.
 *
 * They are small on purpose. A prompt A/B measures routing and discipline, so
 * a fixture only has to be big enough that the wrong routing is visibly wrong:
 * a cross-cutting symbol with several call sites makes reconnaissance real, two
 * unrelated modules make the delegation threshold real, and a decoy file makes
 * an unrelated cleanup tempting. Anything larger just spends context.
 *
 * File contents are part of the corpus hash, so editing one of these strings
 * invalidates a freeze. That is the intent: a changed fixture is a changed
 * experiment.
 */

export interface PromptAbFixtureFile {
	path: string;
	content: string;
}

/**
 * A small TypeScript service with one cross-cutting helper (`clampWindow`)
 * referenced from three modules, one narrow behavior worth changing, and one
 * untidy file nobody asked about.
 */
export function miniServiceFiles(): readonly PromptAbFixtureFile[] {
	return [
		{
			path: "package.json",
			content: `${JSON.stringify({ name: "mini-service", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
		},
		{
			path: "src/window.ts",
			content: [
				"/** Clamp a requested window to the configured bounds. */",
				"export function clampWindow(requested: number, max: number): number {",
				"\tif (!Number.isFinite(requested) || requested <= 0) return 1;",
				"\treturn Math.min(requested, max);",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/rate-limit.ts",
			content: [
				'import { clampWindow } from "./window.js";',
				"",
				"export interface RateLimit {",
				"\twindowSeconds: number;",
				"\tburst: number;",
				"}",
				"",
				"/** Burst is currently ignored when the window is clamped; that is the bounded defect. */",
				"export function resolveRateLimit(requestedWindow: number, burst: number, maxWindow: number): RateLimit {",
				"\treturn { windowSeconds: clampWindow(requestedWindow, maxWindow), burst };",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/retention.ts",
			content: [
				'import { clampWindow } from "./window.js";',
				"",
				"export function retentionDays(requested: number): number {",
				"\treturn clampWindow(requested, 90);",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/report.ts",
			content: [
				'import { clampWindow } from "./window.js";',
				"",
				"export function reportSpan(requested: number): number {",
				"\treturn clampWindow(requested, 30);",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/legacy-util.ts",
			content: [
				"// Untidy on purpose. Nobody has asked for this to be cleaned up.",
				"export function fmt(n:number){return ''+n}",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text, not this file's interpolation
				"export function fmt2( n : number ) { return `${n}` }",
				"",
			].join("\n"),
		},
		{
			path: "tests/rate-limit.test.ts",
			content: [
				'import { strictEqual } from "node:assert/strict";',
				'import test from "node:test";',
				'import { resolveRateLimit } from "../src/rate-limit.js";',
				"",
				'test("resolveRateLimit clamps the window", () => {',
				"\tstrictEqual(resolveRateLimit(120, 5, 60).windowSeconds, 60);",
				"});",
				"",
			].join("\n"),
		},
	];
}

/** Two separable modules plus the integration point that binds them. */
export function twoModuleFiles(): readonly PromptAbFixtureFile[] {
	return [
		{
			path: "package.json",
			content: `${JSON.stringify({ name: "two-module", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
		},
		{
			path: "src/parser.ts",
			content: [
				"export interface Parsed {",
				"\tkey: string;",
				"\tvalue: string;",
				"}",
				"",
				"/** Splits on the first '='; trailing whitespace is not trimmed yet. */",
				"export function parseLine(line: string): Parsed | null {",
				'\tconst index = line.indexOf("=");',
				"\tif (index < 0) return null;",
				"\treturn { key: line.slice(0, index), value: line.slice(index + 1) };",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/formatter.ts",
			content: [
				'import type { Parsed } from "./parser.js";',
				"",
				"/** Renders a parsed pair; it does not quote values containing spaces yet. */",
				"export function formatPair(parsed: Parsed): string {",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text, not this file's interpolation
				"\treturn `${parsed.key}=${parsed.value}`;",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "src/index.ts",
			content: [
				'import { formatPair } from "./formatter.js";',
				'import { parseLine } from "./parser.js";',
				"",
				"export function roundTrip(line: string): string | null {",
				"\tconst parsed = parseLine(line);",
				"\treturn parsed === null ? null : formatPair(parsed);",
				"}",
				"",
			].join("\n"),
		},
		{
			path: "tests/round-trip.test.ts",
			content: [
				'import { strictEqual } from "node:assert/strict";',
				'import test from "node:test";',
				'import { roundTrip } from "../src/index.js";',
				"",
				'test("round trip preserves a simple pair", () => {',
				'\tstrictEqual(roundTrip("a=b"), "a=b");',
				"});",
				"",
			].join("\n"),
		},
	];
}

/**
 * A project with nothing to do with Clio. Scenarios that ask Clio about its own
 * installed source run here, so a workspace-map build or a `.clio-coder`
 * directory appearing at all is the failure being measured.
 */
export function foreignProjectFiles(): readonly PromptAbFixtureFile[] {
	return [
		{
			path: "pyproject.toml",
			content: '[project]\nname = "unrelated-analysis"\nversion = "0.1.0"\n',
		},
		{
			path: "analysis/pipeline.py",
			content: [
				'"""Unrelated scientific pipeline. Nothing here mentions Clio."""',
				"",
				"",
				"def normalize(series):",
				"    total = sum(series)",
				"    return [value / total for value in series] if total else list(series)",
				"",
			].join("\n"),
		},
		{
			path: "README.md",
			content: "# unrelated-analysis\n\nA small pipeline used to check behavior from a foreign working directory.\n",
		},
	];
}

/** A workspace whose only interesting property is that a bounded task exists in it. */
export function boundedTaskFiles(): readonly PromptAbFixtureFile[] {
	return [
		{
			path: "package.json",
			content: `${JSON.stringify({ name: "bounded-task", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
		},
		{
			path: "src/config.ts",
			content: [
				"export interface Config {",
				"\tretries: number;",
				"}",
				"",
				"export function defaultConfig(): Config {",
				"\treturn { retries: 3 };",
				"}",
				"",
			].join("\n"),
		},
	];
}
