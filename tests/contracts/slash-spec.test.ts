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
	type SlashCommand,
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
	usage: string;
	description: string;
}

function commandDocsRows(): CommandDocsRow[] {
	const doc = readFileSync("docs/commands-and-modes.md", "utf8");
	const lines = doc.split(/\r?\n/);
	const headerIndex = lines.indexOf("| Command | Usage | Purpose |");
	ok(headerIndex >= 0, "commands table header exists");
	const rows: CommandDocsRow[] = [];
	for (const line of lines.slice(headerIndex + 2)) {
		if (!line.startsWith("|")) break;
		const [command, usage, description] = splitMarkdownTableRow(line);
		if (command === undefined || usage === undefined || description === undefined) {
			throw new Error(`Malformed command docs row: ${line}`);
		}
		rows.push({ command, usage, description });
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
			openCost: () => opened.push("cost"),
			openContextView: () => opened.push("context"),
			openTasks: () => opened.push("tasks"),
			openDecisions: () => opened.push("decisions"),
			openMemory: () => opened.push("memory"),
			seedTaskMemory: () => ({ status: "seeded", seeded: 2, skipped: 1, source: "handoff-latest.md" }),
			openView: (filter) => opened.push(filter ? `view:${filter}` : "view"),
			openModel: () => opened.push("model"),
			providers: {} as ProvidersContract,
			applyModelRef: () => undefined,
			openSettings: (section, rowId) =>
				opened.push(rowId ? `settings:${section}:${rowId}` : section ? `settings:${section}` : "settings"),
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

		for (const input of [
			"/help routing",
			"/settings",
			"/targets",
			"/fleet",
			"/scoped-models",
			"/thinking",
			"/output",
			"/model",
			"/memory",
			"/decisions",
			"/view run-123",
		]) {
			dispatchSlashCommand(parseSlashCommand(input), ctx);
		}
		dispatchSlashCommand(parseSlashCommand("/memory seed"), ctx);
		dispatchSlashCommand(parseSlashCommand("/not/a/command"), ctx);

		// Configuration-shaped commands are deep links: each opens its settings
		// section rather than an overlay of its own.
		deepStrictEqual(opened, [
			"help:routing",
			"settings",
			"settings:targets",
			"settings:fleet",
			"settings:models:scope",
			"settings:orchestrator:orchestrator.thinkingLevel",
			"settings:terminal:terminal.outputVerbosity",
			"model",
			"memory",
			"decisions",
			"view:run-123",
		]);
		deepStrictEqual(submitted, ["/not/a/command"]);
		ok(notices.some((notice) => notice.includes("seeded 2 entries from handoff-latest.md; skipped 1 duplicate")));
	});

	/**
	 * The defect this pins: `/thinking off` parsed as a command with a bad
	 * argument, fell through to `unknown`, and was submitted to the model, which
	 * answered it conversationally. The operator believed a setting had changed,
	 * the model believed it had been instructed, and nothing had happened.
	 */
	it("reports a registered command with bad arguments instead of sending it to the model", () => {
		const submitted: string[] = [];
		const notices: string[] = [];
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			submitChat: (text: string) => submitted.push(text),
			render: () => undefined,
			shutdown: () => undefined,
			setThinkingLevel: (level: string) =>
				level === "off"
					? ({ status: "applied", level, display: "off" } as const)
					: ({ status: "unsupported", level, supported: ["off", "low"] } as const),
			setOutputVerbosity: (verbosity: string) =>
				verbosity === "verbose"
					? ({ status: "applied", verbosity } as const)
					: ({ status: "unsupported", verbosity, supported: ["minimal", "default", "verbose"] } as const),
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/thinking off"), ctx);
		dispatchSlashCommand(parseSlashCommand("/thinking sideways"), ctx);
		dispatchSlashCommand(parseSlashCommand("/output verbose"), ctx);
		dispatchSlashCommand(parseSlashCommand("/output loud"), ctx);
		dispatchSlashCommand(parseSlashCommand("/quit now"), ctx);
		dispatchSlashCommand(parseSlashCommand("/home/akougkas/notes.md needs an update"), ctx);

		deepStrictEqual(
			submitted,
			["/home/akougkas/notes.md needs an update"],
			"only input that is not command-shaped reaches the model",
		);
		ok(
			notices.some((notice) => notice === "thinking: off"),
			notices.join(" | "),
		);
		ok(
			notices.some((notice) => notice.includes('"sideways" is not available here') && notice.includes("off, low")),
			notices.join(" | "),
		);
		ok(
			notices.some((notice) => notice === "output detail: verbose"),
			notices.join(" | "),
		);
		ok(
			notices.some((notice) => notice.includes('"loud" is not one of') && notice.includes("minimal, default, verbose")),
			notices.join(" | "),
		);
		ok(
			notices.some((notice) => notice.includes("Unexpected argument: now") && notice.includes("usage: /quit")),
			notices.join(" | "),
		);
	});

	it("parses and executes project operator task subcommands without implicit agent submission", () => {
		const submitted: string[] = [];
		const notices: string[] = [];
		const statusById = new Map<string, "open" | "handed" | "done" | "dropped">();
		let nextId = 1;
		const task = (id: string, title: string, status: "open" | "handed" | "done" | "dropped") => ({
			id,
			title,
			status,
			createdAt: "2026-08-19T12:00:00.000Z",
			updatedAt: "2026-08-19T12:00:00.000Z",
		});
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			submitChat: (text: string) => submitted.push(text),
			openTasks: () => undefined,
			userTasks: {
				add: (title: string) => {
					const id = `u${nextId++}`;
					statusById.set(id, "open");
					return task(id, title, "open");
				},
				hand: (id: string) => {
					statusById.set(id, "handed");
					return task(id, "write release notes", "handed");
				},
				done: (id: string) => {
					statusById.set(id, "done");
					return task(id, "write release notes", "done");
				},
				drop: (id: string) => {
					statusById.set(id, "dropped");
					return task(id, "discard draft", "dropped");
				},
			},
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/tasks add write release notes"), ctx);
		strictEqual(submitted.length, 0, "logging an inbox task never submits a turn");
		dispatchSlashCommand(parseSlashCommand("/tasks hand u1"), ctx);
		dispatchSlashCommand(parseSlashCommand("/tasks done u1"), ctx);
		dispatchSlashCommand(parseSlashCommand("/tasks drop u2"), ctx);

		deepStrictEqual(
			[...statusById],
			[
				["u1", "done"],
				["u2", "dropped"],
			],
		);
		deepStrictEqual(submitted, [
			'Operator task u1: write release notes. Pick it up with tasks action="pick" id="u1" and work it when appropriate.',
		]);
		ok(notices.some((notice) => notice.includes("logged operator task u1")));
	});

	/**
	 * The same defect one layer out. A removed command matched nothing, fell
	 * through to `unknown`, and was submitted to the model, which answered
	 * (completed)" in six output tokens. Context was unchanged, no compaction
	 * summary was written, and no hook fired, but the transcript read like it had
	 * worked. Only active commands run: anything command-shaped that names no
	 * registered command fails and never reaches the model. A leading slash is
	 * also how a path starts, so path-shaped and prose input still belongs to the
	 * model. Retired aliases follow this same closed failure path.
	 */
	it("fails a command-shaped spelling that names no command, and never sends it to the model", () => {
		const submitted: string[] = [];
		const notices: string[] = [];
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			submitChat: (text: string) => submitted.push(text),
			render: () => undefined,
		} as unknown as SlashCommandContext;

		// Retired spellings and typos all fail closed.
		for (const absent of ["/context-init", "/context-clear", "/context-view", "/compact", "/skills", "/thnking"]) {
			dispatchSlashCommand(parseSlashCommand(absent), ctx);
		}

		strictEqual(submitted.length, 0, `nothing command-shaped reaches the model, got: ${submitted.join(" | ")}`);
		strictEqual(notices.length, 6, notices.join(" | "));
		ok(
			notices.every((notice) => notice.includes("not a command") && notice.includes("/help")),
			notices.join(" | "),
		);
		// No replacement is named. Retired spellings are gone, not aliased.
		ok(
			notices.every((notice) => !notice.includes("/context compact") && !notice.includes("retired")),
			notices.join(" | "),
		);

		// A path and ordinary prose both still belong to the model.
		for (const prose of ["/not/a/command at all", "/home/akougkas/iowarp/clio-coder", "/ leading space"]) {
			dispatchSlashCommand(parseSlashCommand(prose), ctx);
		}
		deepStrictEqual(submitted, ["/not/a/command at all", "/home/akougkas/iowarp/clio-coder", "/ leading space"]);

		// The accepted cost of the rule. One command-shaped word followed by prose is
		// indistinguishable from a mistyped command carrying arguments, which is the
		// shape of the defect this exists to catch, so it resolves as a command and
		// fails. A sentence that has to start this way needs the backslash escape.
		deepStrictEqual(parseSlashCommand("/tmp is full"), { kind: "unknown-command", token: "tmp", text: "/tmp is full" });

		// The escape has to survive the editor, which trims the submitted line
		// before the parser ever sees it. A leading space does not survive, so it
		// buys nothing; a backslash does.
		deepStrictEqual(parseSlashCommand(" /tmp is full"), { kind: "unknown-command", token: "tmp", text: "/tmp is full" });
		deepStrictEqual(parseSlashCommand("\\/tmp is full"), { kind: "unknown", text: "/tmp is full" });
		deepStrictEqual(parseSlashCommand("  \\/tmp is full  "), { kind: "unknown", text: "/tmp is full" });

		// The escape claims exactly one backslash, and only the one before a
		// slash. A Windows share path is not an escaped command.
		deepStrictEqual(parseSlashCommand("\\\\server\\share"), { kind: "unknown", text: "\\\\server\\share" });
		deepStrictEqual(parseSlashCommand("\\note to self"), { kind: "unknown", text: "\\note to self" });

		// An escaped real command reaches the model as text instead of running.
		deepStrictEqual(parseSlashCommand("\\/help"), { kind: "unknown", text: "/help" });
		dispatchSlashCommand(parseSlashCommand("\\/tmp is full"), ctx);
		strictEqual(submitted[submitted.length - 1], "/tmp is full");
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
				(flag): [string, unknown] => [
					`/context init ${flag}`,
					{ kind: "usage-error", command: "context", reason: `Unknown flag: ${flag}` },
				],
			),
			[
				"/context init --include-global",
				{ kind: "usage-error", command: "context", reason: "Unknown flag: --include-global" },
			],
			["/context init --no-generate", { kind: "usage-error", command: "context", reason: "Unknown flag: --no-generate" }],
			["/context init extra", { kind: "usage-error", command: "context", reason: "Unexpected argument: extra" }],
			["/context-init", { kind: "unknown-command", token: "context-init", text: "/context-init" }],
			["/context-init --preview", { kind: "unknown-command", token: "context-init", text: "/context-init --preview" }],

			// context reset is zero-argument; confirmation happens in its chooser
			["/context reset", { kind: "context-clear", options: {} }],
			["/context reset   ", { kind: "context-clear", options: {} }],
			["/context reset --all", { kind: "usage-error", command: "context", reason: "Unknown flag: --all" }],
			["/context reset --confirm", { kind: "usage-error", command: "context", reason: "Unknown flag: --confirm" }],
			["/context reset --confirm-all", { kind: "usage-error", command: "context", reason: "Unknown flag: --confirm-all" }],
			["/context reset --invalid", { kind: "usage-error", command: "context", reason: "Unknown flag: --invalid" }],
			["/context reset extra", { kind: "usage-error", command: "context", reason: "Unexpected argument: extra" }],
			["/context-clear", { kind: "unknown-command", token: "context-clear", text: "/context-clear" }],
			["/context-clear --all", { kind: "unknown-command", token: "context-clear", text: "/context-clear --all" }],

			// context refresh (hub)
			["/context refresh", { kind: "context-refresh" }],
			["/context refresh extra", { kind: "usage-error", command: "context", reason: "Unexpected argument: extra" }],

			// session reset stays /new; there is deliberately no /context clear subcommand
			["/context clear", { kind: "usage-error", command: "context", reason: "Unexpected argument: clear" }],

			// skill selector and invocation forms
			["/skill", { kind: "skill-selector" }],
			["/skill ", { kind: "skill-selector" }],
			["/skill writer draft release notes", { kind: "skill-invocation", text: "/skill writer draft release notes" }],
			["/skill:", { kind: "unknown-command", token: "skill:", text: "/skill:" }],
			["/skills:", { kind: "unknown-command", token: "skills:", text: "/skills:" }],
			[
				"/skill:writer draft release notes",
				{ kind: "unknown-command", token: "skill:writer", text: "/skill:writer draft release notes" },
			],
			[
				"/skills:writer draft release notes",
				{ kind: "unknown-command", token: "skills:writer", text: "/skills:writer draft release notes" },
			],

			// /skills was absorbed into the /skill hub in v0.2.3 and now fails as absent
			["/skills", { kind: "unknown-command", token: "skills", text: "/skills" }],
			["/skills git tools", { kind: "unknown-command", token: "skills", text: "/skills git tools" }],

			// run
			["/run scout task text", { kind: "run", agentId: "scout", task: "task text", options: {} }],
			["/run --share scout task text", { kind: "run", agentId: "scout", task: "task text", options: { share: true } }],
			["/run --worker-profile custom scout task text", { kind: "run-usage" }],
			[
				"/run --agent-profile custom scout task text",
				{ kind: "run", agentId: "scout", task: "task text", options: { workerProfile: "custom" } },
			],
			["/run --worker custom scout task text", { kind: "run-usage" }],
			[
				"/run --runtime node scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerRuntime: "node" } },
			],
			["/run --worker-runtime node scout task", { kind: "run-usage" }],
			["/run --agent-runtime node scout task", { kind: "run-usage" }],
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
			["/run --agent-profile a --worker-profile b --worker c scout task", { kind: "run-usage" }],
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
			["/delegate --share codex task text", { kind: "delegate", agentId: "codex", task: "task text", share: true }],
			["/delegate agent --target dynamo task", { kind: "delegate", agentId: "agent", task: "--target dynamo task" }],
			["/delegate", { kind: "delegate-usage" }],
			["/delegate agent", { kind: "delegate-usage" }],

			// share
			// A bare /share is the worker-result sense: the newest finished run the
			// operator started. The archive senses are the two named subcommands.
			["/share", { kind: "share", action: "worker-run" }],
			["/share 2mkas6s", { kind: "share", action: "worker-run", runId: "2mkas6s" }],
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
			["/share one two", { kind: "share", action: "usage", error: "Unexpected argument: two" }],

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

			// /receipts was absorbed into /view in v0.2.3 and now fails as absent
			["/receipts", { kind: "unknown-command", token: "receipts", text: "/receipts" }],
			["/receipts verify myRunId", { kind: "unknown-command", token: "receipts", text: "/receipts verify myRunId" }],

			// model
			["/model", { kind: "model" }],
			["/models", { kind: "unknown-command", token: "models", text: "/models" }],
			["/model pattern:thinking", { kind: "model-set", pattern: "pattern:thinking" }],
			["/model provider/model:high:extra", { kind: "model-set", pattern: "provider/model:high:extra" }],
			["/models pattern:thinking", { kind: "unknown-command", token: "models", text: "/models pattern:thinking" }],

			// context compact alone keeps its optional free-form instructions
			["/context compact", { kind: "compact", instructions: undefined }],
			["/context compact   ", { kind: "compact", instructions: undefined }],
			["/context compact my instructions", { kind: "compact", instructions: "my instructions" }],
			["/compact", { kind: "unknown-command", token: "compact", text: "/compact" }],
			["/compact my instructions", { kind: "unknown-command", token: "compact", text: "/compact my instructions" }],

			// context overlay (hub, no args); the retired spelling no longer parses
			["/context", { kind: "context-view" }],
			["/ctx", { kind: "unknown-command", token: "ctx", text: "/ctx" }],
			["/context-view", { kind: "unknown-command", token: "context-view", text: "/context-view" }],

			// retired aliases fail closed
			["/exit", { kind: "unknown-command", token: "exit", text: "/exit" }],
			["/config", { kind: "unknown-command", token: "config", text: "/config" }],

			// status (deleted) -> falls through to unknown
			["/status", { kind: "unknown-command", token: "status", text: "/status" }],

			// connect/disconnect (deleted) -> falls through to unknown
			["/connect", { kind: "unknown-command", token: "connect", text: "/connect" }],
			["/connect target-a", { kind: "unknown-command", token: "connect", text: "/connect target-a" }],
			["/disconnect", { kind: "unknown-command", token: "disconnect", text: "/disconnect" }],
			["/disconnect target-a", { kind: "unknown-command", token: "disconnect", text: "/disconnect target-a" }],

			// unknown / invalid
			["/invalid-command", { kind: "unknown-command", token: "invalid-command", text: "/invalid-command" }],
			// A registered command with unparseable arguments is a usage error, not
			// a chat message. `unknown` stays for input that matched no command.
			["/quit now", { kind: "usage-error", command: "quit", reason: "Unexpected argument: now" }],
			["/prompts query", { kind: "usage-error", command: "prompts", reason: "Unexpected argument: query" }],
			["/extensions query", { kind: "usage-error", command: "extensions", reason: "Unexpected argument: query" }],
			["/agents query", { kind: "usage-error", command: "agents", reason: "Unexpected argument: query" }],
			["/targets query", { kind: "usage-error", command: "targets", reason: "Unexpected argument: query" }],
			["/cost query", { kind: "usage-error", command: "cost", reason: "Unexpected argument: query" }],
			["/context query", { kind: "usage-error", command: "context", reason: "Unexpected argument: query" }],
			["/fleet query", { kind: "usage-error", command: "fleet", reason: "Unexpected argument: query" }],
			["/tasks query", { kind: "usage-error", command: "tasks", reason: "Unexpected argument: query" }],
			["/tasks", { kind: "tasks" }],
			["/decisions", { kind: "decisions" }],
			["/decisions extra", { kind: "usage-error", command: "decisions", reason: "Unexpected argument: extra" }],
			["/tasks add write release notes", { kind: "tasks-add", text: "write release notes" }],
			["/tasks hand u3", { kind: "tasks-hand", id: "u3" }],
			["/tasks done u3", { kind: "tasks-done", id: "u3" }],
			["/tasks drop u3", { kind: "tasks-drop", id: "u3" }],
			["/tasks add", { kind: "usage-error", command: "tasks", reason: "Missing required argument: text" }],
			["/memory", { kind: "memory" }],
			["/memory seed", { kind: "memory-seed" }],
			["/memory query", { kind: "usage-error", command: "memory", reason: "Unexpected argument: query" }],
			["/thinking", { kind: "settings", section: "orchestrator", rowId: "orchestrator.thinkingLevel" }],
			["/output", { kind: "settings", section: "terminal", rowId: "terminal.outputVerbosity" }],
			["/output verbose", { kind: "output-set", verbosity: "verbose" }],
			["/output verbose extra", { kind: "usage-error", command: "output", reason: "Unexpected argument: extra" }],
			["/targets", { kind: "settings", section: "targets" }],
			["/fleet", { kind: "settings", section: "fleet" }],
			["/scoped-models", { kind: "settings", section: "models", rowId: "scope" }],
			["/thinking off", { kind: "thinking-set", level: "off" }],
			["/thinking query", { kind: "thinking-set", level: "query" }],
			["/thinking off extra", { kind: "usage-error", command: "thinking", reason: "Unexpected argument: extra" }],
			["/scoped-models query", { kind: "usage-error", command: "scoped-models", reason: "Unexpected argument: query" }],
			["/settings fleet", { kind: "settings", section: "fleet" }],
			["/settings terminal", { kind: "settings", section: "terminal" }],
			["/config retry", { kind: "unknown-command", token: "config", text: "/config retry" }],
			[
				"/settings query",
				{
					kind: "usage-error",
					command: "settings",
					reason:
						"Unknown section: query (one of safety, orchestrator, fleet, targets, models, budget, compaction, retry, terminal, advanced)",
				},
			],
			["/settings fleet extra", { kind: "usage-error", command: "settings", reason: "Unexpected argument: extra" }],
			["/resume query", { kind: "usage-error", command: "resume", reason: "Unexpected argument: query" }],
			["/new query", { kind: "usage-error", command: "new", reason: "Unexpected argument: query" }],
			["/tree query", { kind: "usage-error", command: "tree", reason: "Unexpected argument: query" }],
			["/fork query", { kind: "usage-error", command: "fork", reason: "Unexpected argument: query" }],
			["/export --json", { kind: "usage-error", command: "export", reason: "Unknown flag: --json" }],
			["/export a.md b.md", { kind: "usage-error", command: "export", reason: "Unexpected argument: b.md" }],
			["/hotkeys query", { kind: "unknown-command", token: "hotkeys", text: "/hotkeys query" }],
		];

		for (const [input, expected] of testCases) {
			const parsed = parseSlashCommand(input);
			// `/run` and `/delegate` carry the typed line so the transcript can echo
			// it above the block the run draws. It is the input verbatim in every
			// case, so it is asserted as an invariant here rather than repeated in
			// twenty rows of the table above.
			const { source, ...rest } = parsed as SlashCommand & { source?: string };
			if (source !== undefined) strictEqual(source, input, `source is the typed line for "${input}"`);
			deepStrictEqual(rest, expected, `Failed for input: "${input}"`);
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
			"\nusage: /run [--agent-profile <profile>] [--runtime <runtimeId>] [--target <id>] [--model <id>] [--thinking <level>] [--tool-profile <minimal-local|science-local|full-agent>] [--require <cap>] [--share] <agent> <task>\n",
		);

		strictEqual(usageLine(delegateEntry), "\nusage: /delegate [--share] <agent-id> <task>\n");

		strictEqual(
			usageLine(shareEntry),
			"\nusage: /share [runId] | /share export <path> | /share import [--dry-run] [--force] <path>\n",
		);

		strictEqual(usageLine(shareEntry, "export"), "\nusage: /share export <path>\n");

		strictEqual(usageLine(shareEntry, "import"), "\nusage: /share import [--dry-run] [--force] <path>\n");
	});

	it("enforces registry integrity with one unique canonical name and one owner per kind", () => {
		const names = new Set<string>();
		const kinds = new Set<string>();

		for (const entry of BUILTIN_SLASH_COMMANDS) {
			ok(!names.has(entry.name), `Command name "${entry.name}" is registered more than once`);
			names.add(entry.name);

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
			"interop",
			"share",
			"run",
			"delegate",
			"agents",
			"targets",
			"cost",
			"context",
			"fleet",
			"decisions",
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
		// Absent spellings fail the same way whether they were deleted outright or
		// renamed. The registry does not carry either kind, so neither is aliased to
		// a replacement and neither is answered by the model.
		for (const absent of [
			"exit",
			"ctx",
			"compact",
			"models",
			"config",
			"status",
			"hotkeys",
			"skills",
			"connect",
			"disconnect",
			"receipts",
			"context-init",
			"context-clear",
			"context-view",
		]) {
			deepStrictEqual(parseSlashCommand(`/${absent}`), { kind: "unknown-command", token: absent, text: `/${absent}` });
		}
		for (const retired of ["/skill:writer", "/skills:writer"]) {
			const token = retired.slice(1);
			deepStrictEqual(parseSlashCommand(retired), { kind: "unknown-command", token, text: retired });
		}
	});

	it("never runs the command a retired context spelling used to name", () => {
		const routed: string[] = [];
		const ctx = {
			openContextView: () => routed.push("context-view"),
			runCompact: () => routed.push("compact"),
			submitChat: (text: string) => routed.push(`chat:${text}`),
			notice: (_level: string, text: string) => routed.push(`notice:${text}`),
			render: () => undefined,
		} as unknown as SlashCommandContext;

		dispatchSlashCommand(parseSlashCommand("/context-view"), ctx);
		dispatchSlashCommand(parseSlashCommand("/context"), ctx);

		ok(!routed.includes("compact"), "a retired spelling must not reach the handler it once named");
		ok(!routed.some((entry) => entry.startsWith("chat:")), "and must not be answered by the model either");
		ok(
			routed.some((entry) => entry.includes("/context-view is not a command")),
			routed.join(" | "),
		);
		strictEqual(routed.at(-1), "context-view", "the surviving spelling still works");
	});

	it("rejects retired aliases while canonical spellings keep their unique routes", () => {
		const routed: string[] = [];
		const ctx = {
			shutdown: () => routed.push("quit"),
			openSettings: (section?: string) => routed.push(section ? `settings:${section}` : "settings"),
			runCompact: (instructions?: string) => routed.push(`compact:${instructions ?? ""}`),
			openContextView: () => routed.push("context-view"),
			submitChat: (text: string) => routed.push(`chat:${text}`),
			notice: (_level: string, text: string) => routed.push(`notice:${text}`),
			render: () => undefined,
		} as unknown as SlashCommandContext;

		for (const retired of ["/exit", "/config", "/compact", "/compact drop the old turns", "/ctx", "/models"]) {
			dispatchSlashCommand(parseSlashCommand(retired), ctx);
		}
		ok(
			routed.every((entry) => entry.startsWith("notice:")),
			routed.join(" | "),
		);
		ok(!routed.some((entry) => entry.startsWith("chat:")), routed.join(" | "));

		routed.length = 0;
		dispatchSlashCommand(parseSlashCommand("/quit"), ctx);
		dispatchSlashCommand(parseSlashCommand("/settings fleet"), ctx);
		dispatchSlashCommand(parseSlashCommand("/context"), ctx);
		dispatchSlashCommand(parseSlashCommand("/context compact drop the old turns"), ctx);

		deepStrictEqual(routed, ["quit", "settings:fleet", "context-view", "compact:drop the old turns"]);

		// /clear names nothing here: session reset is /new and context reset is
		// /context reset, and neither is what an operator typing /clear means.
		// It stays an error, and the error points at the list.
		routed.length = 0;
		dispatchSlashCommand(parseSlashCommand("/clear"), ctx);
		deepStrictEqual(routed, ["notice:/clear is not a command. Type /help for the list."]);
	});

	it("builds slash autocomplete commands with hints that fit the suggestion row", () => {
		const commands = buildSlashAutocompleteCommands();
		const byName = new Map(commands.map((command) => [command.name, command]));

		ok(!byName.has("status"), "retired /status command is not suggested");
		for (const removedName of ["context-init", "context-clear", "context-view"]) {
			ok(!byName.has(removedName), `removed /${removedName} is not suggested`);
		}
		for (const retired of ["exit", "ctx", "compact", "models", "config"]) {
			strictEqual(byName.has(retired), false, `/${retired} is not suggested`);
		}
		strictEqual(byName.get("context")?.argumentHint, "compact | recall | init | refresh | reset");
		strictEqual(byName.get("quit")?.argumentHint, undefined);
		strictEqual(byName.get("help")?.argumentHint, "[query]");
		strictEqual(byName.get("share")?.argumentHint, "[runId] | export | import");
		strictEqual(byName.get("run")?.argumentHint, "[--agent-profile <profile>] … <agent> <task>");
		for (const command of commands) {
			if (!command.argumentHint) continue;
			ok(
				command.argumentHint.length <= 44,
				`/${command.name} hint should fit the row budget, got ${command.argumentHint.length} chars: "${command.argumentHint}"`,
			);
		}
	});

	it("completes exactly the five canonical context actions with short stable descriptions", async () => {
		const byName = new Map(buildSlashAutocompleteCommands().map((command) => [command.name, command]));
		const context = byName.get("context");

		const all = await context?.getArgumentCompletions?.("");
		deepStrictEqual(
			all?.map((item) => ({ label: item.label, description: item.description })),
			[
				{ label: "compact", description: "Compact session context" },
				{ label: "recall", description: "Recall an evicted result" },
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

	/**
	 * The popup's Enter accepts the selected completion rather than submitting,
	 * so a suggestion the input already equals costs a keystroke that changes
	 * nothing on screen: `/memory seed` needed two Enters and typing through the
	 * first one concatenated onto the unsent line. A fully typed action opens no
	 * popup, so the first Enter submits. The completion source itself is
	 * unchanged: `getArgumentCompletions` still returns the token, and a partial
	 * token still completes.
	 */
	it("opens no popup for a fully typed action, and none after the trailing space", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		for (const action of ["compact", "init", "refresh", "reset"]) {
			const before = `/context ${action}`;
			strictEqual(
				await provider.getSuggestions([before], 0, before.length, { signal: new AbortController().signal }),
				null,
				`${action} is complete, so there is nothing to accept`,
			);

			const partial = `/context ${action.slice(0, 2)}`;
			const suggestion = await provider.getSuggestions([partial], 0, partial.length, {
				signal: new AbortController().signal,
			});
			ok(
				suggestion?.items.some((item) => item.value === action),
				`${action} still completes from a partial token`,
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

	it("does not complete arguments for a retired command alias", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		const line = "/ctx in";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		strictEqual(suggestions, null);
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
			usage: ref.usage,
			description: ref.description,
		}));

		deepStrictEqual(commandDocsRows(), expected);
	});
});
