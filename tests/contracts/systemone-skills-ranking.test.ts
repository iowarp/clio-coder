import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSkillCatalogView } from "../../src/domains/resources/skills/catalog-view.js";
import type { Skill } from "../../src/domains/resources/skills/loader.js";
import type { MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";

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

const BASE = { packages: [], marketplace: [], marketplaceOffered: true, modelActivation: false, capBytes: 50 * 1024 };
const SKILLS = [skill("alpha", "One."), skill("bravo", "Two."), skill("charlie", "Three."), skill("delta", "Four.")];

/** Ready-row names in the order the listing rendered them. */
function names(text: string): string[] {
	return [...text.matchAll(/^- ([a-z-]+) \(source:/gm)].map((match) => match[1] as string);
}

describe("skills listing ranked by a decision site", () => {
	it("orders rows by score and keeps every one of them", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev/jev-latest", scores: { alpha: 0.1, bravo: 0.95, charlie: 0.4, delta: 0.8 } },
		});
		deepStrictEqual(names(view.text), ["bravo", "delta", "charlie", "alpha"]);
		strictEqual(view.total, 4);
		strictEqual(view.shown, 4);
	});

	// A skill the model cannot see is a capability it cannot ask for, so a wrong
	// judgment costs position and never visibility.
	it("never drops a row, however low it scores", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev", scores: { alpha: 0, bravo: 0, charlie: 0, delta: 1 } },
		});
		strictEqual(names(view.text).length, 4);
		strictEqual(view.total, 4);
	});

	// An unscored skill is not a low-scored skill.
	it("leaves an unscored row where the catalog put it", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev", scores: { alpha: 0.2, charlie: 0.9 } },
		});
		deepStrictEqual(names(view.text), ["charlie", "bravo", "alpha", "delta"]);
	});

	it("reads a non-finite score as an abstention rather than a zero", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev", scores: { alpha: Number.NaN, bravo: 0.1, charlie: 0.9 } },
		});
		deepStrictEqual(names(view.text), ["alpha", "charlie", "bravo", "delta"]);
	});

	// Kind order is also the order overflow drops rows in, so a highly ranked
	// marketplace row must not cost a ready skill its place on the page.
	it("ranks inside each kind and never moves a row across kinds", () => {
		const marketplace: MarketplaceSkill[] = [
			{ name: "zeta", description: "Market one.", sourceUrl: "https://example.test/zeta" } as MarketplaceSkill,
		];
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			marketplace,
			relevance: { source: "jev", scores: { zeta: 1, alpha: 0.1, bravo: 0.2 } },
		});
		strictEqual(view.text.indexOf("Marketplace (") > view.text.indexOf("Ready skills in Clio"), true);
		deepStrictEqual(names(view.text), ["bravo", "alpha", "charlie", "delta"]);
	});

	// The order changed, so the response owes the reader a reason.
	it("says the order came from a decision model, and names it", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev/jev-latest", scores: { alpha: 0.9 } },
		});
		ok(view.text.includes("Ordered by relevance to this task, judged by jev/jev-latest"));
		ok(view.text.includes("every skill is still listed"));
		strictEqual(view.rankedBy, "jev/jev-latest");
	});

	// Opt-in by absence: an unbound site changes nothing about the listing.
	it("says nothing and changes nothing when no site is bound", () => {
		const plain = buildSkillCatalogView({ ...BASE, skills: SKILLS });
		strictEqual(plain.rankedBy, null);
		strictEqual(plain.text.includes("Ordered by relevance"), false);
		deepStrictEqual(names(plain.text), ["alpha", "bravo", "charlie", "delta"]);
		const empty = buildSkillCatalogView({ ...BASE, skills: SKILLS, relevance: { source: "jev", scores: {} } });
		deepStrictEqual(names(empty.text), ["alpha", "bravo", "charlie", "delta"]);
	});

	// Ranking is what makes a bounded page carry the useful rows. It must not
	// widen the page, only change which rows reach it.
	it("changes which rows a paged listing carries, not how many", () => {
		const unranked = buildSkillCatalogView({ ...BASE, skills: SKILLS, limit: 2 });
		const ranked = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			limit: 2,
			relevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.2, charlie: 0.98, delta: 0.99 } },
		});
		deepStrictEqual(names(unranked.text), ["alpha", "bravo"]);
		deepStrictEqual(names(ranked.text), ["delta", "charlie"]);
		strictEqual(ranked.shown, unranked.shown);
		strictEqual(ranked.total, unranked.total);
		strictEqual(ranked.nextOffset, unranked.nextOffset);
		// The rows the first page gave up are still reachable at the same cursor.
		const rest = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			limit: 2,
			offset: ranked.nextOffset ?? 0,
			relevance: { source: "jev", scores: { alpha: 0.1, bravo: 0.2, charlie: 0.98, delta: 0.99 } },
		});
		deepStrictEqual(names(rest.text), ["bravo", "alpha"]);
	});

	// The slot rule holds under paging too: a scored row cannot climb past an
	// unscored one onto the first page, because that would read an abstention as
	// a judgment that the unscored skill is the less useful of the two.
	it("cannot let a scored row displace an unscored one onto the first page", () => {
		const ranked = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			limit: 2,
			relevance: { source: "jev", scores: { delta: 0.99, charlie: 0.98 } },
		});
		deepStrictEqual(names(ranked.text), ["alpha", "bravo"]);
	});

	// Ranking runs after the query so an unscored row holds its slot in the list
	// the caller is actually about to page, not in one the filter already changed.
	it("ranks the filtered rows and leaves the filter deciding membership", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: [skill("merge-one", "Worktree merge."), skill("other", "Unrelated."), skill("merge-two", "Merge again.")],
			query: "merge",
			relevance: { source: "jev", scores: { "merge-two": 0.9, "merge-one": 0.1, other: 1 } },
		});
		deepStrictEqual(names(view.text), ["merge-two", "merge-one"]);
		strictEqual(view.total, 2);
		strictEqual(view.filtered, true);
	});

	it("is a deterministic permutation for tied scores", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "jev", scores: { alpha: 0.5, bravo: 0.5, charlie: 0.5, delta: 0.5 } },
		});
		deepStrictEqual(names(view.text), ["alpha", "bravo", "charlie", "delta"]);
	});

	it("bounds the source it echoes into the footer", () => {
		const view = buildSkillCatalogView({
			...BASE,
			skills: SKILLS,
			relevance: { source: "j".repeat(500), scores: { alpha: 0.9 } },
		});
		ok((view.rankedBy?.length ?? 0) <= 64);
	});
});
