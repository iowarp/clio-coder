import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { buildSlashAutocompleteCommands } from "../../src/interactive/slash-autocomplete.js";
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
		const ctx: SlashCommandContext = {
			io: { stdout: () => undefined, stderr: () => undefined },
			notice: () => undefined,
			dispatch: {} as DispatchContract,
			bus: createSafeEventBus(),
			workerDefault: () => undefined,
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

		for (const input of ["/help routing", "/settings", "/targets", "/model", "/models", "/view run-123"]) {
			dispatchSlashCommand(parseSlashCommand(input), ctx);
		}
		dispatchSlashCommand(parseSlashCommand("/not-a-command"), ctx);

		deepStrictEqual(opened, ["help:routing", "settings", "targets", "model", "model", "view:run-123"]);
		deepStrictEqual(submitted, ["/not-a-command"]);
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

			// context init (hub) and the deprecated /context-init spelling
			["/context init", { kind: "init", options: {} }],
			["/context init --preview", { kind: "init", options: { preview: true } }],
			["/context init --adopt", { kind: "init", options: { adopt: true } }],
			["/context init --apply", { kind: "init", options: { applyClioMd: true } }],
			["/context init --rewrite", { kind: "init", options: { applyClioMd: true } }],
			["/context init --propose", { kind: "init", options: { proposeClioMd: true } }],
			["/context init --global", { kind: "init", options: { includeGlobalImports: true } }],
			["/context init --include-global", { kind: "init", options: { includeGlobalImports: true } }],
			["/context init --heuristic", { kind: "init", options: { heuristic: true } }],
			["/context init --no-generate", { kind: "init", options: { heuristic: true } }],
			["/context init --preview --adopt", { kind: "init", options: { preview: true, adopt: true } }],
			["/context init --invalid", { kind: "unknown", text: "/context init --invalid" }],
			[
				"/context-init --preview",
				{ kind: "init", options: { preview: true }, deprecation: { from: "context-init", to: "context init" } },
			],
			["/context-init --invalid", { kind: "unknown", text: "/context-init --invalid" }],

			// context reset (hub) and the deprecated /context-clear spelling
			["/context reset", { kind: "context-clear", options: {} }],
			["/context reset --all", { kind: "context-clear", options: { all: true } }],
			["/context reset --confirm", { kind: "context-clear", options: { confirmed: true } }],
			["/context reset --confirm-all", { kind: "context-clear", options: { confirmedAll: true } }],
			["/context reset --invalid", { kind: "unknown", text: "/context reset --invalid" }],
			[
				"/context-clear --all",
				{ kind: "context-clear", options: { all: true }, deprecation: { from: "context-clear", to: "context reset" } },
			],
			["/context-clear --invalid", { kind: "unknown", text: "/context-clear --invalid" }],

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
			["/share", { kind: "share", args: "" }],
			["/share export /my/path", { kind: "share", args: "export /my/path" }],
			["/share export /my/path extra", { kind: "share", args: "export /my/path extra" }],
			["/share import --dry-run /my/path", { kind: "share", args: "import --dry-run /my/path" }],
			["/share import --force /my/path", { kind: "share", args: "import --force /my/path" }],
			["/share import --dry-run --force /my/path", { kind: "share", args: "import --dry-run --force /my/path" }],
			["/share import /my/path --dry-run", { kind: "share", args: "import /my/path --dry-run" }],
			["/share import /my/path --dry-run --force", { kind: "share", args: "import /my/path --dry-run --force" }],
			["/share import --dry-run /my/path --force", { kind: "share", args: "import --dry-run /my/path --force" }],
			["/share import /my/path", { kind: "share", args: "import /my/path" }],
			["/share invalid", { kind: "share", args: "invalid" }],

			// view
			["/view", { kind: "view" }],
			["/view myRunId", { kind: "view", filter: "myRunId" }],
			["/view Bash npm test", { kind: "view", filter: "Bash npm test" }],
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

			// context compact (hub) and the deprecated /compact spelling
			["/context compact", { kind: "compact", instructions: undefined }],
			["/context compact my instructions", { kind: "compact", instructions: "my instructions" }],
			["/compact", { kind: "compact", instructions: undefined, deprecation: { from: "compact", to: "context compact" } }],
			[
				"/compact    ",
				{ kind: "compact", instructions: undefined, deprecation: { from: "compact", to: "context compact" } },
			],
			[
				"/compact my instructions",
				{ kind: "compact", instructions: "my instructions", deprecation: { from: "compact", to: "context compact" } },
			],

			// context overlay (hub, no args) and the deprecated /context-view spelling
			["/context", { kind: "context-view" }],
			["/ctx", { kind: "context-view" }],
			["/context-view", { kind: "context-view", deprecation: { from: "context-view", to: "context" } }],

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

	it("locks the v0.2.8 post-context-hub command registry", () => {
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
			"view",
			"thinking",
			"model",
			"scoped-models",
			"settings",
			"resume",
			"new",
			"tree",
			"fork",
			"export",
		];
		const deprecatedHidden = ["compact", "context-init", "context-clear", "context-view"];
		deepStrictEqual(
			BUILTIN_SLASH_COMMANDS.map((entry) => entry.name),
			[...visible, ...deprecatedHidden],
		);
		deepStrictEqual(
			commandReference().map((entry) => entry.name),
			visible,
		);
		for (const name of deprecatedHidden) {
			const entry = BUILTIN_SLASH_COMMANDS.find((candidate) => candidate.name === name);
			strictEqual(entry?.hidden, true, `deprecated spelling "${name}" stays hidden`);
			deepStrictEqual(entry?.kinds, [], `deprecated spelling "${name}" owns no kinds`);
		}
		for (const deleted of ["status", "hotkeys", "skills", "connect", "disconnect", "receipts"]) {
			deepStrictEqual(parseSlashCommand(`/${deleted}`), { kind: "unknown", text: `/${deleted}` });
		}
	});

	it("emits one deprecation notice and still routes deprecated spellings", () => {
		const notices: string[] = [];
		const routed: string[] = [];
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			openContextView: () => routed.push("context-view"),
			runCompact: () => routed.push("compact"),
			submitChat: () => routed.push("chat"),
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/context-view"), ctx);
		dispatchSlashCommand(parseSlashCommand("/compact tidy up"), ctx);
		dispatchSlashCommand(parseSlashCommand("/context"), ctx);

		deepStrictEqual(routed, ["context-view", "compact", "context-view"]);
		deepStrictEqual(notices, [
			"/context-view is deprecated; use /context",
			"/compact is deprecated; use /context compact",
		]);
	});

	it("builds slash autocomplete commands from commandReference usage", () => {
		const commands = buildSlashAutocompleteCommands();
		const byName = new Map(commands.map((command) => [command.name, command]));

		ok(!byName.has("status"), "retired /status command is not suggested");
		for (const hiddenName of ["compact", "context-init", "context-clear", "context-view"]) {
			ok(!byName.has(hiddenName), `deprecated /${hiddenName} is not suggested`);
		}
		strictEqual(
			byName.get("context")?.argumentHint,
			"compact [instructions] | init [--preview] [--adopt] [--apply] [--propose] [--global] [--heuristic] | refresh | reset [--all] [--confirm] [--confirm-all]",
		);
		strictEqual(byName.get("quit")?.argumentHint, undefined);
		strictEqual(byName.get("help")?.argumentHint, "[query]");
		strictEqual(byName.get("share")?.argumentHint, "export <path> | import [--dry-run] [--force] <path>");
		strictEqual(
			byName.get("run")?.argumentHint,
			"[--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local|science-local|full-agent>] [--require <cap>] <agent> <task>",
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
