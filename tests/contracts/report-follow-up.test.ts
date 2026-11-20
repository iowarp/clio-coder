import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	composeReportDraft,
	type ReportCommandRunner,
	readOutbox,
	reportRows,
	runReplyCheck,
	saveReportDraft,
	takeFixedReportNotices,
	updateOutbox,
} from "../../src/domains/report/index.js";

const ID = "rpt_01JABCDEFGHJKMNPQRSTVWXYZ0";

test("report follow-up: the reply check is opt-in and daily, and the thank-you shows once", async () => {
	const stateDir = join(mkdtempSync(join(tmpdir(), "report-follow-up-")), "state");
	updateOutbox(stateDir, ID, {
		kind: "bug",
		title: "fix: diff view is empty",
		route: "issue",
		transport: "gh",
		state: "sent",
		url: "https://github.com/iowarp/clio-coder/issues/452",
		number: 452,
		sentAt: "2026-11-01T00:00:00.000Z",
	});
	const calls: string[][] = [];
	const run: ReportCommandRunner = async (_file, args) => {
		calls.push([...args]);
		const comments = [{ author: { login: "maint" }, authorAssociation: "OWNER", createdAt: "2026-11-02T00:00:00Z" }];
		return {
			exitCode: 0,
			stdout: JSON.stringify({ state: "OPEN", stateReason: "", comments }),
			stderr: "",
			timedOut: false,
		};
	};
	let clock = new Date("2026-11-03T00:00:00.000Z");
	const deps = { run, findGh: () => "/usr/bin/gh", env: {}, now: () => clock };

	deepStrictEqual(await runReplyCheck(stateDir, deps), []);
	strictEqual(calls.length, 0, "no tick, no gh call");

	updateOutbox(stateDir, ID, { kind: "bug", title: "fix: diff view is empty", replyCheck: "2026-11-01T00:00:00.000Z" });
	deepStrictEqual(await runReplyCheck(stateDir, { ...deps, env: { CI: "1" } }), []);
	strictEqual(calls.length, 0, "CI disables the check");
	deepStrictEqual(await runReplyCheck(stateDir, deps), ["The maintainers replied on your report #452. /report status"]);
	clock = new Date("2026-11-03T06:00:00.000Z");
	deepStrictEqual(await runReplyCheck(stateDir, deps), []);
	strictEqual(calls.length, 1, "a second boot the same day makes no call");

	const changelog = "## 0.7.2 - 2026-11-20\n\n- The diff view shows the change again (#452).\n\n## 0.7.1 - 2026-11-09\n";
	const upgrade = { from: "0.7.1", to: "0.7.2" };
	deepStrictEqual(takeFixedReportNotices(stateDir, upgrade, { changelog, env: { CI: "1" } }), []);
	deepStrictEqual(takeFixedReportNotices(stateDir, upgrade, { changelog, env: {} }), [
		"0.7.2 fixes #452, which you reported. Thank you.",
	]);
	deepStrictEqual(takeFixedReportNotices(stateDir, upgrade, { changelog, env: {} }), []);
	strictEqual(readOutbox(stateDir)[ID]?.thanked, true);
});

test("report follow-up: pruning a report closed over a year ago deletes its draft, so it never lists as sendable again", () => {
	const stateDir = join(mkdtempSync(join(tmpdir(), "report-prune-")), "state");
	const OLD = "rpt_01JABCDEFGHJKMNPQRSTVWXYZ1";
	saveReportDraft(stateDir, {
		...composeReportDraft({ kind: "bug", surface: "tui", title: "fix: an old one", happened: "x" }),
		id: OLD,
	});
	updateOutbox(stateDir, OLD, {
		kind: "bug",
		title: "fix: an old one",
		state: "sent",
		sentAt: "2020-01-01T00:00:00.000Z",
		lastSeen: { state: "CLOSED", comments: 0, at: "2020-02-01T00:00:00.000Z" },
	});
	updateOutbox(stateDir, ID, { kind: "bug", title: "fix: a new one" });
	strictEqual(readOutbox(stateDir)[OLD], undefined);
	deepStrictEqual(
		reportRows(stateDir).map((row) => row.id),
		[ID],
	);
});
