import assert from "node:assert/strict";
import { test } from "node:test";
import type { Codewiki, CodewikiFile } from "../../src/domains/context/codewiki/schema.js";
import { buildCandidatePlan, planWikiGeneration, type WikiPlan } from "../../src/domains/context/wiki/plan.js";
import { sanitizePagePath, sanitizeWikiPlan } from "../../src/domains/context/wiki/plan-store.js";

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

test("medium recursively splits oversized scopes and folds small children into their local remainder", () => {
	const files = [
		file("src/suite/main.py", 100, "entry"),
		file("src/suite/alpha/run.py", 5000),
		file("src/suite/beta/first/run.py", 4500),
		file("src/suite/beta/second/run.py", 4500),
		file("src/suite/support/tiny.py", 100),
		file("other/large.py", 30_000),
		file("launch.py", 20),
		file("tools/helper.py", 100),
	];
	const plan = buildCandidatePlan(index(files), "medium");
	assert.deepEqual(
		plan.pages.map((page) => page.path),
		[
			"architecture.md",
			"other.md",
			"suite/alpha.md",
			"suite/beta/first.md",
			"suite/beta/second.md",
			"suite.md",
			"root.md",
		],
	);
	const suite = plan.pages.find((page) => page.path === "suite.md");
	assert.ok(suite);
	assert.deepEqual(suite.sources, ["src/suite/main.py", "src/suite/support/tiny.py"]);
	assert.deepEqual(scopeCounts(suite.intent), [2, 200]);
	assert.match(suite.intent, /src\/suite\/support/);
	const root = plan.pages.find((page) => page.path === "root.md");
	assert.ok(root);
	assert.deepEqual(scopeCounts(root.intent), [2, 120]);
	assert.deepEqual(root.sources, ["tools/helper.py", "launch.py"]);
	const owners = plan.pages.slice(1).flatMap((page) => page.sources);
	assert.equal(owners.length, files.length);
	assert.deepEqual(new Set(owners), new Set(files.map((item) => item.path)));
	assert.deepEqual(buildCandidatePlan(index([...files].reverse()), "medium"), plan);
});

test("medium child thresholds use their parent scope and skip directories without a meaningful boundary", () => {
	const plan = buildCandidatePlan(
		index([
			file("elsewhere/large.py", 1_000_000),
			file("src/flow/main.py", 34_000),
			file("src/flow/nested/inner/first/run.py", 4500),
			file("src/flow/nested/inner/second/run.py", 4500),
		]),
		"medium",
	);
	assert.deepEqual(
		plan.pages.map((page) => page.path),
		["architecture.md", "elsewhere.md", "flow.md", "flow/nested/inner/first.md", "flow/nested/inner/second.md"],
	);
	assert.deepEqual(
		plan.pages.slice(1).map((page) => scopeCounts(page.intent)),
		[
			[1, 1_000_000],
			[1, 34_000],
			[1, 4500],
			[1, 4500],
		],
	);
});

test("medium keeps the split trigger at 8000 lines and preserves simple and detailed policies", () => {
	const files = [file("src/suite/alpha/run.py", 4000), file("src/suite/beta/run.py", 4000)];
	assert.deepEqual(
		buildCandidatePlan(index(files), "medium").pages.map((page) => page.path),
		["architecture.md", "suite.md"],
	);
	const larger = index([...files, file("src/suite/main.py", 1)]);
	assert.deepEqual(
		buildCandidatePlan(larger, "medium").pages.map((page) => page.path),
		["architecture.md", "suite/alpha.md", "suite/beta.md", "suite.md"],
	);
	assert.deepEqual(
		buildCandidatePlan(larger, "simple").pages.map((page) => page.path),
		["architecture.md"],
	);
	assert.deepEqual(
		buildCandidatePlan(larger, "detailed").pages.map((page) => page.path),
		["architecture.md", "suite/alpha.md", "suite/beta.md"],
	);
});

test("medium subdivision respects the plan page limit without dropping ownership", () => {
	const files = Array.from({ length: 10 }, (_, group) =>
		Array.from({ length: 20 }, (_, child) => file(`src/group-${group}/child-${child}/run.py`, 1000)),
	).flat();
	const plan = buildCandidatePlan(index(files), "medium");
	assert.ok(plan.pages.length <= 200);
	assert.ok(plan.pages.length > 10);
	assert.deepEqual(
		plan.pages.slice(1).reduce<[number, number]>(
			(sum, page) => {
				const [count = 0, lines = 0] = scopeCounts(page.intent);
				return [sum[0] + count, sum[1] + lines];
			},
			[0, 0],
		),
		[200, 200_000],
	);
});

test("medium local remainders retain direct parent files even when children sort first", () => {
	const files = [file("big/main.py", 50_000), file("src/small/child.py", 100), file("src/main.py", 10)];
	const plan = buildCandidatePlan(index(files), "medium");
	assert.deepEqual(
		plan.pages.map((page) => page.path),
		["architecture.md", "big.md", "source.md"],
	);
	assert.deepEqual(scopeCounts(pageAt(plan, 2).intent), [2, 110]);
	assert.deepEqual(pageAt(plan, 2).sources, ["src/small/child.py", "src/main.py"]);
});

test("candidate ownership survives reserved navigation names, long paths and slug collisions", () => {
	const long = "a".repeat(210);
	for (const fixture of [
		index([file("src/pkg/index/run.py", 4500), file("src/pkg/worker/run.py", 4500)]),
		index([
			file("index/main.py", 4500),
			file("quickstart/main.py", 4500),
			file(`${long}-one/main.py`, 4500),
			file(`${long}-two/main.py`, 4500),
		]),
	]) {
		const plan = buildCandidatePlan(fixture, "medium");
		const saved = sanitizeWikiPlan(plan);
		assert.ok(saved);
		assert.deepEqual(
			saved.pages.map((page) => page.path),
			plan.pages.map((page) => page.path),
		);
		for (const page of plan.pages) assert.equal(sanitizePagePath(page.path), page.path);
		assert.equal(new Set(plan.pages.map((page) => page.path)).size, plan.pages.length);
		assert.deepEqual(
			new Set(saved.pages.slice(1).flatMap((page) => page.sources)),
			new Set(fixture.files.map((item) => item.path)),
		);
		assert.deepEqual(buildCandidatePlan(index([...fixture.files].reverse()), "medium"), plan);
	}
	assert.equal(sanitizePagePath("pkg/index.md"), null);
	assert.equal(sanitizePagePath("quickstart.md"), null);
});
