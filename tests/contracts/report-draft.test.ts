import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	isFixedPoint,
	type LocalIdentity,
	newReportId,
	parseReportBlock,
	type ReportDraft,
	renderReport,
	scrubText,
} from "../../src/domains/report/index.js";

const identity: LocalIdentity = {
	packageRoot: "/opt/pkgs/node_modules/@iowarp/clio-coder",
	paths: ["/home/alice", "/home/alice/work/acme-app"],
	remotes: [],
	names: [
		{ kind: "host", value: "lab-node7" },
		{ kind: "user", value: "alice" },
		{ kind: "project", value: "acme-app" },
	],
};

function draft(happened: string): ReportDraft {
	return {
		id: newReportId(Date.parse("2026-11-09T00:00:00Z")),
		createdAt: "2026-11-09T00:00:00.000Z",
		kind: "bug",
		origin: "operator",
		title: "fix: the loop stopped early on lab-node7",
		sections: { happened, operatorWords: "it just stopped", expected: "", reproduce: "", notKnown: [] },
		observed: [{ code: "turn-ended", values: { stopReason: "error", cause: "internal", stage: "send", retries: 2 } }],
		environment: {
			clioCoder: "0.7.1-dev",
			platform: "linux-x64",
			node: "24.1",
			install: "installer",
			surface: "tui",
			autonomy: "default",
			runtime: null,
			model: null,
		},
		includeModel: false,
		area: "dispatch",
		trigger: "operator",
		cause: "internal",
		fingerprint: null,
		links: [445],
		sessionId: null,
		unmasked: [],
	};
}

test("the scrubber masks this machine's path, host, remote, e-mail and a token, and one mask can be let through", () => {
	const token = `ghp_${"a1B2".repeat(9)}`;
	const text = `In /home/alice/work/acme-app/src/x.ts on lab-node7, remote git@github.com:org/private.git, mail alice.s@example.org, key ${token}.`;
	const scrubbed = scrubText(text, identity);
	ok(!scrubbed.text.includes("alice") && !scrubbed.text.includes("lab-node7") && !scrubbed.text.includes(token));
	for (const marker of ["<path>", "<host>", "<remote>", "<email>", "[redacted:github-token]"])
		ok(scrubbed.text.includes(marker), marker);
	deepStrictEqual(scrubbed.masks.map((mask) => mask.kind).sort(), ["email", "host", "path", "remote", "secret"]);

	const host = scrubbed.masks.find((mask) => mask.kind === "host")?.id ?? "";
	const unmasked = scrubText(text, identity, [host, "secret"]);
	strictEqual(unmasked.text, scrubbed.text.replace("<host>", "lab-node7"));
});

test("names beside . _ - and escapes, spaced and non-ASCII path tails, flagged paths and IPv6 are masked (R2-safety-secrets-10)", () => {
	const cases: Array<[string, string]> = [
		["host lab-node7.local and alice.pem", "host <host>.local and <user>.pem"],
		["/home/alice/My Secret Project/plan.md is gone", "<path> is gone"],
		["acme-app_test and id_alice", "<project>_test and id_<user>"],
		['{"log":"user\\nalice\\tok"}', '{"log":"user\\n<user>\\tok"}'],
		["see %2Fsrv%2Falice%2Fwork", "see %2Fsrv%2F<user>%2Fwork"],
		["~bob/secret-proj/x.ts and -I/opt/inc/x", "<path> and -I<path>"],
		["C:\\Users\\Bob Smith\\Documents\\secret.txt", "<path>"],
		["/srv/josé/notes/x.md", "<path>"],
		["fe80::1ff:fe23:4567:890a and 2001:db8::7, not ::1 or 10:30:00", "<ip> and <ip>, not ::1 or 10:30:00"],
	];
	for (const [raw, expected] of cases) strictEqual(scrubText(raw, identity).text, expected, raw);
});

test("a rendered report is a fixed point of the scrubber, hostile prose included", () => {
	const hostile = [
		"see https://example.com/home/alice/x?p=/home/alice/y and https://github.com/iowarp/clio-coder/issues/445.",
		"(/home/alice/a.ts:12), path:/srv/data/x, ~/notes/today.md; C:\\Users\\alice\\x.txt",
		"alicewonder kept, alice's name and Alice masked, acme-app/src kept as project, 10.1.2.3:8080 and 127.0.0.1",
		"/opt/pkgs/node_modules/@iowarp/clio-coder/dist/cli/index.js crashed; user@host.example:team/repo.git",
	].join("\n");
	const rendered = renderReport(draft(hostile), identity);
	ok(isFixedPoint(rendered, identity));
	ok(rendered.body.includes("alicewonder kept"));
	ok(rendered.body.includes("clio-coder/dist/cli/index.js crashed"));
	ok(rendered.body.includes("https://github.com/iowarp/clio-coder/issues/445."));
	ok(!/alice\b|lab-node7|10\.1\.2\.3|\/srv\/data/u.test(rendered.body.replace("alicewonder", "")));
	ok(rendered.body.includes("The last turn ended (`error`) on `internal` at stage `send` after 2 retries."));
	strictEqual(rendered.title, "fix(dispatch): the loop stopped early on <host>");
});

test("the rendered block parses back to the draft's facts", () => {
	const source = draft("The loop stopped after the third tool call with nothing on screen.");
	const block = parseReportBlock(renderReport(source, identity).body);
	deepStrictEqual(block, {
		v: "1",
		id: source.id,
		kind: "bug",
		area: "dispatch",
		surface: "tui",
		version: "0.7.1-dev",
		os: "linux",
		install: "installer",
		trigger: "operator",
		cause: "internal",
		fingerprint: "none",
		links: "#445",
		regression: "no",
		bundle: "none",
		consent: "none",
		credit: "no",
	});
});
