import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_REPORT_STATE, keySends, reportControls, reportReducer } from "../client/report/report-model.js";
import type { ProblemReportView } from "../contracts/problem-reports.js";
import { ProblemReportsService } from "../server/services/problem-reports.js";

const view = (gates: string[]): ProblemReportView => ({
	draftId: "rpt_01JZ0000000000000000000000",
	state: "draft",
	headline: "Public, posted from your gh account to github.com/iowarp/clio-coder",
	plan: {
		postedAs: "posted from your gh account",
		destination: "github.com/iowarp/clio-coder",
		rendered: { title: "A title long enough", body: "body\n" },
		maskSummary: "Masked by Clio: nothing.",
		actions: ["search", "post"],
		bundle: null,
		consent: "none",
		credit: false,
		gates,
		rateWarning: null,
	},
	masks: [],
	fields: { title: "A title long enough", happened: "x", expected: "", reproduce: "" },
	sendable: true,
});

test("report dialog: Send is off under a failing gate or unplanned edits, and Enter never sends", () => {
	const blocked = reportReducer(INITIAL_REPORT_STATE, { type: "planned", view: view(["title too short"]) });
	assert.equal(reportControls(blocked).sendEnabled, false);
	assert.match(reportControls(blocked).destination, /nothing sent yet$/);
	const ready = reportReducer(INITIAL_REPORT_STATE, { type: "planned", view: view([]) });
	assert.equal(reportControls(ready).sendEnabled, true);
	const edited = reportReducer(ready, { type: "edit", field: "title", value: "Another title here" });
	assert.equal(reportControls(edited).sendEnabled, false);
	assert.equal(keySends("Enter", "field"), false);
	assert.equal(keySends("Enter", "other"), false);
	assert.equal(keySends("Enter", "send-button"), true);
});

test("report routes: plan makes no send call; send calls the host once", async () => {
	const calls: string[] = [];
	const ops = {
		call: async (method: string) => {
			calls.push(method);
			if (method === "reports.send")
				return { status: "sent", draftId: view([]).draftId, state: "sent", line: "sent", url: null };
			return view([]);
		},
	} as unknown as ConstructorParameters<typeof ProblemReportsService>[0];
	const service = new ProblemReportsService(ops, { get: async () => ({ path: "/w" }) } as never);
	await service.plan("w", { kind: "bug" });
	await service.update("w", view([]).draftId, { title: "Another title here" });
	assert.deepEqual(calls, ["reports.plan", "reports.update"]);
	const sent = await service.send("w", view([]).draftId, { consent: true });
	assert.equal(sent.status, "sent");
	assert.equal(calls.filter((method) => method === "reports.send").length, 1);
});
