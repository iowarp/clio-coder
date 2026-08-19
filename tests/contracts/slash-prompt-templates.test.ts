import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/index.js";
import { createResourcesLoader } from "../../src/domains/resources/index.js";
import {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplateList,
} from "../../src/domains/resources/prompts/loader.js";
import { expandInteractiveSubmitAsync } from "../../src/interactive/index.js";
import {
	BUILTIN_SLASH_COMMANDS,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-slash-prompts-"));
	scratchRoots.push(root);
	return root;
}

function writePrompt(root: string, relative: string, body: string): void {
	const file = join(root, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, body, "utf8");
}

/** Everything the submit path reads, backed by one already-loaded template list. */
function resourcesFor(list: PromptTemplateList): ResourcesContract {
	return {
		skills: () => ({ items: [], diagnostics: [] }),
		expandSkillInvocation: (text: string) => ({ expanded: false, text, args: "", diagnostics: [] }),
		parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
		prompts: () => list,
		expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, list),
		themes: () => ({ items: [], diagnostics: [] }),
		resolvePath: (value: string) => value,
		reload: async () => undefined,
	} as unknown as ResourcesContract;
}

interface DispatchHarness {
	submitted: string[];
	notices: string[];
	opened: string[];
	ctx: SlashCommandContext;
}

function harness(list: PromptTemplateList): DispatchHarness {
	const submitted: string[] = [];
	const notices: string[] = [];
	const opened: string[] = [];
	const ctx = {
		expandPromptTemplate: (text: string) => expandPromptTemplateInput(text, list),
		listPrompts: () => list,
		submitChat: (text: string) => submitted.push(text),
		notice: (_level: string, text: string) => notices.push(text),
		openHelp: () => opened.push("help"),
		render: () => undefined,
	} as unknown as SlashCommandContext;
	return { submitted, notices, opened, ctx };
}

/**
 * `/name` is how every agent on the machine invokes the commands in the roots
 * Clio reads, and the parser answered "is not a command" for all of them: the
 * token matched no builtin, and the expansion that would have resolved it ran
 * only on the submit path the failure branch never reached. Loading the foreign
 * prompt roots bought nothing until this branch asks about them.
 */
describe("contracts/slash prompt templates", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("submits a trusted template's line so the submit path expands it", async () => {
		const home = scratchDir();
		const cwd = scratchDir();
		writePrompt(home, join(".claude", "commands", "interopdemo.md"), "Run the demo for $1.\n");
		const list = loadPromptTemplates({ cwd, home });
		const { submitted, notices, ctx } = harness(list);

		dispatchSlashCommand(parseSlashCommand("/interopdemo alpha"), ctx);

		deepStrictEqual(submitted, ["/interopdemo alpha"], "the typed line, arguments and all, reaches the submit path");
		deepStrictEqual(notices, []);
		const expanded = await expandInteractiveSubmitAsync(submitted[0] as string, resourcesFor(list), cwd);
		strictEqual(expanded.text, "Run the demo for alpha.");
	});

	it("refuses an untrusted template with the loader's reason and sends nothing to the model", () => {
		const cwd = scratchDir();
		writePrompt(cwd, join(".claude", "commands", "interopdemo.md"), "Run the demo.\n");
		const list = loadPromptTemplates({ cwd, home: scratchDir() });
		const { submitted, notices, ctx } = harness(list);

		dispatchSlashCommand(parseSlashCommand("/interopdemo"), ctx);

		strictEqual(submitted.length, 0, "an untrusted body must not become a message");
		strictEqual(notices.length, 1, notices.join(" | "));
		ok(notices[0]?.includes("untrusted project root"), notices.join(" | "));
		ok(notices[0]?.includes("skills.trustProjectCompatRoots"), notices.join(" | "));
		ok(!notices[0]?.includes("is not a command"), "the template exists; it refused");
	});

	it("keeps failing a token that names neither a command nor a template", () => {
		const list = loadPromptTemplates({ cwd: scratchDir(), home: scratchDir() });
		const { submitted, notices, ctx } = harness(list);

		dispatchSlashCommand(parseSlashCommand("/thnking"), ctx);

		strictEqual(submitted.length, 0);
		ok(notices[0]?.includes("/thnking is not a command"), notices.join(" | "));
		ok(notices[0]?.includes("/help"), notices.join(" | "));
	});

	it("reserves every builtin spelling against prompt templates in interactive and headless modes", () => {
		const cwd = scratchDir();
		const promptPath = join(".clio-coder", "prompts", "help.md");
		writePrompt(cwd, promptPath, "Not the help center.\n");
		const loader = createResourcesLoader({
			cwd,
			reservedPromptNames: new Set(BUILTIN_SLASH_COMMANDS.map((entry) => entry.name)),
		});
		const list = loader.prompts();
		const { submitted, opened, ctx } = harness(list);

		strictEqual(
			list.items.some((entry) => entry.name === "help"),
			false,
		);
		const collision = list.diagnostics.find((entry) => entry.type === "collision" && entry.path?.endsWith(promptPath));
		ok(collision?.message.includes("/help conflicts with the built-in slash command /help"), collision?.message);
		strictEqual(loader.expandPromptTemplate("/help").expanded, false, "headless expansion reserves the same name");

		dispatchSlashCommand(parseSlashCommand("/help"), ctx);

		deepStrictEqual(opened, ["help"]);
		strictEqual(submitted.length, 0);
	});
});
