import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSlashAutocompleteCommands } from "../../src/interactive/slash-autocomplete.js";
import { BUILTIN_SLASH_COMMANDS, commandReference, parseSlashCommand } from "../../src/interactive/slash-commands.js";
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
	it("parses all slash commands correctly matching v0.2.2 behavior", () => {
		const testCases: Array<[string, unknown]> = [
			// Empty and whitespace inputs
			["", { kind: "empty" }],
			["   ", { kind: "empty" }],

			// quit
			["/quit", { kind: "quit" }],

			// help
			["/help", { kind: "help" }],
			["/help foo", { kind: "help" }],
			["/help foo bar", { kind: "help" }],

			// context-init
			["/context-init", { kind: "init", options: {} }],
			["/context-init --preview", { kind: "init", options: { preview: true } }],
			["/context-init --adopt", { kind: "init", options: { adopt: true } }],
			["/context-init --apply", { kind: "init", options: { applyClioMd: true } }],
			["/context-init --rewrite", { kind: "init", options: { applyClioMd: true } }],
			["/context-init --propose", { kind: "init", options: { proposeClioMd: true } }],
			["/context-init --global", { kind: "init", options: { includeGlobalImports: true } }],
			["/context-init --include-global", { kind: "init", options: { includeGlobalImports: true } }],
			["/context-init --heuristic", { kind: "init", options: { heuristic: true } }],
			["/context-init --no-generate", { kind: "init", options: { heuristic: true } }],
			["/context-init --preview --adopt", { kind: "init", options: { preview: true, adopt: true } }],
			["/context-init --invalid", { kind: "unknown", text: "/context-init --invalid" }],

			// context-clear
			["/context-clear", { kind: "context-clear", options: {} }],
			["/context-clear --all", { kind: "context-clear", options: { all: true } }],
			["/context-clear --confirm", { kind: "context-clear", options: { confirmed: true } }],
			["/context-clear --confirm-all", { kind: "context-clear", options: { confirmedAll: true } }],
			["/context-clear --invalid", { kind: "unknown", text: "/context-clear --invalid" }],

			// skill selector and invocation forms
			["/skill", { kind: "skill-selector" }],
			["/skill:", { kind: "skill-selector" }],
			["/skills:", { kind: "skill-selector" }],
			["/skill:writer draft release notes", { kind: "skill-invocation", text: "/skill:writer draft release notes" }],
			["/skills:writer draft release notes", { kind: "skill-invocation", text: "/skills:writer draft release notes" }],
			["/skill writer draft release notes", { kind: "skill-invocation", text: "/skill writer draft release notes" }],

			// skills
			["/skills", { kind: "skills" }],
			["/skills git tools", { kind: "skills", query: "git tools" }],

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
				"/run --target myEndpoint scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { endpoint: "myEndpoint" } },
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
			[
				"/run --target a --target b scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { endpoint: "b" } },
			],
			[
				"/run --agent-profile a --worker-profile b --worker c scout task",
				{ kind: "run", agentId: "scout", task: "task", options: { workerProfile: "c" } },
			],
			[
				"/run scout --target endpoint task",
				{ kind: "run", agentId: "scout", task: "--target endpoint task", options: {} },
			],
			["/run scout task --thinking bogus", { kind: "run", agentId: "scout", task: "task --thinking bogus", options: {} }],
			["/run", { kind: "run-usage" }],
			["/run scout", { kind: "run-usage" }],
			["/run --target", { kind: "run-usage" }],

			// delegate
			["/delegate agent task text", { kind: "delegate", agentId: "agent", task: "task text" }],
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

			// receipts
			["/receipts", { kind: "receipts" }],
			["/receipts verify myRunId", { kind: "receipt-verify", runId: "myRunId" }],
			["/receipts verify", { kind: "receipt-usage" }],
			["/receipts verify myRunId extra", { kind: "receipt-usage" }],
			["/receipts invalid", { kind: "receipt-usage" }],

			// model
			["/model", { kind: "model" }],
			["/models", { kind: "model" }],
			["/model pattern:thinking", { kind: "model-set", pattern: "pattern:thinking" }],
			["/model provider/model:high:extra", { kind: "model-set", pattern: "provider/model:high:extra" }],
			["/models pattern:thinking", { kind: "model-set", pattern: "pattern:thinking" }],

			// compact
			["/compact", { kind: "compact", instructions: undefined }],
			["/compact    ", { kind: "compact", instructions: undefined }],
			["/compact my instructions", { kind: "compact", instructions: "my instructions" }],

			// context-view & aliases
			["/context-view", { kind: "context-view" }],
			["/context", { kind: "context-view" }],
			["/ctx", { kind: "context-view" }],

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

	it("builds slash autocomplete commands from commandReference usage", () => {
		const commands = buildSlashAutocompleteCommands();
		const byName = new Map(commands.map((command) => [command.name, command]));

		ok(!byName.has("status"), "retired /status command is not suggested");
		strictEqual(byName.get("quit")?.argumentHint, undefined);
		strictEqual(byName.get("help")?.argumentHint, "[command]");
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
