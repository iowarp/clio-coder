import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "../../src/domains/resources/index.js";
import type { MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	const base = {
		description: `${overrides.name} description`,
		filePath: `/repo/skills/${overrides.name}/SKILL.md`,
		baseDir: `/repo/skills/${overrides.name}`,
		content: `---\nname: ${overrides.name}\n---\nBody of ${overrides.name}`,
		sourceInfo: { path: `/repo/skills/${overrides.name}/SKILL.md`, scope: "project" } as Skill["sourceInfo"],
		disableModelInvocation: false,
		source: "clio" as Skill["source"],
		scope: "project" as Skill["scope"],
		hash: "0".repeat(64),
		pathSubject: `/repo/skills/${overrides.name}`,
		trusted: true,
		precedence: 0,
		metadata: {},
	};
	return { ...base, ...overrides } as Skill;
}

const INSTALLED_SKILLS: Skill[] = [makeSkill({ name: "arxiv-literature" }), makeSkill({ name: "find-skills" })];
const MARKETPLACE_SKILLS: MarketplaceSkill[] = [];

function provider() {
	return createSlashCommandAutocompleteProvider({
		basePath: process.cwd(),
		fdPath: null,
		listSkills: () => ({ installed: INSTALLED_SKILLS, marketplace: MARKETPLACE_SKILLS }),
	});
}

async function suggestionsFor(text: string) {
	const controller = new AbortController();
	return provider().getSuggestions([text], 0, text.length, { signal: controller.signal });
}

describe("contracts/slash-autocomplete", () => {
	it("does not list every skill for the bare /skill selector with nothing after it", async () => {
		// Regression for FINDINGS.md F1: a bare "/skill" used to match the
		// skill-name completion branch with an empty prefix, listing every
		// installed skill with the first pre-selected. Because the editor
		// commits the highlighted autocomplete item on the same Enter key that
		// submits a line, pressing Enter on a bare "/skill" silently invoked
		// whichever skill sorted first instead of opening the Skills Hub.
		const suggestions = await suggestionsFor("/skill");
		const skillItems = (suggestions?.items ?? []).filter(
			(item) => item.value.startsWith("skill:") || item.value.startsWith("marketplace:"),
		);
		strictEqual(skillItems.length, 0);
	});

	it("lists every skill once a name separator follows /skill (colon)", async () => {
		const suggestions = await suggestionsFor("/skill:");
		const values = (suggestions?.items ?? []).map((item) => item.value);
		ok(values.includes("skill:arxiv-literature"));
		ok(values.includes("skill:find-skills"));
	});

	it("lists every skill once a name separator follows /skill (space)", async () => {
		const suggestions = await suggestionsFor("/skill ");
		const values = (suggestions?.items ?? []).map((item) => item.value);
		ok(values.includes("skill:arxiv-literature"));
		ok(values.includes("skill:find-skills"));
	});

	it("filters skill-name suggestions by the typed prefix after the separator", async () => {
		const suggestions = await suggestionsFor("/skill:fi");
		const values = (suggestions?.items ?? []).map((item) => item.value);
		ok(values.includes("skill:find-skills"));
		ok(!values.includes("skill:arxiv-literature"));
	});

	/**
	 * An alias is a real invocation: /exit, /ctx, /compact and /models all run.
	 * Completion built its list from canonical names only, so the spelling
	 * `/help` teaches offered nothing back and read as though it did not exist.
	 */
	it("offers alias spellings, because typing one of them runs the command", async () => {
		for (const [typed, alias] of [
			["/exi", "exit"],
			["/ct", "ctx"],
			["/comp", "compact"],
			["/model", "models"],
		] as const) {
			const values = ((await suggestionsFor(typed))?.items ?? []).map((item) => item.value);
			ok(values.includes(alias), `${typed} does not offer ${alias}: ${values.join(", ")}`);
		}
	});

	it("ranks the canonical spelling above the alias that stands for it", async () => {
		const values = ((await suggestionsFor("/model"))?.items ?? []).map((item) => item.value);
		ok(values.indexOf("model") < values.indexOf("models"), `got: ${values.join(", ")}`);
	});

	// The skill branch owns everything after the colon and offers skill names
	// there. Listing the bare prefixes as commands would put two near identical
	// rows in front of it.
	it("keeps the colon skill prefixes out of the command list", async () => {
		const values = ((await suggestionsFor("/ski"))?.items ?? []).map((item) => item.value);
		ok(values.includes("skill"), `the canonical command is offered: ${values.join(", ")}`);
		ok(!values.includes("skill:"), `got: ${values.join(", ")}`);
		ok(!values.includes("skills:"), `got: ${values.join(", ")}`);
	});
});
