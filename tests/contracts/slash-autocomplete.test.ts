import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Skill } from "../../src/domains/resources/index.js";
import type { MarketplaceSkill } from "../../src/domains/resources/skills/marketplace.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import { commandReference, SLASH_COMMAND_GROUPS } from "../../src/interactive/slash-commands.js";

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

const INSTALLED_SKILLS: Skill[] = [
	makeSkill({
		name: "arxiv-literature",
		description: "Use when the user asks to search arXiv, summarize papers, or trace a scientific claim to sources",
	}),
	makeSkill({ name: "find-skills" }),
];
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

	it("lists every skill once a name separator follows /skill (space)", async () => {
		const suggestions = await suggestionsFor("/skill ");
		const values = (suggestions?.items ?? []).map((item) => item.value);
		ok(values.includes("skill:arxiv-literature"));
		ok(values.includes("skill:find-skills"));
	});

	it("ellipsizes skill descriptions before the 80-column popup can hard-clip them", async () => {
		const items = (await suggestionsFor("/skill "))?.items ?? [];
		const description = items.find((item) => item.value === "skill:arxiv-literature")?.description;
		ok(description);
		ok(description.endsWith("…"), description);
		ok(visibleWidth(description) <= 40, description);
		ok(!description.endsWith("summ"), description);
	});

	it("filters skill-name suggestions by the typed prefix after the separator", async () => {
		const suggestions = await suggestionsFor("/skill fi");
		const values = (suggestions?.items ?? []).map((item) => item.value);
		ok(values.includes("skill:find-skills"));
		ok(!values.includes("skill:arxiv-literature"));
	});

	it("never offers retired command aliases", async () => {
		for (const [typed, retired] of [
			["/exi", "exit"],
			["/ct", "ctx"],
			["/comp", "compact"],
			["/model", "models"],
			["/conf", "config"],
		] as const) {
			const values = ((await suggestionsFor(typed))?.items ?? []).map((item) => item.value);
			ok(!values.includes(retired), `${typed} offered retired /${retired}: ${values.join(", ")}`);
		}
		strictEqual(await suggestionsFor("/skill:fi"), null);
		strictEqual(await suggestionsFor("/skills:fi"), null);
	});

	it("presents bare slash as canonical commands ordered by command group", async () => {
		const values = ((await suggestionsFor("/"))?.items ?? []).map((item) => item.value);
		const expected = SLASH_COMMAND_GROUPS.flatMap((group) =>
			commandReference()
				.filter((command) => command.group === group)
				.map((command) => command.name),
		);
		deepStrictEqual(values, expected, "the palette contains canonical commands in group order");
		for (const retired of ["exit", "ctx", "compact", "models", "config", "skill:", "skills:"]) {
			ok(!values.includes(retired), `bare slash does not list retired /${retired}`);
		}
	});

	it("ellipsizes canonical command descriptions before the popup can hard-clip them", async () => {
		const items = (await suggestionsFor("/"))?.items ?? [];
		const descriptions = items.flatMap((item) => (item.description ? [item.description] : []));
		ok(descriptions.length > 0);
		for (const description of descriptions) {
			ok(visibleWidth(description) <= 80, `description exceeds the 80-column popup budget: ${description}`);
		}
		const truncated = descriptions.filter((description) => description.endsWith("…"));
		ok(truncated.length > 0, "the contract exercises composed-description truncation");
		for (const name of ["context", "output"]) {
			const description = items.find((item) => item.value === name)?.description;
			ok(description?.endsWith("…"), `/${name} truncation ends in an ellipsis instead of a mid-token hard clip`);
		}
	});

	it("preserves canonical subcommand argument-stem completion", async () => {
		const canonical = ((await suggestionsFor("/context in"))?.items ?? []).map((item) => item.value);
		deepStrictEqual(canonical, ["init"], "canonical subcommand stem completes");

		strictEqual(await suggestionsFor("/ctx re"), null, "retired aliases have no argument completions");
	});

	it("keeps retired colon skill prefixes out of the command list", async () => {
		const values = ((await suggestionsFor("/ski"))?.items ?? []).map((item) => item.value);
		ok(values.includes("skill"), `the canonical command is offered: ${values.join(", ")}`);
		ok(!values.includes("skill:"), `got: ${values.join(", ")}`);
		ok(!values.includes("skills:"), `got: ${values.join(", ")}`);
	});
});
