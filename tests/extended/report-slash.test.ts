import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
	type SlashReportRequest,
} from "../../src/session-control/slash-commands.js";

describe("/report", () => {
	it("parses the bare command, a kind with a summary, and sending a saved draft", () => {
		deepStrictEqual(parseSlashCommand("/report"), { kind: "report", report: "bug" });
		deepStrictEqual(parseSlashCommand("/report bug x"), { kind: "report", report: "bug", summary: "x" });
		deepStrictEqual(parseSlashCommand("/report send rpt_01JABCDEF"), {
			kind: "report-send",
			draftId: "rpt_01JABCDEF",
		});
		strictEqual(parseSlashCommand("/report the footer flickers").kind, "usage-error");

		const opened: SlashReportRequest[] = [];
		const ctx = {
			notice: () => {},
			render: () => {},
			openReport: (request: SlashReportRequest) => {
				opened.push(request);
			},
		} as unknown as SlashCommandContext;
		dispatchSlashCommand(parseSlashCommand("/report send rpt_01JABCDEF"), ctx);
		deepStrictEqual(opened, [{ kind: "draft", draftId: "rpt_01JABCDEF" }]);
	});
});
