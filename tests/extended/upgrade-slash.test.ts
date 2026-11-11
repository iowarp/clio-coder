import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/session-control/slash-commands.js";

function context(overrides: Partial<SlashCommandContext> = {}): {
	ctx: SlashCommandContext;
	notices: Array<[string, string]>;
} {
	const notices: Array<[string, string]> = [];
	return {
		notices,
		ctx: {
			notice: (level: string, text: string) => notices.push([level, text]),
			...overrides,
		} as unknown as SlashCommandContext,
	};
}

describe("/upgrade", () => {
	it("is an argument-free Clio command", () => {
		deepStrictEqual(parseSlashCommand("/upgrade"), { kind: "upgrade" });
		strictEqual(parseSlashCommand("/upgrade now").kind, "usage-error");
		const reference = commandReference().find((entry) => entry.name === "upgrade");
		strictEqual(reference?.group, "Clio");
		strictEqual(reference?.usage, "/upgrade");
	});

	it("starts the host-owned review flow and refuses hosts that cannot show it", () => {
		let starts = 0;
		const wired = context({ startUpgrade: () => starts++ });
		dispatchSlashCommand(parseSlashCommand("/upgrade"), wired.ctx);
		strictEqual(starts, 1);
		deepStrictEqual(wired.notices, []);

		const unwired = context();
		strictEqual(dispatchSlashCommand(parseSlashCommand("/upgrade"), unwired.ctx), "rejected");
		match(unwired.notices[0]?.[1] ?? "", /run clio-coder upgrade from a shell/u);
	});
});

describe("one usage answer", () => {
	it("rejects a bad flag as an error and a bare command as information, keeping the draft both times", () => {
		const bad = context();
		strictEqual(
			dispatchSlashCommand(parseSlashCommand("/council --rounds 99 compare the two parsers"), bad.ctx),
			"rejected",
		);
		strictEqual(bad.notices[0]?.[0], "error");
		match(bad.notices[0]?.[1] ?? "", /^--rounds must be an integer 1\.\.\d+\. usage: \/council /u);
		const bare = context();
		strictEqual(dispatchSlashCommand(parseSlashCommand("/run"), bare.ctx), "rejected");
		deepStrictEqual(
			bare.notices.map(([level]) => level),
			["info"],
		);
		match(bare.notices[0]?.[1] ?? "", /^usage: \/run /u);
	});
});

describe("commands that became keys", () => {
	it("answers a bare /interrupt with its key and spends the line", () => {
		const bare = context();
		strictEqual(dispatchSlashCommand(parseSlashCommand("/interrupt"), bare.ctx), "accepted");
		deepStrictEqual(bare.notices, [["info", "/interrupt is now a key: press Alt+S."]]);
		const typo = context();
		strictEqual(dispatchSlashCommand(parseSlashCommand("/constructor"), typo.ctx), "rejected");
	});
});
