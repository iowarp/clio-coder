import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionReloadOutcome } from "../../src/entry/extension-reload.js";
import {
	BUILTIN_SLASH_COMMANDS,
	commandReference,
	dispatchSlashCommand,
	formatExtensionReloadNotice,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/session-control/slash-commands.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const committed: ExtensionReloadOutcome = {
	status: "committed",
	generation: 3,
	previousGeneration: 2,
	changed: true,
	digest: "d".repeat(64),
	added: ["ext-b"],
	removed: [],
	modified: ["ext-a"],
	diagnostics: { entries: [], truncated: 0 },
	hooks: { registered: 2, dropped: 0, fileIssues: 0, issues: 0, overridden: 0 },
	lines: [],
};

function context(overrides: Partial<SlashCommandContext>): {
	ctx: SlashCommandContext;
	notices: Array<[string, string]>;
	opened: () => number;
} {
	const notices: Array<[string, string]> = [];
	let opened = 0;
	const ctx = {
		notice: (level: string, text: string) => {
			notices.push([level, text]);
		},
		openExtensions: () => {
			opened += 1;
		},
		openPrompts: () => undefined,
		...overrides,
	} as unknown as SlashCommandContext;
	return { ctx, notices, opened: () => opened };
}

describe("/extensions", () => {
	it("uses the canonical harness route and refuses retired library spellings", () => {
		deepStrictEqual(parseSlashCommand("/extensions"), { kind: "resources", family: "extensions" });
		deepStrictEqual(parseSlashCommand("/extensions leave"), {
			kind: "resources",
			family: "extensions",
			action: "leave",
		});
		for (const input of ["/library extensions reload", "/extensions install", "/extensions leave extra"]) {
			strictEqual(parseSlashCommand(input).kind, "usage-error", input);
		}
		strictEqual(
			commandReference().some((entry) => entry.name === "extensions"),
			true,
		);
		const spec = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "extensions");
		deepStrictEqual(Object.keys(spec?.args?.subcommands ?? {}), ["dev", "mute", "unmute", "leave"]);
	});

	it("opens the overlay, and leave says when no workspace is active", () => {
		const leave = context({});
		dispatchSlashCommand(parseSlashCommand("/extensions leave"), leave.ctx);
		deepStrictEqual(leave.notices, [["info", "No extension workspace is active"]]);

		const browse = context({});
		dispatchSlashCommand(parseSlashCommand("/extensions"), browse.ctx);
		deepStrictEqual(browse.notices, []);
		strictEqual(browse.opened(), 1);
	});

	it("downgrades the notice to warn when hooks were dropped or had issues", () => {
		deepStrictEqual(
			formatExtensionReloadNotice({
				...committed,
				changed: false,
				hooks: { registered: 1, dropped: 1, fileIssues: 1, issues: 1, overridden: 1 },
			}),
			["warn", "extensions: generation 3 committed (unchanged); hooks: 1 registered, 1 dropped, 2 issues, 1 overridden"],
		);
	});
});

it("routes MCP listing and trust mutations through the slash harness", async () => {
	const env = await isolateClioEnv("clio-mcp-slash-");
	const previous = process.cwd();
	try {
		mkdirSync(join(env.dir, ".clio-coder"));
		writeFileSync(join(env.dir, ".clio-coder", "mcp.yaml"), "version: 1\nservers:\n  - id: files\n    command: node\n");
		process.chdir(env.dir);
		const harness = context({});
		for (const input of ["/mcp", "/mcp trust files read", "/mcp", "/mcp untrust files", "/mcp trust missing"])
			dispatchSlashCommand(parseSlashCommand(input), harness.ctx);
		strictEqual(harness.notices.length, 5);
		strictEqual(harness.notices[0]?.[1].includes("trust=untrusted"), true);
		strictEqual(harness.notices[1]?.[1].includes("mcp: trusted files"), true);
		strictEqual(harness.notices[2]?.[1].includes("trust=trusted actionClass=read"), true);
		strictEqual(harness.notices[3]?.[1], "mcp: untrusted files (record removed)");
		strictEqual(harness.notices[4]?.[0], "error");
		strictEqual(
			commandReference().some((entry) => entry.name === "mcp"),
			true,
		);
	} finally {
		process.chdir(previous);
		env.restore();
	}
});
