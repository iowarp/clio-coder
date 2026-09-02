import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionReloadOutcome } from "../../src/entry/extension-reload.js";
import {
	BUILTIN_SLASH_COMMANDS,
	dispatchSlashCommand,
	formatExtensionReloadNotice,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

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

const rejected: ExtensionReloadOutcome = {
	status: "rejected",
	reason: "build-failed",
	generation: 2,
	diagnostics: { entries: [{ type: "error", message: "listing failed" }], truncated: 0 },
	lines: ["[clio-coder:extensions] listing failed"],
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

describe("/resources extensions reload", () => {
	it("parses through the existing resources grammar and refuses unknown actions", () => {
		deepStrictEqual(parseSlashCommand("/resources extensions reload"), {
			kind: "resources",
			family: "extensions",
			action: "reload",
		});
		deepStrictEqual(parseSlashCommand("/resources extensions"), { kind: "resources", family: "extensions" });
		const unknown = parseSlashCommand("/resources extensions frobnicate");
		strictEqual(unknown.kind, "usage-error");
		const spec = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "resources");
		deepStrictEqual(spec?.args?.subcommands?.extensions?.positionals?.[0]?.values, ["reload"]);
	});

	it("runs the coordinator, reports the outcome, and reopens the overlay only on commit", () => {
		const success = context({ reloadExtensions: () => committed });
		dispatchSlashCommand(parseSlashCommand("/resources extensions reload"), success.ctx);
		deepStrictEqual(success.notices, [
			["success", "extensions: generation 3 committed (changed: +1 -0 ~1); hooks: 2 registered"],
		]);
		strictEqual(success.opened(), 1);

		const failure = context({ reloadExtensions: () => rejected });
		dispatchSlashCommand(parseSlashCommand("/resources extensions reload"), failure.ctx);
		deepStrictEqual(failure.notices, [
			["error", "extensions: reload rejected (build-failed); generation 2 stays active"],
			["warn", "[clio-coder:extensions] listing failed"],
		]);
		strictEqual(failure.opened(), 0);

		const absent = context({});
		dispatchSlashCommand(parseSlashCommand("/resources extensions reload"), absent.ctx);
		strictEqual(absent.notices[0]?.[0], "warn");
		strictEqual(absent.opened(), 0);

		const browse = context({ reloadExtensions: () => committed });
		dispatchSlashCommand(parseSlashCommand("/resources extensions"), browse.ctx);
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
