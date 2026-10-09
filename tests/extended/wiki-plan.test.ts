import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { modelWikiGenerate } from "../../src/cli/wiki-generate.js";
import type { Codewiki, CodewikiFile } from "../../src/domains/context/codewiki/schema.js";
import { runWikiGenerate } from "../../src/domains/context/wiki/generate.js";
import { readWikiMeta } from "../../src/domains/context/wiki/meta.js";
import { buildCandidatePlan, planWikiGeneration, type WikiPlan } from "../../src/domains/context/wiki/plan.js";
import {
	readAuthoredWikiPlan,
	readWikiPlanFile,
	sanitizePagePath,
	sanitizeWikiPlan,
	unclaimedCandidates,
	writeWikiPlanFile,
} from "../../src/domains/context/wiki/plan-store.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
			file("src/flow/nested/inner/first/run.py", 30_000),
			file("src/flow/nested/inner/second/run.py", 30_000),
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
			[1, 30_000],
			[1, 30_000],
		],
	);
});

test("medium uses an 8000-line minimum split trigger and preserves simple and detailed policies", () => {
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
	assert.ok(plan.pages.length <= 25);
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

test("root promotion merges a locally folded area before path allocation and reconsiders its subdivision", () => {
	for (const nested of [900, 9000]) {
		const files = [
			file("big/main.py", nested === 900 ? 100_000 : 400_000),
			file("launch.py", nested === 900 ? 9000 : 20_000),
			file("site/main.py", nested === 900 ? 3000 : 10_000),
			file("site/js/main.py", nested),
			file("site/tests/test.py", 300),
		];
		const plan = buildCandidatePlan(index(files), "medium");
		assert.equal(plan.pages.filter((page) => page.path === "site.md").length, 1);
		assert.ok(plan.pages.every((page) => page.path !== "site-2.md"));
		const site = plan.pages.find((page) => page.path === "site.md");
		assert.ok(site);
		if (nested === 900) assert.deepEqual(scopeCounts(site.intent), [3, 4200]);
		else {
			assert.deepEqual(scopeCounts(site.intent), [2, 10_300]);
			assert.ok(plan.pages.some((page) => page.path === "site/js.md"));
		}
		const owned = plan.pages.slice(1).flatMap((page) => page.sources);
		assert.equal(owned.length, files.length);
		assert.deepEqual(new Set(owned), new Set(files.map((item) => item.path)));
		assert.deepEqual(buildCandidatePlan(index([...files].reverse()), "medium"), plan);
	}
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

test("new-area admission uses saved source coverage rather than subdivision paths or eight anchors", () => {
	const files = [
		file("src/suite/main.py", 10_000),
		...Array.from({ length: 12 }, (_, child) => file(`src/suite/child-${child}/run.py`, 1000)),
	];
	const candidate = buildCandidatePlan(index(files), "medium");
	const saved: WikiPlan = {
		version: 1,
		depth: "medium",
		overview: "",
		sourceContent: Object.fromEntries(files.map((item) => [item.path, "1".repeat(64)])),
		pages: [
			{ ...pageAt(candidate, 0), status: "written", attempts: 1 },
			{
				...pageAt(candidate, 1),
				path: "suite.md",
				sources: files.slice(0, 8).map((item) => item.path),
				status: "written",
				attempts: 1,
			},
		],
	};
	assert.ok(candidate.pages.length > saved.pages.length);
	assert.deepEqual(unclaimedCandidates(saved, index(files), "medium"), []);
	assert.deepEqual(
		unclaimedCandidates(saved, index(files.map((item) => ({ ...item, loc: item.loc * 2 }))), "medium"),
		[],
	);
	const { sourceContent: _baseline, ...legacy } = saved;
	assert.deepEqual(unclaimedCandidates(legacy, index(files), "medium"), []);
	assert.deepEqual(unclaimedCandidates({ ...saved, sourceContent: {} }, index(files), "medium"), []);
	const service = file("new/service/main.py", 9000);
	const unclaimed = unclaimedCandidates(saved, index([...files, service]), "medium");
	assert.equal(unclaimed.length, 1);
	assert.deepEqual(unclaimed[0]?.sources, [service.path]);
	assert.deepEqual(scopeCounts(unclaimed[0]?.intent ?? ""), [1, service.loc]);
	assert.deepEqual(unclaimedCandidates(saved, index([...files, file("src/suite/new.py", 9000)]), "medium"), []);
	const rooted = [...files, file("main.py", 20)];
	const rootedSaved = { ...saved, sourceContent: Object.fromEntries(rooted.map((item) => [item.path, "1".repeat(64)])) };
	assert.deepEqual(unclaimedCandidates(rootedSaved, index([...rooted, file("tiny/util.py", 20)]), "medium"), []);
});

test("completed medium updates preserve coarse paths without planner dispatch until explicit replanning", async () => {
	const isolated = await isolateClioEnv("clio-coder-wiki-plan-stability-");
	try {
		const cwd = join(isolated.dir, "repo");
		const sources = ["src/suite/main.py", ...Array.from({ length: 12 }, (_, child) => `src/suite/child-${child}/run.py`)];
		for (const [position, source] of sources.entries()) {
			mkdirSync(join(cwd, source, ".."), { recursive: true });
			writeFileSync(join(cwd, source), "# source\n".repeat(position === 0 ? 10_000 : 1000));
		}
		writeFileSync(join(cwd, ".gitignore"), ".clio-coder/\n");
		for (const args of [
			["init", "-q"],
			["add", "."],
			["-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-qm", "initial"],
		])
			execFileSync("git", args, { cwd, stdio: "ignore" });
		const initial = await runWikiGenerate({
			cwd,
			model: "fixture",
			depth: "medium",
			generate(input) {
				const anchor = pageAt(input.plan, 0);
				const pages = [
					{ ...anchor, status: "written" as const, attempts: 1 },
					{
						...anchor,
						path: "suite.md",
						title: "Suite",
						sources: sources.slice(0, 8),
						status: "written" as const,
						attempts: 1,
					},
				];
				for (const page of pages)
					writeFileSync(
						join(input.outputDir, page.path),
						`---\ntitle: ${page.title}\nsources: ${JSON.stringify(page.sources)}\n---\n# ${page.title}\n\nSuite behavior.\n`,
					);
				writeWikiPlanFile(input.outputDir, { ...input.plan, pages });
			},
		});
		assert.equal(initial.pending, 0);
		let calls = 0;
		const dispatch = {
			abort() {},
			async dispatch() {
				calls++;
				assert.fail("unchanged ownership must not admit a planner or writer");
			},
		} as unknown as DispatchContract;
		const unchanged = await runWikiGenerate({
			cwd,
			model: "fixture",
			depth: "medium",
			generate: modelWikiGenerate({ dispatch }),
		});
		assert.equal(calls, 0);
		assert.equal(unchanged.pending, 0);
		assert.equal(unchanged.status, "noop");
		assert.deepEqual(
			readWikiMeta(cwd)?.plan?.pages.map((page) => page.path),
			["architecture.md", "suite.md"],
		);
		await runWikiGenerate({
			cwd,
			model: "fixture",
			depth: "medium",
			replan: true,
			generate(input) {
				assert.equal(input.resumed, false);
				assert.equal(input.replan, true);
				assert.ok(input.generation.plan.pages.length > 2);
				assert.deepEqual(
					input.plan.pages.map((page) => page.path),
					["architecture.md", "suite.md"],
				);
			},
		});
	} finally {
		isolated.restore();
	}
});

test("medium scales its split trigger with total source lines", () => {
	const fixture = index([
		file("elsewhere/large.py", 1_000_000),
		file("src/suite/alpha/run.py", 4500),
		file("src/suite/beta/run.py", 4500),
	]);
	const plan = buildCandidatePlan(fixture, "medium");
	assert.deepEqual(
		plan.pages.map((page) => page.path),
		["architecture.md", "elsewhere.md", "source.md"],
	);
	assert.deepEqual(scopeCounts(pageAt(plan, 2).intent), [2, 9000]);
});

test("medium gives the largest eligible scope the remaining split allowance", () => {
	const groups = [
		["a", 12],
		["z", 21],
	] as const;
	const files = groups.flatMap(([name, count]) =>
		Array.from({ length: count }, (_, child) => file(`src/${name}/child-${child}/run.py`, 1000)),
	);
	const plan = buildCandidatePlan(index(files), "medium");
	assert.equal(plan.pages.length, 23);
	assert.equal(plan.pages.filter((page) => page.path.startsWith("z/")).length, 21);
	assert.equal(plan.pages.filter((page) => page.path.startsWith("a/")).length, 0);
	assert.deepEqual(scopeCounts(plan.pages.find((page) => page.path === "a.md")?.intent ?? ""), [12, 12_000]);
	assert.equal(
		plan.pages.slice(1).reduce((sum, page) => sum + (scopeCounts(page.intent)[0] ?? 0), 0),
		33,
	);
	assert.deepEqual(buildCandidatePlan(index([...files].reverse()), "medium"), plan);
	assert.equal(buildCandidatePlan(index(files), "detailed").pages.length, 34);
});

test("medium bounds initial owners and rejects whole splits that cannot fit without losing files", () => {
	const files = Array.from({ length: 30 }, (_, group) => file(`src/group-${group}/main.py`, 1000));
	const plan = buildCandidatePlan(index(files), "medium");
	assert.equal(plan.pages.length, 25);
	const owned = plan.pages.slice(1).flatMap((page) => page.sources);
	assert.equal(owned.length, files.length);
	assert.deepEqual(new Set(owned), new Set(files.map((item) => item.path)));
	const wide = buildCandidatePlan(
		index(Array.from({ length: 25 }, (_, child) => file(`src/wide/child-${child}/main.py`, 1000))),
		"medium",
	);
	assert.deepEqual(
		wide.pages.map((page) => page.path),
		["architecture.md", "wide.md"],
	);
	assert.deepEqual(scopeCounts(pageAt(wide, 1).intent), [25, 25_000]);
});

test("over-limit authored medium plans retain the last plan while legacy checkpoints and detailed revisions survive", async () => {
	const isolated = await isolateClioEnv("clio-coder-wiki-plan-cap-");
	try {
		const prior = buildCandidatePlan(index([file("src/main.py", 1000)]), "medium");
		const owner = pageAt(prior, 1);
		const owners = Array.from({ length: 25 }, (_, position) => ({ ...owner, path: `area-${position}.md` }));
		const oversized = { ...prior, pages: [pageAt(prior, 0), ...owners] };
		writeWikiPlanFile(isolated.dir, oversized);
		assert.equal(readAuthoredWikiPlan(isolated.dir, prior), null);
		assert.equal(readAuthoredWikiPlan(isolated.dir, prior) ?? prior, prior);
		assert.equal(readWikiPlanFile(isolated.dir)?.pages.length, 26, "trusted legacy paths remain readable");
		assert.equal(sanitizeWikiPlan({ ...oversized, depth: "detailed" }, prior, { trustStatus: false }), null);
		assert.equal(sanitizeWikiPlan(oversized, { ...prior, depth: "detailed" }, { trustStatus: false })?.pages.length, 26);
		assert.equal(sanitizeWikiPlan({ ...oversized, pages: owners }, prior, { trustStatus: false }), null);
		writeWikiPlanFile(isolated.dir, { ...prior, pages: [pageAt(prior, 0), ...owners.slice(0, 24)] });
		assert.equal(readAuthoredWikiPlan(isolated.dir, prior)?.pages.length, 25);
	} finally {
		isolated.restore();
	}
});

test("candidate intents describe complete scope roots within the persistence limit", () => {
	const fixture = index(
		Array.from({ length: 20 }, (_, child) => file(`src/suite/long-directory-name-${child}/run.py`, 100)),
	);
	for (const depth of ["simple", "medium", "detailed"] as const) {
		const plan = buildCandidatePlan(fixture, depth);
		assert.deepEqual(sanitizeWikiPlan(plan)?.pages, plan.pages);
		for (const page of plan.pages) assert.ok(page.intent.length <= 600);
		const owner = pageAt(plan, plan.pages.length - 1);
		assert.deepEqual(scopeCounts(owner.intent), [20, 2000]);
		assert.match(owner.intent, /Assigned areas: src(?:\/suite)?\.$/u);
	}
});
