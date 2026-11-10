import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	applyVerdict,
	findRelated,
	newReportId,
	type ReportCommandRunner,
	type ReportDraft,
	titleTokens,
} from "../../src/domains/report/index.js";

const gh = { kind: "gh", login: "octo", path: "/usr/bin/gh" } as const;
const now = () => new Date("2026-11-10T00:00:00Z");
const TITLE = "fix(dispatch): the loop stops after a tool call without any reply";
const CHANGELOG = [
	"## 0.7.1 - 2026-11-09",
	"- The loop no longer stops after a tool call without a reply (#445).",
	"## 0.7.0 - 2026-11-08",
	"- Something else (#400).",
].join("\n");

function draft(version: string, fingerprint: string | null = null): ReportDraft {
	return {
		id: newReportId(),
		createdAt: "2026-11-10T00:00:00.000Z",
		kind: "bug",
		origin: "operator",
		title: TITLE,
		sections: { happened: "", operatorWords: "", expected: "", reproduce: "", notKnown: [] },
		observed: [],
		environment: {
			clioCoder: version,
			platform: "linux-x64",
			node: "24.1",
			install: "npm",
			surface: "tui",
			autonomy: "default",
			runtime: null,
			model: null,
		},
		includeModel: false,
		area: "dispatch",
		trigger: fingerprint === null ? "operator" : "crash",
		cause: null,
		fingerprint,
		links: [],
		sessionId: null,
		unmasked: [],
	};
}

const issue445 = {
	number: 445,
	title: "fix(dispatch): loop stops after a tool call without a reply",
	state: "closed",
	closed_at: "2026-11-01T00:00:00Z",
	updated_at: "2026-11-01T00:00:00Z",
	labels: ["area:dispatch"],
};

/** Canned GitHub: a fingerprint query, a title query, and the latest release. */
function github(answers: { fingerprint?: unknown[]; title?: unknown[]; latest?: string }) {
	const queries: string[] = [];
	const run: ReportCommandRunner = async (_file, args) => {
		const q = args.find((arg) => arg.startsWith("q="));
		if (q !== undefined) queries.push(q);
		const items = q === undefined ? null : q.includes('"fp_') ? answers.fingerprint : answers.title;
		const stdout = items === null ? `${answers.latest ?? "v0.7.1"}\n` : JSON.stringify(items ?? []);
		return { exitCode: 0, stdout, stderr: "", timedOut: false };
	};
	return { run, queries };
}

test("a fingerprint found in an open issue comes first with the comment default", async () => {
	const open = { ...issue445, number: 512, title: "crash in the tui", state: "open", closed_at: null };
	const canned = github({ fingerprint: [open], title: [issue445] });
	const result = await findRelated(draft("0.7.1", "fp_0123456789ab"), { title: TITLE }, gh, {
		run: canned.run,
		changelog: CHANGELOG,
		now,
	});
	strictEqual(result.matches[0]?.number, 512);
	strictEqual(result.matches[0]?.fingerprintHit, true);
	strictEqual(result.verdict.kind, "comment");
	ok(canned.queries.some((q) => q.includes('"fp_0123456789ab" in:body')));
});

test("a closed match fixed in the installed version is a regression; on an older install it is the upgrade stop", async () => {
	const fixed = await findRelated(draft("0.7.1"), { title: TITLE }, gh, {
		run: github({ title: [issue445] }).run,
		changelog: CHANGELOG,
		now,
	});
	strictEqual(fixed.verdict.kind, "regression");
	strictEqual(fixed.matches[0]?.fixedIn, "0.7.1");
	const filed = applyVerdict(draft("0.7.1"), fixed.verdict);
	deepStrictEqual([filed.links, filed.regression], [[445], true]);

	const older = await findRelated(draft("0.6.9"), { title: TITLE }, gh, {
		run: github({ title: [issue445], latest: "v0.7.1" }).run,
		changelog: "## 0.6.9 - 2026-10-01\n- Something else (#400).\n",
		now,
	});
	deepStrictEqual(older.verdict, {
		kind: "upgrade",
		issue: older.matches[0],
		installed: "0.6.9",
		latest: "0.7.1",
	});
});

test("the title query drops the prefix, stop words, placeholders and redaction markers", async () => {
	const scrubbed = "fix(dispatch): regression: the loop stalls on <host> with [redacted:github-token] in <path> config";
	deepStrictEqual(titleTokens(scrubbed), ["config", "stalls", "loop"]);
	const canned = github({ title: [] });
	await findRelated(draft("0.7.1"), { title: scrubbed }, gh, { run: canned.run, changelog: null, now });
	deepStrictEqual(canned.queries, ["q=repo:iowarp/clio-coder is:issue config stalls loop"]);
});
