import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

		const result = dispatchSlashCommand(parseSlashCommand("/interopdemo alpha"), ctx);

		strictEqual(result, "accepted");
		deepStrictEqual(submitted, ["/interopdemo alpha"], "the typed line, arguments and all, reaches the submit path");
		deepStrictEqual(notices, []);
		const expanded = await expandInteractiveSubmitAsync(submitted[0] as string, resourcesFor(list), cwd);
		strictEqual(expanded.text, "Run the demo for alpha.");
	});

	it("preserves raw $ARGUMENTS while retaining Pi positional and $@ semantics", () => {
		const root = scratchDir();
		writePrompt(
			root,
			"arguments.md",
			["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "raw=$ARGUMENTS", "parsed=$@"].join("\n"),
		);
		const list = loadPromptTemplates({ roots: [{ path: root, scope: "project", trusted: true }] });

		const expansion = expandPromptTemplateInput(
			`/arguments alpha "bravo two" charlie delta echo foxtrot golf hotel india`,
			list,
		);

		strictEqual(expansion.expanded, true);
		if (!expansion.expanded) throw new Error("expected the prompt template to expand");
		deepStrictEqual(expansion.args, [
			"alpha",
			"bravo two",
			"charlie",
			"delta",
			"echo",
			"foxtrot",
			"golf",
			"hotel",
			"india",
		]);
		strictEqual(
			expansion.text,
			[
				"alpha",
				"bravo two",
				"charlie",
				"delta",
				"echo",
				"foxtrot",
				"golf",
				"hotel",
				"india",
				'raw=alpha "bravo two" charlie delta echo foxtrot golf hotel india',
				"parsed=alpha bravo two charlie delta echo foxtrot golf hotel india",
			].join("\n"),
		);
	});

	it("keeps Pi slice semantics for templates without $ARGUMENTS", () => {
		const root = scratchDir();
		const tailPlaceholder = "$" + "{@:2}";
		const windowPlaceholder = "$" + "{@:2:2}";
		writePrompt(
			root,
			"slices.md",
			["first=$1", `tail=${tailPlaceholder}`, `window=${windowPlaceholder}`, "parsed=$@"].join("\n"),
		);
		const list = loadPromptTemplates({ roots: [{ path: root, scope: "project", trusted: true }] });

		const expansion = expandPromptTemplateInput(`/slices alpha "bravo two" charlie delta`, list);

		strictEqual(expansion.expanded, true);
		if (!expansion.expanded) throw new Error("expected the prompt template to expand");
		deepStrictEqual(expansion.args, ["alpha", "bravo two", "charlie", "delta"]);
		strictEqual(
			expansion.text,
			[
				"first=alpha",
				"tail=bravo two charlie delta",
				"window=bravo two charlie",
				"parsed=alpha bravo two charlie delta",
			].join("\n"),
		);
	});

	it("does not recursively substitute placeholder syntax inside raw $ARGUMENTS", () => {
		const root = scratchDir();
		writePrompt(root, "literal.md", ["raw=$ARGUMENTS", "first=$1"].join("\n"));
		const list = loadPromptTemplates({ roots: [{ path: root, scope: "project", trusted: true }] });

		const expansion = expandPromptTemplateInput(`/literal alpha "keep $1 exactly"`, list);

		strictEqual(expansion.expanded, true);
		if (!expansion.expanded) throw new Error("expected the prompt template to expand");
		deepStrictEqual(expansion.args, ["alpha", "keep $1 exactly"]);
		strictEqual(expansion.text, ['raw=alpha "keep $1 exactly"', "first=alpha"].join("\n"));
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
		ok(notices[0]?.includes("integrations.projectResources.trustProjectImports"), notices.join(" | "));
		ok(!notices[0]?.includes("is not a command"), "the template exists; it refused");
	});

	it("keeps failing a token that names neither a command nor a template", () => {
		const list = loadPromptTemplates({ cwd: scratchDir(), home: scratchDir() });
		const { submitted, notices, ctx } = harness(list);

		const result = dispatchSlashCommand(parseSlashCommand("/thnking"), ctx);

		strictEqual(result, "rejected");
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

/**
 * A template with one bad `${extensionRoot}` path was dropped from the list
 * entirely, so the operator's namespaced command answered "not a command" with
 * a pointer to `/help`. The correct diagnosis existed, one overlay away in
 * `/prompts`, and nothing connected the failure to it: an extension author's
 * single wrong path read to their users as "the prompt was never installed"
 * (issue #245).
 *
 * The safety half does not move. A missing or escaping reference still never
 * expands and never reads outside the package. What changed is that the
 * template loads in a refusing state, so the command is recognized and says
 * why it cannot run.
 */
describe("contracts/slash prompt templates: a template that cannot load", () => {
	/** An installed extension package with one prompt root and one template body. */
	function extensionWith(body: string): { list: PromptTemplateList; promptPath: string; packageRoot: string } {
		const packageRoot = scratchDir();
		const promptsRoot = join(packageRoot, "prompts");
		writePrompt(promptsRoot, join("wtfp", "plan-section.md"), body);
		writePrompt(packageRoot, join("core", "templates", "project.md"), "# Project template\n");
		const list = loadPromptTemplates({
			roots: [{ path: promptsRoot, rootPath: packageRoot, scope: "user", source: "wtfp", trusted: true }],
		});
		return { list, promptPath: join(promptsRoot, "wtfp", "plan-section.md"), packageRoot };
	}

	it("recognizes the command and names the file and the offending reference", () => {
		const { list, promptPath } = extensionWith(
			`Read @\${extensionRoot}/core/templates/definitely-missing.md and plan $ARGUMENTS.\n`,
		);
		const { submitted, notices, ctx } = harness(list);

		ok(
			list.items.some((entry) => entry.name === "wtfp:plan-section"),
			"the template is loaded, not dropped, so the command exists",
		);

		const result = dispatchSlashCommand(parseSlashCommand("/wtfp:plan-section significance"), ctx);

		strictEqual(result, "rejected");
		strictEqual(submitted.length, 0, "nothing reaches the model");
		strictEqual(notices.length, 1, notices.join(" | "));
		ok(!notices[0]?.includes("is not a command"), `the template exists; it refused: ${notices[0]}`);
		ok(notices[0]?.includes("/wtfp:plan-section"), notices[0]);
		ok(
			notices[0]?.includes(`\${extensionRoot}/core/templates/definitely-missing.md`),
			`the offending reference is named: ${notices[0]}`,
		);
		ok(notices[0]?.includes(promptPath), `and so is the template file: ${notices[0]}`);
	});

	it("still never expands or reads a reference that escapes the package", () => {
		const outside = scratchDir();
		const sentinel = join(outside, "outside.md");
		writeFileSync(sentinel, "SENTINEL-OUTSIDE-THE-PACKAGE\n", "utf8");
		const { list } = extensionWith(`Read @\${extensionRoot}/../outside.md and plan $ARGUMENTS.\n`);
		const { submitted, notices, ctx } = harness(list);
		const template = list.items.find((entry) => entry.name === "wtfp:plan-section");

		dispatchSlashCommand(parseSlashCommand("/wtfp:plan-section significance"), ctx);

		strictEqual(template?.content, "", "a refusing template carries no body at all");
		strictEqual(submitted.length, 0);
		ok(notices[0]?.includes(`\${extensionRoot}/../outside.md`), notices.join(" | "));
		ok(!notices.join(" ").includes("SENTINEL-OUTSIDE-THE-PACKAGE"), "the escaping path is never read");
		strictEqual(readFileSync(sentinel, "utf8"), "SENTINEL-OUTSIDE-THE-PACKAGE\n", "and never touched");
	});

	/** Not only the reference case: any load-time reason gets the same treatment. */
	it("refuses with its own reason when the template file cannot be read", () => {
		const packageRoot = scratchDir();
		const promptsRoot = join(packageRoot, "prompts");
		const file = join(promptsRoot, "wtfp", "plan-section.md");
		writePrompt(promptsRoot, join("wtfp", "plan-section.md"), "Plan $ARGUMENTS.\n");
		chmodSync(file, 0o000);
		try {
			const list = loadPromptTemplates({
				roots: [{ path: promptsRoot, rootPath: packageRoot, scope: "user", source: "wtfp", trusted: true }],
			});
			const template = list.items.find((entry) => entry.name === "wtfp:plan-section");
			if (template?.unavailable === undefined) return; // running as root; the read succeeds
			const { submitted, notices, ctx } = harness(list);

			dispatchSlashCommand(parseSlashCommand("/wtfp:plan-section"), ctx);

			strictEqual(submitted.length, 0);
			ok(!notices[0]?.includes("is not a command"), notices.join(" | "));
			ok(notices[0]?.includes("could not be read"), notices.join(" | "));
			ok(notices[0]?.includes(file), notices.join(" | "));
		} finally {
			chmodSync(file, 0o644);
		}
	});

	it("keeps the diagnostic the /prompts overlay renders, with the same words", () => {
		const { list, promptPath } = extensionWith(`Read @\${extensionRoot}/core/templates/missing.md.\n`);
		const diagnostic = list.diagnostics.find((entry) => entry.path === promptPath);
		const template = list.items.find((entry) => entry.name === "wtfp:plan-section");

		ok(diagnostic !== undefined, "the overlay's diagnostic is still produced");
		ok(
			template?.unavailable?.startsWith(diagnostic.message),
			`the refusal is the diagnostic plus the file: ${template?.unavailable}`,
		);
		ok(template?.unavailable?.includes(promptPath), template?.unavailable);
	});

	it("leaves a reference that resolves inside the package expanding as before", () => {
		const { list, packageRoot } = extensionWith(
			`Read @\${extensionRoot}/core/templates/project.md and plan $ARGUMENTS.\n`,
		);
		const { submitted, notices, ctx } = harness(list);
		const template = list.items.find((entry) => entry.name === "wtfp:plan-section");

		strictEqual(template?.unavailable, undefined);
		dispatchSlashCommand(parseSlashCommand("/wtfp:plan-section significance"), ctx);

		deepStrictEqual(notices, []);
		// The dispatcher hands the raw line to the submit path, which is where the
		// expansion happens; assert both halves rather than conflating them.
		deepStrictEqual(submitted, ["/wtfp:plan-section significance"]);
		const expansion = expandPromptTemplateInput("/wtfp:plan-section significance", list);
		strictEqual(expansion.expanded, true);
		if (!expansion.expanded) throw new Error("expected the template to expand");
		ok(expansion.text.includes(join(packageRoot, "core", "templates", "project.md")), expansion.text);
		ok(expansion.text.includes("plan significance"), expansion.text);
	});
});
