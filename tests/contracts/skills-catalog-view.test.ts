import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_SUGGESTION_ANCHOR } from "../../src/core/skill-activation.js";
import { buildSkillCatalogView, type SkillCatalogPackage } from "../../src/domains/resources/skills/catalog-view.js";
import { lexicalMatches } from "../../src/domains/resources/skills/lexical-match.js";
import type { Skill } from "../../src/domains/resources/skills/loader.js";
import type { MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";

/**
 * The skills listing: byte identity for the default view, the query filter, and
 * the page fitting that replaced whole-string head truncation.
 *
 * `renderSkillsListBeforeChange` below is the previous implementation of
 * `renderSkillsList` from src/tools/context/index.ts, copied verbatim. It is
 * the oracle: "byte-identical to what the tool emitted before" is only a real
 * assertion when the thing being compared against is the actual old code rather
 * than a description of it. Do not tidy it; its formatting is the contract.
 */

const CAP = 50 * 1024;

function skill(name: string, description: string, over: Partial<Skill> = {}): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		content: "body",
		sourceInfo: { path: `/skills/${name}/SKILL.md`, scope: "user" },
		disableModelInvocation: false,
		source: "clio-coder",
		scope: "user",
		hash: "0".repeat(64),
		normalizedHash: "0".repeat(64),
		pathSubject: name,
		trusted: true,
		precedence: 30,
		metadata: {},
		diagnostics: [],
		...over,
	} as Skill;
}

function marketplaceEntry(name: string, description: string, category?: string): MarketplaceSkill {
	return {
		kind: "skill",
		name,
		description,
		sourceUrl: `/catalog/${name}`,
		origin: "catalog",
		...(category ? { category } : {}),
	} as MarketplaceSkill;
}

function pkg(name: string): SkillCatalogPackage {
	return { name, names: [name], scope: "user", state: "ready", origin: "catalog", path: `/plugins/${name}` };
}

// ---------------------------------------------------------------------------
// The pre-change renderer, verbatim. See the file docstring.
// ---------------------------------------------------------------------------
function renderSkillsListBeforeChange(
	skills: ReadonlyArray<Skill>,
	marketplace: ReadonlyArray<MarketplaceSkill>,
	marketplaceOffered: boolean,
	modelActivation: boolean,
	packages: ReadonlyArray<SkillCatalogPackage> = [],
): string {
	if (skills.length === 0 && marketplace.length === 0 && packages.length === 0) {
		return marketplaceOffered
			? "No skills are available in Clio and no additional marketplace skills were found."
			: "No skills are available in Clio.";
	}
	const lines = ["Available skills.", ""];

	const native = skills.filter((s) => s.source === "clio-coder" || s.source === "plugin");
	const discovered = skills.filter((s) => s.source !== "clio-coder" && s.source !== "plugin");
	lines.push(`Ready skills in Clio (${native.length}):`);
	if (native.length === 0) lines.push("- none");
	for (const s of native) {
		lines.push(`- ${s.name} (source: ${s.source}; scope: ${s.scope}): ${s.description}`);
	}
	if (discovered.length > 0) {
		lines.push("", "Explicitly supplied session skills (not installed packages):");
		for (const s of discovered) {
			lines.push(`- ${s.name} (source: ${s.source}; scope: ${s.scope}; file: ${s.filePath}): ${s.description}`);
		}
		lines.push(
			"These skills were explicitly supplied for this session. Preserve their source; session availability does not mean Clio installed or copied them.",
		);
	}

	if (packages.length > 0) {
		lines.push("", `Installed packages providing skills (${packages.length}):`);
		for (const p of packages)
			lines.push(
				`- ${p.name} (scope: ${p.scope}; origin: ${p.origin === "catalog" ? "marketplace catalog" : p.origin}; state: ${p.state}; path: ${p.path})`,
			);
	}
	lines.push(
		"",
		"Other-agent skill folders are discovery-only. Explicitly import into Clio before use; the trust-imports setting does not install or activate loose files.",
	);

	if (marketplace.length > 0) {
		lines.push("", "Marketplace (additional skills available to install; /skill <name> offers to install):");
		for (const entry of marketplace) {
			const category = entry.category ? ` [${entry.category}]` : "";
			lines.push(`- ${entry.name}${category}: ${entry.description}`);
		}
	}
	lines.push(
		"",
		modelActivation
			? `If one skill above matches the current task, load it now with context(scope="skills", name="<name>") and continue in the same turn; at this autonomy level you activate installed skills yourself and do not wait for the operator. Marketplace additions still require operator approval. If none match, do not mention skills.`
			: `If one skill above matches the current task, begin your reply with the line \`${SKILL_SUGGESTION_ANCHOR}\` (a comma-separated sequence, in order, when several compose), then continue the task in the same turn without it; only the operator can run it. If none match, do not mention skills.`,
	);
	if (marketplace.length > 0) {
		lines.push(
			`When no installed skill serves the task but a marketplace skill above genuinely does, you may instead ask the operator with ask_user (mode=single_question, header "Install skill") whether to install it, offering exactly: "Install for this project", "Install globally", "Not now", "Never offer this skill". The harness handles those exact offer options. An explicit operator request or approval also authorizes the documented library install CLI. After installation, refresh the inventory; distinguish installed from ready and report /library reload when required.`,
		);
	}
	return lines.join("\n");
}

const READY = [
	skill("ship", "Use when the user wants to commit and push finished work."),
	skill("worktree-create", "Create an isolated git worktree for a branch."),
	skill("resolve-merge-conflicts", "Walk a rebase or merge conflict to resolution."),
	skill("tdd", "Write the failing test first, then the implementation."),
	skill("arxiv-literature", "Search arXiv and synthesize a literature review."),
];
const SESSION = [
	skill("foreign-helper", "A skill supplied for this session only.", {
		source: "claude",
		scope: "project",
		trusted: true,
		filePath: "/elsewhere/foreign-helper/SKILL.md",
	}),
];
const PACKAGES = [pkg("clio-skills"), pkg("wtfp")];
const MARKET = [
	marketplaceEntry("slurm-jobs", "Submit and monitor Slurm batch jobs.", "research"),
	marketplaceEntry("file-ticket", "Turn a session finding into a tracker issue.", "git"),
];

describe("contracts/skills catalog view byte identity", () => {
	const postures: Array<[string, Skill[], SkillCatalogPackage[], MarketplaceSkill[], boolean, boolean]> = [
		["ready only", READY, [], [], true, false],
		["ready plus marketplace", READY, [], MARKET, true, false],
		["everything, operator-gated", [...READY, ...SESSION], PACKAGES, MARKET, true, false],
		["everything, model activation", [...READY, ...SESSION], PACKAGES, MARKET, true, true],
		["worker: no marketplace offered", READY, [], [], false, false],
		["empty catalog, marketplace offered", [], [], [], true, false],
		["empty catalog, no marketplace", [], [], [], false, false],
		["session skills only", SESSION, [], [], true, false],
		["packages only", [], PACKAGES, [], true, false],
	];

	for (const [label, skills, packages, marketplace, offered, activation] of postures) {
		it(`renders ${label} byte-identically to the pre-change renderer`, () => {
			const view = buildSkillCatalogView({
				skills,
				packages,
				marketplace,
				marketplaceOffered: offered,
				modelActivation: activation,
				capBytes: CAP,
			});
			strictEqual(view.text, renderSkillsListBeforeChange(skills, marketplace, offered, activation, packages));
			strictEqual(view.nextOffset, undefined, "a complete listing offers no continuation");
			strictEqual(view.filtered, false);
			strictEqual(view.budgetLimited, false);
		});
	}

	it("adds no page note at all when the view hides nothing", () => {
		const view = buildSkillCatalogView({
			skills: READY,
			packages: [],
			marketplace: [],
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
		});
		ok(!view.text.includes("Showing"), "no shown/total line");
		ok(!view.text.includes("Filtered by"), "no filter line");
		ok(!view.text.includes("offset="), "no continuation line");
	});
});

describe("contracts/skills catalog view query filter", () => {
	const input = {
		skills: [...READY, ...SESSION],
		packages: PACKAGES,
		marketplace: MARKET,
		marketplaceOffered: true,
		modelActivation: false,
		capBytes: CAP,
	};

	// Authored from the catalog's own vocabulary, not from the matcher.
	const cases: Array<[string, string[]]> = [
		["worktree", ["worktree-create"]],
		["conflict", ["resolve-merge-conflicts"]],
		["tdd", ["tdd"]],
		["slurm", ["slurm-jobs"]],
		["ticket", ["file-ticket"]],
		["arxiv", ["arxiv-literature"]],
		["wtfp", ["wtfp"]],
	];

	for (const [query, expected] of cases) {
		it(`"${query}" selects exactly ${expected.join(", ")}`, () => {
			const view = buildSkillCatalogView({ ...input, query });
			deepStrictEqual(
				view.rows.map((row) => row.name),
				expected,
			);
			strictEqual(view.filtered, true);
			strictEqual(view.total, expected.length);
		});
	}

	it("keeps a short name findable even though it is under the distinctive-token floor", () => {
		// `tdd` is three characters. The promotion matcher's 4-character floor
		// would drop it, which is why the filter does not reuse that rule.
		const view = buildSkillCatalogView({ ...input, query: "tdd" });
		deepStrictEqual(
			view.rows.map((row) => row.name),
			["tdd"],
		);
	});

	it("reports a no-match query honestly instead of erroring or falling back to everything", () => {
		const view = buildSkillCatalogView({ ...input, query: "zzzznotathing" });
		strictEqual(view.total, 0);
		strictEqual(view.shown, 0);
		strictEqual(view.rows.length, 0);
		ok(view.text.includes('No skill matches "zzzznotathing"'), "names what did not match");
		ok(view.text.includes("drop query to list them"), "says how to see the rest");
		// The protocol still ships even when nothing matched.
		ok(view.text.includes(SKILL_SUGGESTION_ANCHOR), "footer survives an empty result");
	});

	it("narrows on every word first and broadens only when that would return nothing", () => {
		const strict = buildSkillCatalogView({ ...input, query: "merge conflict" });
		strictEqual(strict.matchMode, "all");
		deepStrictEqual(
			strict.rows.map((row) => row.name),
			["resolve-merge-conflicts"],
		);
		const broad = buildSkillCatalogView({ ...input, query: "please help me submit slurm batch jobs" });
		strictEqual(
			broad.matchMode,
			"any",
			"a sentence that matches nothing on `all` falls back rather than returning nothing",
		);
		ok(
			broad.rows.some((row) => row.name === "slurm-jobs"),
			"the intended skill is in the broadened result",
		);
		ok(broad.text.includes("matched on any query word"), "the payload says the filter broadened");
	});

	it("matches an installed skill's authored triggers, which nothing read before", () => {
		const triggered = skill("prototype", "Scaffold something quickly.", {
			metadata: { triggers: ["spike this out", "throwaway implementation"] },
		});
		const view = buildSkillCatalogView({
			skills: [...READY, triggered],
			packages: [],
			marketplace: [],
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
			query: "throwaway implementation",
		});
		deepStrictEqual(
			view.rows.map((row) => row.name),
			["prototype"],
		);
	});

	it("leaves an empty query indistinguishable from no query", () => {
		const bare = buildSkillCatalogView({ ...input });
		const blank = buildSkillCatalogView({ ...input, query: "   " });
		strictEqual(blank.text, bare.text);
		strictEqual(blank.filtered, false);
	});
});

describe("contracts/skills catalog view budget fitting", () => {
	// Enough rows, long enough, that the listing cannot fit a small cap.
	const many = Array.from({ length: 300 }, (_, i) =>
		skill(`skill-${String(i).padStart(3, "0")}`, `Description number ${i}. `.repeat(12)),
	);

	it("keeps the reply protocol when the page is cut, which head truncation did not", () => {
		const view = buildSkillCatalogView({
			skills: many,
			packages: [],
			marketplace: MARKET,
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: 4000,
		});
		ok(view.shown < view.total, "the page was cut");
		ok(view.budgetLimited, "cut by the budget, not by a limit");
		ok(view.text.includes(SKILL_SUGGESTION_ANCHOR), "the protocol anchor survived");
		ok(view.text.includes("did not fit this call's budget"), "the cut is stated");
		ok(Buffer.byteLength(view.text, "utf8") <= 4000, "the rendering respects the cap");

		// The behaviour this replaces: rendering whole and head-truncating drops
		// the tail, and the tail is the protocol.
		const whole = renderSkillsListBeforeChange(many, MARKET, true, false, []);
		const head = whole.slice(0, 4000);
		ok(!head.includes(SKILL_SUGGESTION_ANCHOR), "head truncation loses the anchor");
	});

	it("never renders past the cap across a range of budgets", () => {
		for (const cap of [2500, 4000, 8000, 16000, 50 * 1024]) {
			const view = buildSkillCatalogView({
				skills: many,
				packages: PACKAGES,
				marketplace: MARKET,
				marketplaceOffered: true,
				modelActivation: true,
				capBytes: cap,
			});
			ok(Buffer.byteLength(view.text, "utf8") <= cap, `cap ${cap} respected`);
			ok(view.text.includes("If one skill above matches"), `cap ${cap} kept the protocol`);
		}
	});

	it("pages to exhaustion without repeating or skipping a row", () => {
		const seen: string[] = [];
		let offset: number | undefined = 0;
		let guard = 0;
		while (offset !== undefined && guard < 100) {
			guard += 1;
			const view: ReturnType<typeof buildSkillCatalogView> = buildSkillCatalogView({
				skills: many,
				packages: PACKAGES,
				marketplace: MARKET,
				marketplaceOffered: true,
				modelActivation: false,
				capBytes: 8000,
				offset,
			});
			ok(view.shown > 0, "a page that carried nothing would be a loop");
			seen.push(...view.rows.map((row) => row.name));
			offset = view.nextOffset;
		}
		strictEqual(offset, undefined, "paging terminated");
		const total = many.length + PACKAGES.length + MARKET.length;
		strictEqual(seen.length, total, "every row was visited once");
		strictEqual(new Set(seen).size, total, "no row was repeated");
	});

	it("produces the same page for the same offset on two independent runs", () => {
		const build = () =>
			buildSkillCatalogView({
				skills: many,
				packages: PACKAGES,
				marketplace: MARKET,
				marketplaceOffered: true,
				modelActivation: false,
				capBytes: 8000,
				offset: 12,
			});
		strictEqual(build().text, build().text);
	});

	it("honours an explicit limit and clamps a silly one", () => {
		const three = buildSkillCatalogView({
			skills: many,
			packages: [],
			marketplace: [],
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
			limit: 3,
		});
		strictEqual(three.shown, 3);
		strictEqual(three.budgetLimited, false, "a limit is not a budget cut");
		strictEqual(three.nextOffset, 3);
		const clamped = buildSkillCatalogView({
			skills: many,
			packages: [],
			marketplace: [],
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
			limit: 99999,
		});
		ok(clamped.shown <= 200, "limit is clamped to the documented maximum");
	});
});

describe("contracts/skills catalog view drift visibility", () => {
	it("marks only a drifted ready row and names it once in the footer", () => {
		const view = buildSkillCatalogView({
			skills: READY,
			packages: [],
			marketplace: [],
			drifted: new Set(["ship"]),
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
		});
		ok(view.text.includes("- ship [drifted] (source: clio-coder"), "the row carries the marker");
		ok(!view.text.includes("- tdd [drifted]"), "a healthy row is untouched");
		ok(view.text.includes("Marked [drifted]: ship no longer matches"), "the footer names it");
		deepStrictEqual(view.driftedNames, ["ship"]);
		// Visibility only: still listed, still in the ready section, still present.
		ok(view.text.includes("Ready skills in Clio (5):"), "the drifted skill still counts as ready");
		strictEqual(view.rows.filter((row) => row.name === "ship").length, 1);
	});

	it("is byte-identical to the unmarked listing when nothing drifted", () => {
		const none = buildSkillCatalogView({
			skills: READY,
			packages: [],
			marketplace: [],
			drifted: new Set<string>(),
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
		});
		strictEqual(none.text, renderSkillsListBeforeChange(READY, [], true, false, []));
		deepStrictEqual(none.driftedNames, []);
	});

	it("pluralizes and keeps naming drifted rows the caller filtered to", () => {
		const view = buildSkillCatalogView({
			skills: READY,
			packages: [],
			marketplace: [],
			drifted: new Set(["ship", "tdd"]),
			marketplaceOffered: true,
			modelActivation: false,
			capBytes: CAP,
		});
		ok(view.text.includes("Marked [drifted]: ship, tdd no longer match"), view.text.slice(-400));
	});
});

describe("contracts/skills lexical matcher", () => {
	it("does not let a short query match inside a longer word", () => {
		strictEqual(lexicalMatches("git", "digital transformation", "all"), false);
		strictEqual(lexicalMatches("git", "work with git branches", "all"), true);
	});

	it("matches a token as a prefix only from three characters", () => {
		strictEqual(lexicalMatches("conflict", "resolve merge conflicts", "all"), true);
		strictEqual(lexicalMatches("wo", "worktree create", "all"), false);
		strictEqual(lexicalMatches("wor", "worktree create", "all"), true);
	});

	it("matches everything on an empty query and nothing on a stopword-only one", () => {
		strictEqual(lexicalMatches("", "anything at all", "all"), true);
		strictEqual(lexicalMatches("   ", "anything at all", "all"), true);
		strictEqual(lexicalMatches("the a an", "anything at all", "all"), false);
	});
});
