import assert from "node:assert/strict";
import test from "node:test";
import {
	attachView,
	failedRunReport,
	INITIAL_REPORT_STATE,
	keySends,
	offerNotice,
	reportControls,
	reportReducer,
	sendChoices,
} from "../client/report/report-model.js";
import type { ProblemReportBundle, ProblemReportView } from "../contracts/problem-reports.js";
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

const bundle: ProblemReportBundle = {
	draftId: "rpt_01JZ0000000000000000000000",
	sha256: "a".repeat(64),
	bytes: 2048,
	transcript: null,
	readable: { model: ["m-1"], runtime: [], tool: ["read"], token: [] },
	anonymized: [{ kind: "path", count: 2 }],
	withheld: 1,
	kept: ["Versions"],
	neverKept: ["File contents"],
	consent: { debug: "Used to debug this report.", transcript: "Includes the last turns." },
	members: [{ name: "report.json", text: "{}" }],
};

test("report dialog attach: nothing is attached without the consent radio, and a transcript change withdraws it", () => {
	const ready = reportReducer(INITIAL_REPORT_STATE, { type: "planned", view: view([]) });
	assert.equal(attachView(ready).viewEnabled, false);
	assert.equal(attachView(ready).attachOffered, false);
	const built = reportReducer(ready, { type: "bundled", bundle });
	const shown = attachView(built);
	assert.equal(shown.viewEnabled, true);
	assert.deepEqual(shown.readable, ["Models: m-1", "Tools: read"]);
	assert.deepEqual(shown.anonymized, ["path × 2"]);
	assert.equal(reportReducer(built, { type: "viewer", open: true }).viewer, true);
	// Built and reviewed, but the radio still says no bundle.
	assert.equal(sendChoices(built).bundle, "none");
	const agreed = reportReducer(built, { type: "attach", value: "debug" });
	assert.equal(sendChoices(agreed).bundle, "debug");
	assert.equal(reportControls(agreed).sendEnabled, true);
	const changed = reportReducer(agreed, { type: "transcript", value: true });
	assert.equal(changed.bundle, null);
	assert.equal(sendChoices(changed).bundle, "none");
	const stale = reportReducer(changed, { type: "attach", value: "debug" });
	assert.equal(reportControls(stale).sendEnabled, false);
});

test("report offers: the host's offer shows as a notice; a refusal, the setting off, or a dismissal shows nothing", () => {
	const offered = { offer: { text: "Clio stopped on an internal error.", fingerprint: "f1" }, refusal: null };
	assert.deepEqual(offerNotice(offered, new Set()), {
		fingerprint: "f1",
		text: "Clio stopped on an internal error.",
		link: "Review a report",
	});
	assert.equal(offerNotice({ offer: null, refusal: "setting-off" }, new Set()), null);
	assert.equal(offerNotice({ offer: null, refusal: "within-seven-days" }, new Set()), null);
	assert.equal(offerNotice(offered, new Set(["f1"])), null);
	assert.equal(offerNotice(undefined, new Set()), null);
});

test("report this on a failed run: drafts from the run's session with a title naming the run", () => {
	assert.deepEqual(failedRunReport({ runId: "r1", agentId: "scout", state: "failed" }, "s1"), {
		sessionId: "s1",
		summary: "Worker run scout failed (r1)",
	});
	assert.equal(failedRunReport({ runId: "r1", agentId: "scout", state: "done" }, "s1"), null);
});

test("report dialog: the credit label states the current choice", () => {
	assert.match(reportControls(INITIAL_REPORT_STATE).creditLabel, /\(credit: no\)$/);
	const ready = reportReducer(INITIAL_REPORT_STATE, { type: "planned", view: view([]) });
	assert.match(reportControls(ready).creditLabel, /\(credit: no\)$/);
	const credited = reportReducer(ready, { type: "credit", value: true });
	assert.match(reportControls(credited).creditLabel, /\(credit: yes\)$/);
});
