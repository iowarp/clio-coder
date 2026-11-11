import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	newReportId,
	outboxEntry,
	prefillLink,
	REPORT_URL_BUDGET,
	type RenderedReport,
	type ReportCommandRunner,
	routeFor,
	sendReport,
} from "../../src/domains/report/index.js";

const gh = { kind: "gh", login: "octo", path: "/usr/bin/gh" } as const;

function rendered(problem: string): RenderedReport {
	const id = newReportId();
	const details = `\`\`\`clio-coder-report\nv: 1\nid: ${id}\n\`\`\``;
	return {
		id,
		title: 'fix(dispatch): `x` says $(whoami) and "quotes"',
		body: `### What happened\n\n${problem}\n\n${details}\n`,
		masks: [],
		fields: { problem, expected: "it keeps going", reproduce: "1. run it", environment: "linux-x64", details },
	};
}

function runner(
	answer: (args: ReadonlyArray<string>) => { exitCode: number | null; stdout?: string; timedOut?: boolean },
) {
	const calls: string[][] = [];
	const run: ReportCommandRunner = async (_file, args) => {
		calls.push([...args]);
		const reply = answer(args);
		return { exitCode: reply.exitCode, stdout: reply.stdout ?? "", stderr: "", timedOut: reply.timedOut ?? false };
	};
	return { run, calls };
}

test("gh creates the issue from a body file under the reports directory; argv never carries the body", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-transport-"));
	const report = rendered("The loop stopped with `rm -rf $(pwd)` in a 'quoted'\nline.");
	const fake = runner(() => ({ exitCode: 0, stdout: "https://github.com/iowarp/clio-coder/issues/501\n" }));
	const result = await sendReport(report, routeFor("bug"), gh, { kind: "create" }, { stateDir, run: fake.run });

	deepStrictEqual(result, {
		status: "sent",
		url: "https://github.com/iowarp/clio-coder/issues/501",
		number: 501,
		adopted: false,
	});
	strictEqual(fake.calls.length, 1);
	const argv = fake.calls[0] ?? [];
	ok(!argv.some((arg) => arg.includes("The loop stopped")));
	ok(argv.includes("github.com/iowarp/clio-coder") && argv.includes(`--title=${report.title}`));
	const bodyFile = argv[argv.indexOf("--body-file") + 1] ?? "";
	ok(bodyFile.startsWith(join(stateDir, "reports", "drafts")));
	strictEqual(readFileSync(bodyFile, "utf8"), report.body);
	strictEqual(outboxEntry(stateDir, report.id)?.state, "sent");
});

test("a create cut off before the outbox update is retried by adopting the issue it filed", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-transport-"));
	const report = rendered("The loop stopped after the third tool call with nothing on screen.");
	const killed = runner(() => ({ exitCode: null, timedOut: true }));
	const first = await sendReport(report, routeFor("bug"), gh, { kind: "create" }, { stateDir, run: killed.run });
	strictEqual(first.status, "failed");
	strictEqual(outboxEntry(stateDir, report.id)?.state, "sending");

	const retry = runner((args) =>
		args.includes("repos/iowarp/clio-coder/issues")
			? { exitCode: 0, stdout: "https://github.com/iowarp/clio-coder/issues/502\n" }
			: { exitCode: 0, stdout: "https://github.com/iowarp/clio-coder/issues/999\n" },
	);
	const second = await sendReport(report, routeFor("bug"), gh, { kind: "create" }, { stateDir, run: retry.run });
	deepStrictEqual(second, {
		status: "sent",
		url: "https://github.com/iowarp/clio-coder/issues/502",
		number: 502,
		adopted: true,
	});
	strictEqual(retry.calls.length, 1);
	ok(retry.calls[0]?.some((arg) => arg.includes(report.id)));
	strictEqual(outboxEntry(stateDir, report.id)?.number, 502);
});

test("a discussion whose create timed out is adopted from the newest discussions, not the lagging search", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-transport-"));
	const report = rendered("The question lost its answer after a restart.");
	const killed = runner((args) =>
		args.some((arg) => arg.includes("discussionCategories"))
			? { exitCode: 0, stdout: "R_1\tC_1\n" }
			: { exitCode: null, timedOut: true },
	);
	const first = await sendReport(report, routeFor("question"), gh, { kind: "create" }, { stateDir, run: killed.run });
	strictEqual(first.status, "failed");
	strictEqual(outboxEntry(stateDir, report.id)?.state, "sending");

	const url = "https://github.com/iowarp/clio-coder/discussions/77";
	const retry = runner((args) => {
		if (args.some((arg) => arg.includes("discussionCategories"))) return { exitCode: 0, stdout: "R_1\tC_1\n" };
		if (args.some((arg) => arg.includes("createDiscussion")))
			return { exitCode: 0, stdout: `${url.replace("77", "78")}\n` };
		// The search index has not caught up; only the repository's own discussion list shows the new one.
		if (args.some((arg) => arg.includes("search("))) return { exitCode: 0, stdout: "" };
		return { exitCode: 0, stdout: `${url}\n` };
	});
	const second = await sendReport(report, routeFor("question"), gh, { kind: "create" }, { stateDir, run: retry.run });
	deepStrictEqual(second, { status: "sent", url, number: 77, adopted: true });
	ok(!retry.calls.some((args) => args.some((arg) => arg.includes("createDiscussion"))));
});

test("a timed-out discussion older than the newest thirty is still adopted through search", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-transport-"));
	const report = rendered("Thirty other discussions were opened before the retry.");
	const killed = runner((args) =>
		args.some((arg) => arg.includes("discussionCategories"))
			? { exitCode: 0, stdout: "R_1\tC_1\n" }
			: { exitCode: null, timedOut: true },
	);
	await sendReport(report, routeFor("question"), gh, { kind: "create" }, { stateDir, run: killed.run });
	const url = "https://github.com/iowarp/clio-coder/discussions/77";
	const retry = runner((args) => {
		if (args.some((arg) => arg.includes("discussionCategories"))) return { exitCode: 0, stdout: "R_1\tC_1\n" };
		if (args.some((arg) => arg.includes("createDiscussion")))
			return { exitCode: 0, stdout: `${url.replace("77", "78")}\n` };
		// By now the search index has it, but it has fallen out of the newest thirty.
		if (args.some((arg) => arg.includes("search("))) return { exitCode: 0, stdout: `${url}\n` };
		return { exitCode: 0, stdout: "" };
	});
	const second = await sendReport(report, routeFor("question"), gh, { kind: "create" }, { stateDir, run: retry.run });
	deepStrictEqual(second, { status: "sent", url, number: 77, adopted: true });
	ok(!retry.calls.some((args) => args.some((arg) => arg.includes("createDiscussion"))));
});

test("the prefilled link stays under its budget and keeps the title and the start of the problem", () => {
	const paragraph = "The loop stopped after a tool call and printed nothing at all, again and again. ";
	const report = rendered(Array.from({ length: 40 }, () => paragraph.repeat(4)).join("\n\n"));
	const link = prefillLink(report, routeFor("bug"));
	ok(link?.cut);
	ok(Buffer.byteLength(link.url) <= REPORT_URL_BUDGET);
	const params = new URL(link.url).searchParams;
	strictEqual(params.get("template"), "bug_report.yml");
	strictEqual(params.get("title"), report.title);
	ok(params.get("problem")?.startsWith(paragraph.trim()));
	ok(params.get("problem")?.endsWith("paste the rest here._"));
	strictEqual(params.get("details"), report.fields.details);
});
