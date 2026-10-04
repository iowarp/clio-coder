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
	it("is an argument-free Configure command", () => {
		deepStrictEqual(parseSlashCommand("/upgrade"), { kind: "upgrade" });
		strictEqual(parseSlashCommand("/upgrade now").kind, "usage-error");
		const reference = commandReference().find((entry) => entry.name === "upgrade");
		strictEqual(reference?.group, "Configure");
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
