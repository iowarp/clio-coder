import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import {
	buildSlashAutocompleteCommands,
	createSlashCommandAutocompleteProvider,
} from "../../src/interactive/slash-autocomplete.js";
import {
	BUILTIN_SLASH_COMMANDS,
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { usageLine } from "../../src/interactive/slash-spec.js";

function splitMarkdownTableRow(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		const previous = index > 0 ? line[index - 1] : "";
		if (char === "|" && previous !== "\\") {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += char;
		}
	}
	cells.push(cell.trim());
	return cells.slice(1, -1).map((value) => value.replace(/\\\|/g, "|").replace(/`/g, ""));
}

interface CommandDocsRow {
	command: string;
	aliases: ReadonlyArray<string>;
	usage: string;
	description: string;
}

function commandDocsRows(): CommandDocsRow[] {
	const doc = readFileSync("docs/commands-and-modes.md", "utf8");
	const lines = doc.split(/\r?\n/);
	const headerIndex = lines.indexOf("| Command | Aliases | Usage | Purpose |");
	ok(headerIndex >= 0, "commands table header exists");
	const rows: CommandDocsRow[] = [];
	for (const line of lines.slice(headerIndex + 2)) {
		if (!line.startsWith("|")) break;
		const [command, aliases, usage, description] = splitMarkdownTableRow(line);
		if (command === undefined || aliases === undefined || usage === undefined || description === undefined) {
			throw new Error(`Malformed command docs row: ${line}`);
		}
		rows.push({
			command,
			aliases: aliases === "-" ? [] : aliases.split(", "),
			usage,
			description,
		});
	}
	return rows;
}

describe("contracts/slash-spec", () => {
	it("routes typed slash commands through the registry to the interactive overlay actions", () => {
		const opened: string[] = [];
		const submitted: string[] = [];
		const notices: string[] = [];
		const ctx: SlashCommandContext = {
			io: { stdout: () => undefined, stderr: () => undefined },
			notice: (_level, text) => notices.push(text),
			dispatch: {} as DispatchContract,
			bus: createSafeEventBus(),
			shutdown: () => undefined,
			runInit: () => undefined,
			runContextClear: () => undefined,
			openSkillsHub: () => opened.push("skills-hub"),
			listPrompts: () => ({ items: [], diagnostics: [] }),
			listExtensions: () => [],
			listAgents: () => [],
			listDelegationAgents: () => [],
			openProviders: () => opened.push("targets"),
			openCost: () => opened.push("cost"),
			openContextView: () => opened.push("context"),
			openFleet: () => opened.push("fleet"),
			openTasks: () => opened.push("tasks"),
			openMemory: () => opened.push("memory"),
			seedTaskMemory: () => ({ status: "seeded", seeded: 2, skipped: 1, source: "handoff-latest.md" }),
			openView: (filter) => opened.push(filter ? `view:${filter}` : "view"),
			openThinking: () => opened.push("thinking"),
			openModel: () => opened.push("model"),
			providers: {} as ProvidersContract,
			applyModelRef: () => undefined,
			openScopedModels: () => opened.push("scoped-models"),
			openSettings: () => opened.push("settings"),
			openResume: () => opened.push("resume"),
			startNewSession: () => opened.push("new"),
			openTree: () => opened.push("tree"),
			openMessagePicker: () => opened.push("fork"),
			openHelp: (query) => opened.push(query ? `help:${query}` : "help"),
			openAgents: () => opened.push("agents"),
			openPrompts: () => opened.push("prompts"),
			openExtensions: () => opened.push("extensions"),
			setEditorText: (text) => opened.push(`editor:${text}`),
			runCompact: () => undefined,
			exportTranscript: () => undefined,
			verifyReceipt: () => ({ ok: false, reason: "missing" }),
			submitChat: (text) => submitted.push(text),
			render: () => undefined,
		};

		for (const input of ["/help routing", "/settings", "/targets", "/model", "/models", "/memory", "/view run-123"]) {
			dispatchSlashCommand(parseSlashCommand(input), ctx);
		}
		dispatchSlashCommand(parseSlashCommand("/memory seed"), ctx);
		dispatchSlashCommand(parseSlashCommand("/not-a-command"), ctx);

		deepStrictEqual(opened, ["help:routing", "settings", "targets", "model", "model", "memory", "view:run-123"]);
		deepStrictEqual(submitted, ["/not-a-command"]);
		ok(notices.some((notice) => notice.includes("seeded 2 entries from handoff-latest.md; skipped 1 duplicate")));
	});

	it("parses all slash commands according to the v0.2.3 registry contract", () => {
		const testCases: Array<[string, unknown]> = [
			// Empty and whitespace inputs
			["", { kind: "empty" }],
			["   ", { kind: "empty" }],

			// quit
			["/quit", { kind: "quit" }],

			// help
			["/help", { kind: "help" }],
			["/help foo", { kind: "help", query: "foo" }],
			["/help foo bar", { kind: "help", query: "foo bar" }],

			// context init is intentionally zero-argument in the interactive surface
			["/context init", { kind: "init", options: {} }],
			["/context init   ", { kind: "init", options: {} }],
			...["--preview", "--adopt", "--apply", "--rewrite", "--propose", "--global", "--heuristic"].map(
				(flag): [string, unknown] => [`/context init ${flag}`, { kind: "unknown", text: `/context init ${flag}` }],
			),
			["/context init --include-global", { kind: "unknown", text: "/context init --include-global" }],
			["/context init --no-generate", { kind: "unknown", text: "/context init --no-generate" }],
			["/context init extra", { kind: "unknown", text: "/context init extra" }],
			["/context-init", { kind: "unknown", text: "/context-init" }],
			["/context-init --preview", { kind: "unknown", text: "/context-init --preview" }],

			// context reset is zero-argument; confirmation happens in its chooser
			["/context reset", { kind: "context-clear", options: {} }],
			["/context reset   ", { kind: "context-clear", options: {} }],
			["/context reset --all", { kind: "unknown", text: "/context reset --all" }],
			["/context reset --confirm", { kind: "unknown", text: "/context reset --confirm" }],
			["/context reset --confirm-all", { kind: "unknown", text: "/context reset --confirm-all" }],
			["/context reset --invalid", { kind: "unknown", text: "/context reset --invalid" }],
			["/context reset extra", { kind: "unknown", text: "/context reset extra" }],
			["/context-clear", { kind: "unknown", text: "/context-clear" }],
			["/context-clear --all", { kind: "unknown", text: "/context-clear --all" }],

			// context refresh (hub)
			["/context refresh", { kind: "context-refresh" }],
			["/context refresh extra", { kind: "unknown", text: "/context refresh extra" }],

			// session reset stays /new; there is deliberately no /context clear subcommand
			["/context clear", { kind: "unknown", text: "/context clear" }],

			// skill selector and invocation forms
			["/skill", { kind: "skill-selector" }],
			["/skill:", { kind: "skill-selector" }],
			["/skills:", { kind: "skill-selector" }],
			["/skill:writer draft release notes", { kind: "skill-invocation", text: "/skill:writer draft release notes" }],
			["/skills:writer draft release notes", { kind: "skill-invocation", text: "/skills:writer draft release notes" }],
			["/skill writer draft release notes", { kind: "skill-invocation", text: "/skill writer draft release notes" }],

			// /skills was absorbed into the /skill hub in v0.2.3
			["/skills", { kind: "unknown", text: "/skills" }],
			["/skills git tools", { kind: "unknown", text: "/skills git tools" }],

			// run
			["/run scout task text", { kind: "run", agentId: "scout", task: "task text", options: {} }],
			[
				"/run --worker-profile custom scout task text",
				{ kind: "run", agentId: "scout", task: "task text", options: { workerProfile: "custom" } },
			],
			[
				"/run --agent-profile custom scout task text",
				{ kind: "run", agentId: "scout", task: "task text", options: { workerProfile: "custom" } },
			],
			[
				"/run --worker custom scout task text",
				{ kind: "run", agentId: "scout", task: "task text", options: { workerProfile: "custom" } },
			],
			[
				"/run --runtime node scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerRuntime: "node" } },
			],
			[
				"/run --worker-runtime node scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerRuntime: "node" } },
			],
			[
				"/run --agent-runtime node scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerRuntime: "node" } },
			],
			[
				"/run --target myTarget scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { target: "myTarget" } },
			],
			["/run --model gpt-4 scout task", { kind: "run", agentId: "scout", task: "task", options: { model: "gpt-4" } }],
			[
				"/run --thinking high scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { thinkingLevel: "high" } },
			],
			["/run --thinking invalid scout task", { kind: "run-usage" }],
			[
				"/run --tool-profile science-local scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { toolProfile: "science-local" } },
			],
			["/run --tool-profile invalid scout task", { kind: "run-usage" }],
			[
				"/run --require a --require b scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { requiredCapabilities: ["a", "b"] } },
			],
			["/run --target a --target b scout task", { kind: "run", agentId: "scout", task: "task", options: { target: "b" } }],
			[
				"/run --agent-profile a --worker-profile b --worker c scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerProfile: "c" } },
			],
			["/run scout --target target task", { kind: "run", agentId: "scout", task: "task", options: { target: "target" } }],
			[
				"/run verifier --target dynamo inspect the project",
				{ kind: "run", agentId: "verifier", task: "inspect the project", options: { target: "dynamo" } },
			],
			[
				"/run verifier --model qwen3 --require tools inspect the project",
				{
					kind: "run",
					agentId: "verifier",
					task: "inspect the project",
					options: { model: "qwen3", requiredCapabilities: ["tools"] },
				},
			],
			["/run scout task --thinking bogus", { kind: "run", agentId: "scout", task: "task --thinking bogus", options: {} }],
			[
				"/run scout --something inside task text",
				{ kind: "run", agentId: "scout", task: "--something inside task text", options: {} },
			],
			[
				"/run scout run ls --help and report",
				{ kind: "run", agentId: "scout", task: "run ls --help and report", options: {} },
			],
			["/run", { kind: "run-usage" }],
			["/run scout", { kind: "run-usage" }],
			["/run --target", { kind: "run-usage" }],

			// delegate
			["/delegate agent task text", { kind: "delegate", agentId: "agent", task: "task text" }],
			["/delegate agent --target dynamo task", { kind: "delegate", agentId: "agent", task: "--target dynamo task" }],
			["/delegate", { kind: "delegate-usage" }],
			["/delegate agent", { kind: "delegate-usage" }],

			// share
			["/share", { kind: "share", action: "usage" }],
			["/share export /my/path", { kind: "share", action: "export", path: "/my/path" }],
			[
				"/share export /my/path extra",
				{
					kind: "share",
					action: "usage",
					subcommand: "export",
					error: "Unexpected argument: extra",
				},
			],
			[
				"/share import --dry-run /my/path",
				{ kind: "share", action: "import", path: "/my/path", dryRun: true, force: false },
			],
			[
				"/share import --force /my/path",
				{ kind: "share", action: "import", path: "/my/path", dryRun: false, force: true },
			],
			[
				"/share import --dry-run --force /my/path",
				{ kind: "share", action: "import", path: "/my/path", dryRun: true, force: true },
			],
			[
				"/share import /my/path --dry-run",
				{ kind: "share", action: "import", path: "/my/path", dryRun: true, force: false },
			],
			[
				"/share import /my/path --dry-run --force",
				{ kind: "share", action: "import", path: "/my/path", dryRun: true, force: true },
			],
			[
				"/share import --dry-run /my/path --force",
				{ kind: "share", action: "import", path: "/my/path", dryRun: true, force: true },
			],
			["/share import /my/path", { kind: "share", action: "import", path: "/my/path", dryRun: false, force: false }],
			[
				"/share import --dry-rnu /my/path",
				{ kind: "share", action: "usage", subcommand: "import", error: "Unknown flag: --dry-rnu" },
			],
			[
				"/share import /my/path extra",
				{
					kind: "share",
					action: "usage",
					subcommand: "import",
					error: "Unexpected argument: extra",
				},
			],
			["/share invalid", { kind: "share", action: "usage", error: "Unexpected argument: invalid" }],

			// view
			["/view", { kind: "view" }],
			["/view myRunId", { kind: "view", filter: "myRunId" }],
			["/view Bash npm test", { kind: "view", filter: "Bash npm test" }],
			["/view audit:session-1", { kind: "view", filter: "audit:session-1" }],
			["/view task-ledger", { kind: "view", filter: "task-ledger" }],
			[
				"/view protected-artifact:/workspace/src/locked.ts",
				{
					kind: "view",
					filter: "protected-artifact:/workspace/src/locked.ts",
				},
			],
			["/view verify myRunId", { kind: "view-verify", runId: "myRunId" }],
			["/view verify", { kind: "view-usage" }],
			["/view verify myRunId extra", { kind: "view-usage" }],

			// /receipts was absorbed into /view in v0.2.3
			["/receipts", { kind: "unknown", text: "/receipts" }],
			["/receipts verify myRunId", { kind: "unknown", text: "/receipts verify myRunId" }],

			// model
			["/model", { kind: "model" }],
			["/models", { kind: "model" }],
			["/model pattern:thinking", { kind: "model-set", pattern: "pattern:thinking" }],
			["/model provider/model:high:extra", { kind: "model-set", pattern: "provider/model:high:extra" }],
			["/models pattern:thinking", { kind: "model-set", pattern: "pattern:thinking" }],

			// context compact alone keeps its optional free-form instructions
			["/context compact", { kind: "compact", instructions: undefined }],
			["/context compact   ", { kind: "compact", instructions: undefined }],
			["/context compact my instructions", { kind: "compact", instructions: "my instructions" }],
			["/compact", { kind: "unknown", text: "/compact" }],
			["/compact my instructions", { kind: "unknown", text: "/compact my instructions" }],

			// context overlay (hub, no args); the retired spelling no longer parses
			["/context", { kind: "context-view" }],
			["/ctx", { kind: "context-view" }],
			["/context-view", { kind: "unknown", text: "/context-view" }],

			// status (deleted) -> falls through to unknown
			["/status", { kind: "unknown", text: "/status" }],

			// connect/disconnect (deleted) -> falls through to unknown
			["/connect", { kind: "unknown", text: "/connect" }],
			["/connect target-a", { kind: "unknown", text: "/connect target-a" }],
			["/disconnect", { kind: "unknown", text: "/disconnect" }],
			["/disconnect target-a", { kind: "unknown", text: "/disconnect target-a" }],

			// unknown / invalid
			["/invalid-command", { kind: "unknown", text: "/invalid-command" }],
			["/quit now", { kind: "unknown", text: "/quit now" }],
			["/prompts query", { kind: "unknown", text: "/prompts query" }],
			["/extensions query", { kind: "unknown", text: "/extensions query" }],
			["/agents query", { kind: "unknown", text: "/agents query" }],
			["/targets query", { kind: "unknown", text: "/targets query" }],
			["/cost query", { kind: "unknown", text: "/cost query" }],
			["/context query", { kind: "unknown", text: "/context query" }],
			["/fleet query", { kind: "unknown", text: "/fleet query" }],
			["/tasks query", { kind: "unknown", text: "/tasks query" }],
			["/memory", { kind: "memory" }],
			["/memory seed", { kind: "memory-seed" }],
			["/memory query", { kind: "unknown", text: "/memory query" }],
			["/thinking query", { kind: "unknown", text: "/thinking query" }],
			["/scoped-models query", { kind: "unknown", text: "/scoped-models query" }],
			["/settings query", { kind: "unknown", text: "/settings query" }],
			["/resume query", { kind: "unknown", text: "/resume query" }],
			["/new query", { kind: "unknown", text: "/new query" }],
			["/tree query", { kind: "unknown", text: "/tree query" }],
			["/fork query", { kind: "unknown", text: "/fork query" }],
			["/hotkeys query", { kind: "unknown", text: "/hotkeys query" }],
		];

		for (const [input, expected] of testCases) {
			deepStrictEqual(parseSlashCommand(input), expected, `Failed for input: "${input}"`);
		}
	});

	it("renders usageLine snapshot cases correctly", () => {
		const runEntry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "run");
		const delegateEntry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "delegate");
		const shareEntry = BUILTIN_SLASH_COMMANDS.find((e) => e.name === "share");
		ok(runEntry);
		ok(delegateEntry);
		ok(shareEntry);

		strictEqual(
			usageLine(runEntry),
			"\nusage: /run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local|science-local|full-agent>] [--require <cap>] <agent> <task>\n",
		);

		strictEqual(usageLine(delegateEntry), "\nusage: /delegate <agent-id> <task>\n");

		strictEqual(usageLine(shareEntry), "\nusage: /share export <path> | /share import [--dry-run] [--force] <path>\n");

		strictEqual(usageLine(shareEntry, "export"), "\nusage: /share export <path>\n");

		strictEqual(usageLine(shareEntry, "import"), "\nusage: /share import [--dry-run] [--force] <path>\n");
	});

	it("enforces registry integrity (no duplicate names, aliases, or kind owners)", () => {
		const terms = new Map<string, string>();
		const kinds = new Set<string>();

		for (const entry of BUILTIN_SLASH_COMMANDS) {
			for (const term of [entry.name, ...(entry.aliases ?? [])]) {
				const owner = terms.get(term);
				ok(!owner, `Command term "${term}" is owned by both "${owner}" and "${entry.name}"`);
				terms.set(term, entry.name);
			}

			for (const kind of entry.kinds) {
				ok(!kinds.has(kind), `Kind "${kind}" is owned by multiple registry entries`);
				kinds.add(kind);
			}
		}
	});

	it("locks the canonical command registry after retired context spellings are removed", () => {
		const visible = [
			"quit",
			"help",
			"skill",
			"prompts",
			"extensions",
			"share",
			"run",
			"delegate",
			"agents",
			"targets",
			"cost",
			"context",
			"fleet",
			"tasks",
			"memory",
			"view",
			"thinking",
			"output",
			"model",
			"scoped-models",
			"settings",
			"resume",
			"new",
			"tree",
			"fork",
			"export",
		];
		deepStrictEqual(
			BUILTIN_SLASH_COMMANDS.map((entry) => entry.name),
			visible,
		);
		deepStrictEqual(
			commandReference().map((entry) => entry.name),
			visible,
		);
		for (const deleted of [
			"status",
			"hotkeys",
			"skills",
			"connect",
			"disconnect",
			"receipts",
			"compact",
			"context-init",
			"context-clear",
			"context-view",
		]) {
			deepStrictEqual(parseSlashCommand(`/${deleted}`), { kind: "unknown", text: `/${deleted}` });
		}
	});

	it("routes retired context spellings as ordinary unknown chat input", () => {
		const routed: string[] = [];
		const ctx = {
			openContextView: () => routed.push("context-view"),
			runCompact: () => routed.push("compact"),
			submitChat: (text: string) => routed.push(`chat:${text}`),
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/context-view"), ctx);
		dispatchSlashCommand(parseSlashCommand("/compact tidy up"), ctx);
		dispatchSlashCommand(parseSlashCommand("/context"), ctx);

		deepStrictEqual(routed, ["chat:/context-view", "chat:/compact tidy up", "context-view"]);
	});

	it("builds slash autocomplete commands with hints that fit the suggestion row", () => {
		const commands = buildSlashAutocompleteCommands();
		const byName = new Map(commands.map((command) => [command.name, command]));

		ok(!byName.has("status"), "retired /status command is not suggested");
		for (const removedName of ["compact", "context-init", "context-clear", "context-view"]) {
			ok(!byName.has(removedName), `removed /${removedName} is not suggested`);
		}
		strictEqual(byName.get("context")?.argumentHint, "compact | init | refresh | reset");
		strictEqual(byName.get("quit")?.argumentHint, undefined);
		strictEqual(byName.get("help")?.argumentHint, "[query]");
		strictEqual(byName.get("share")?.argumentHint, "export | import");
		strictEqual(byName.get("run")?.argumentHint, "[--agent-profile <profile>] … <agent> <task>");
		for (const command of commands) {
			if (!command.argumentHint) continue;
			ok(
				command.argumentHint.length <= 44,
				`/${command.name} hint should fit the row budget, got ${command.argumentHint.length} chars: "${command.argumentHint}"`,
			);
		}
	});

	it("completes exactly the four canonical context actions with short stable descriptions", async () => {
		const byName = new Map(buildSlashAutocompleteCommands().map((command) => [command.name, command]));
		const context = byName.get("context");

		const all = await context?.getArgumentCompletions?.("");
		deepStrictEqual(
			all?.map((item) => ({ label: item.label, description: item.description })),
			[
				{ label: "compact", description: "Compact session context" },
				{ label: "init", description: "Initialize project context" },
				{ label: "refresh", description: "Refresh project context" },
				{ label: "reset", description: "Reset project context" },
			],
		);
		ok(
			all?.every((item) => (item.description?.length ?? 0) <= 28),
			"action descriptions stay row-sized",
		);

		const filtered = await context?.getArgumentCompletions?.("in");
		deepStrictEqual(
			filtered?.map((item) => item.value),
			["init"],
		);
	});

	it("stops completion after a zero-argument action's trailing space", async () => {
		const byName = new Map(buildSlashAutocompleteCommands().map((command) => [command.name, command]));
		const context = byName.get("context");

		for (const action of ["init", "refresh", "reset"]) {
			deepStrictEqual(
				(await context?.getArgumentCompletions?.(action))?.map((item) => item.value),
				[action],
				`${action} completes before its trailing space`,
			);
			strictEqual(
				await context?.getArgumentCompletions?.(`${action} `),
				null,
				`${action} has no completions after its trailing space`,
			);
			strictEqual(await context?.getArgumentCompletions?.(`${action} --`), null, `${action} exposes no flags`);
		}
		strictEqual(await context?.getArgumentCompletions?.("compact "), null, "compact switches to free-form text");
	});

	it("returns one action before and null after the trailing space through the editor provider", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		for (const action of ["compact", "init", "refresh", "reset"]) {
			const before = `/context ${action}`;
			const suggestion = await provider.getSuggestions([before], 0, before.length, {
				signal: new AbortController().signal,
			});
			deepStrictEqual(
				suggestion?.items.map((item) => item.value),
				[action],
			);

			const after = `${before} `;
			strictEqual(await provider.getSuggestions([after], 0, after.length, { signal: new AbortController().signal }), null);
		}
	});

	it("keeps an action completion on one row at narrow and normal editor widths", async () => {
		const tui = {
			terminal: { rows: 30, columns: 80 },
			requestRender() {},
		} as unknown as TUI;
		const editor = new ClioEditor(tui, {
			getModelLabel: () => "target/model",
			getThinkingLabel: () => "off",
		});
		editor.setAutocompleteProvider(createSlashCommandAutocompleteProvider({ fdPath: null }));
		editor.setText("/context ");
		editor.handleInput("i");
		// Autocomplete refreshes asynchronously. Yield until its one matching row
		// appears, without a timing delay that could make the render test flaky.
		for (let attempt = 0; attempt < 10 && editor.render(80).length < 4; attempt++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		for (const width of [40, 80]) {
			const lines = editor.render(width);
			strictEqual(lines.length, 4, `${width} columns keep top, input, footer, and one suggestion row distinct`);
			for (const line of lines) strictEqual(visibleWidth(line), width, `completion row overflow at ${width} columns`);
			strictEqual(
				lines.some((line) => line.includes("Initialize project context")),
				width === 80,
				`${width} columns ${width === 80 ? "show" : "drop"} the description without adding a row`,
			);
		}
	});

	it("completes closed value sets in a flag's value slot and stays silent for open values", async () => {
		const byName = new Map(buildSlashAutocompleteCommands().map((command) => [command.name, command]));
		const run = byName.get("run");

		const profiles = await run?.getArgumentCompletions?.("--tool-profile ");
		deepStrictEqual(
			profiles?.map((item) => item.label),
			["minimal-local", "science-local", "full-agent"],
		);
		const filtered = await run?.getArgumentCompletions?.("--tool-profile sci");
		deepStrictEqual(
			filtered?.map((item) => item.value),
			["--tool-profile science-local"],
		);
		strictEqual(await run?.getArgumentCompletions?.("--target "), null, "an open flag value never completes");
	});

	it("completes actions for /ctx and preserves the typed alias on accept", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		const line = "/ctx in";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		deepStrictEqual(
			suggestions?.items.map((item) => item.value),
			["init"],
			"/ctx completes exactly like /context",
		);
		const first = suggestions?.items[0];
		ok(first, "the alias invocation yields a completion to accept");
		const applied = provider.applyCompletion([line], 0, line.length, first, suggestions?.prefix ?? "");
		strictEqual(applied.lines[0], "/ctx init", "accepting keeps the user's alias spelling");
	});

	it("never completes inside free rest text", async () => {
		const byName = new Map(buildSlashAutocompleteCommands().map((command) => [command.name, command]));
		strictEqual(await byName.get("context")?.getArgumentCompletions?.("compact tidy up --"), null);
		strictEqual(await byName.get("run")?.getArgumentCompletions?.("architect slice the work --"), null);
		ok(
			await byName.get("run")?.getArgumentCompletions?.("architect --tar"),
			"flags before rest still complete when the grammar parses flags there",
		);
	});

	it("keeps docs/commands-and-modes.md command table aligned with commandReference", () => {
		const expected = commandReference().map((ref) => ({
			command: `/${ref.name}`,
			aliases: ref.aliases.map((alias) => `/${alias}`),
			usage: ref.usage,
			description: ref.description,
		}));

		deepStrictEqual(commandDocsRows(), expected);
	});
});
