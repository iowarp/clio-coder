import assert from "node:assert/strict";
import { test } from "node:test";
import type { Codewiki, CodewikiFile } from "../../src/domains/context/codewiki/schema.js";
import { buildCandidatePlan, planWikiGeneration, type WikiPlan } from "../../src/domains/context/wiki/plan.js";

function file(path: string, loc: number, role: CodewikiFile["role"] = "module"): CodewikiFile {
	return { id: path, path, loc, role, lang: "python", hash: "fixture", imports: [] };
}

function index(files: CodewikiFile[]): Codewiki {
	return { version: 5, language: "python", files, symbols: [], edges: [] };
}

function pageAt(plan: WikiPlan, position: number) {
	const page = plan.pages[position];
	assert.ok(page);
	return page;
}

// Saved reproduction: seven indexed source files, not all 22 tracked repository files.
// test.py was indexed as a module; preserve the observed role rather than inferring it.
const slugify = index([
	file("setup.py", 84),
	file("slugify/__init__.py", 10),
	file("slugify/__main__.py", 98, "entry"),
	file("slugify/__version__.py", 8),
	file("slugify/slugify.py", 197),
	file("slugify/special.py", 47),
	file("test.py", 657),
]);

function scopeCounts(intent: string): number[] {
	const match = intent.match(/\((\d+) indexed files, (\d+) lines\)/);
	assert.ok(match, "assignment must state its indexed source count and line count");
	return [Number(match[1]), Number(match[2])];
}

test("simple combines the saved single ownership group into architecture with all ranked anchors", () => {
	const generation = planWikiGeneration(slugify);
	assert.equal(generation.depth, "simple");
	assert.equal(generation.sourceFiles, 7);
	assert.equal(generation.sourceLines, 1101);
	assert.deepEqual(
		generation.plan.pages.map((page) => page.path),
		["architecture.md"],
	);
	const page = pageAt(generation.plan, 0);
	assert.deepEqual(page.sources, [
		"slugify/__main__.py",
		"test.py",
		"slugify/slugify.py",
		"setup.py",
		"slugify/special.py",
		"slugify/__init__.py",
		"slugify/__version__.py",
	]);
	assert.deepEqual(scopeCounts(page.intent), [7, 1101]);
	assert.match(page.intent, /slugify/);
	assert.match(page.intent, /Anchors.*not the full assignment/);
	assert.ok(page.intent.length <= 600, "saved combined intent survives the existing sanitizer intact");
	assert.equal(page.status, "pending");
	assert.equal(page.attempts, 0);
});

test("empty and small indexes produce a usable simple architecture candidate", () => {
	for (const files of [[], [file("lib/tiny.py", 12)], [file("a/a.py", 12), file("b/b.py", 10)]]) {
		const plan = buildCandidatePlan(index(files), "simple");
		assert.deepEqual(
			plan.pages.map((page) => page.path),
			["architecture.md"],
		);
		assert.deepEqual(new Set(pageAt(plan, 0).sources), new Set(files.map((item) => item.path)));
	}
});

test("multiple substantial areas retain detail pages and overview links, with folded scope counted", () => {
	const plan = buildCandidatePlan(
		index([file("core/main.py", 700, "entry"), file("api/server.py", 500), file("helpers/tiny.py", 20)]),
		"simple",
	);
	assert.deepEqual(
		plan.pages.map((page) => page.path),
		["architecture.md", "core.md", "api.md"],
	);
	const overview = pageAt(plan, 0);
	const core = pageAt(plan, 1);
	const api = pageAt(plan, 2);
	assert.match(overview.intent, /composition/);
	assert.match(overview.intent, /relationships/);
	assert.match(overview.intent, /[Ll]ink/);
	assert.match(overview.intent, /area pages/);
	assert.deepEqual(core.sources, ["core/main.py", "helpers/tiny.py"]);
	assert.deepEqual(scopeCounts(core.intent), [2, 720]);
	assert.match(core.intent, /core/);
	assert.match(core.intent, /helpers/);
	assert.deepEqual(scopeCounts(api.intent), [1, 500]);
	assert.doesNotMatch(api.intent, /helpers/);
	for (const page of [core, api]) {
		assert.match(page.intent, /where .*source/);
		assert.match(page.intent, /test cases/);
		assert.doesNotMatch(page.intent, /tests that prove|an upstream caller and a downstream dependency/);
	}
});

test("assigned indexed coverage exceeds the bounded eight prompt anchors", () => {
	const files = Array.from({ length: 10 }, (_, i) => file(`core/module-${i}.py`, 100 + i));
	const config = { ...file("settings.json", 1000), lang: "config" as const, role: "config" as const };
	const generation = planWikiGeneration(index([...files, config]), "simple");
	assert.equal(generation.sourceFiles, 10);
	assert.equal(generation.sourceLines, 1045);
	assert.equal(generation.plan.pages.length, 1);
	assert.equal(pageAt(generation.plan, 0).sources.length, 8);
	assert.deepEqual(scopeCounts(pageAt(generation.plan, 0).intent), [10, 1045]);
	assert.ok(pageAt(generation.plan, 0).sources.every((path) => path.startsWith("core/")));
	const area = pageAt(buildCandidatePlan(index([...files, config]), "medium"), 1);
	assert.equal(area.sources.length, 8);
	assert.deepEqual(scopeCounts(area.intent), [10, 1045]);
	assert.match(area.intent, /Anchors.*not the full assignment/);
});

test("medium and detailed preserve the saved decomposition and a small area detail page", () => {
	for (const depth of ["medium", "detailed"] as const) {
		const plan = buildCandidatePlan(slugify, depth);
		assert.deepEqual(
			plan.pages.map((page) => page.path),
			["architecture.md", "root.md", "slugify.md"],
		);
		assert.deepEqual(pageAt(plan, 0).sources, ["slugify/__main__.py"]);
		assert.deepEqual(pageAt(plan, 1).sources, ["test.py", "setup.py"]);
		assert.equal(pageAt(plan, 2).sources.length, 5);
		assert.deepEqual(
			buildCandidatePlan(index([file("tiny.py", 10)]), depth).pages.map((page) => page.path),
			["architecture.md", "root.md"],
		);
	}
});

test("medium and detailed retain their directory granularity and minimum line thresholds", () => {
	const fixture = index([
		file("src/alpha/first/a.py", 300),
		file("src/alpha/second/b.py", 200),
		file("src/beta/first/c.py", 300),
		file("src/beta/small/d.py", 100),
	]);
	assert.deepEqual(
		buildCandidatePlan(fixture, "medium").pages.map((page) => page.path),
		["architecture.md", "alpha.md", "beta.md"],
	);
	assert.deepEqual(
		buildCandidatePlan(fixture, "detailed").pages.map((page) => page.path),
		["architecture.md", "alpha/first.md", "beta/first.md", "alpha/second.md"],
	);
});
