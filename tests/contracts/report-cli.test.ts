import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type ReportCliDeps, runReport } from "../../src/cli/report.js";
import type { ReportCommandRunner } from "../../src/domains/report/index.js";

const HAPPENED = "The footer flickered on every keystroke while a long turn streamed tool output.";

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "report-cli-"));
	const bodyFile = join(dir, "p.md");
	writeFileSync(bodyFile, HAPPENED);
	const calls: Array<{ file: string; args: string[] }> = [];
	const run: ReportCommandRunner = async (file, args) => {
		calls.push({ file, args: [...args] });
		const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
		if (file === "git") return { exitCode: 1, stdout: "", stderr: "not a repository", timedOut: false };
		if (args[0] === "auth") return reply("");
		if (args.includes("user")) return reply("octo\n");
		if (args.includes("search/issues")) return reply("[]");
		if (args.some((arg) => arg.endsWith("releases/latest"))) return reply("v0.0.1\n");
		if (args[0] === "issue" && args[1] === "create") return reply("https://github.com/iowarp/clio-coder/issues/452\n");
		return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
	};
	let out = "";
	let err = "";
	const deps: ReportCliDeps = {
		run,
		findGh: () => "/usr/bin/gh",
		browserAvailable: () => false,
		open: () => false,
		env: {},
		interactive: false,
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
		cwd: dir,
		stateDir: join(dir, "state"),
		identitySettings: {},
		changelog: null,
	};
	return { bodyFile, calls, deps, output: () => ({ out, err }) };
}

const compose = (bodyFile: string) => ["bug", "--title", "fix: x fails on y", "--body-file", bodyFile];

test("a dry run prints the whole preview, exits 0 and asks gh nothing", async () => {
	const { bodyFile, calls, deps, output } = scratch();
	strictEqual(await runReport([...compose(bodyFile), "--dry-run"], deps), 0);
	deepStrictEqual(
		calls.filter((call) => call.file !== "git"),
		[],
	);
	const { out } = output();
	ok(out.includes("Public, posted from your gh account to github.com/iowarp/clio-coder"));
	ok(out.includes("fix: x fails on y"));
	ok(out.includes(HAPPENED));
	ok(out.includes("Sending will, in this order:"));

	const json = scratch();
	strictEqual(await runReport([...compose(json.bodyFile), "--dry-run", "--json"], json.deps), 0);
	const parsed = JSON.parse(json.output().out) as { rendered: { body: string } };
	const plain = scratch();
	await runReport([...compose(plain.bodyFile), "--dry-run"], plain.deps);
	const body = parsed.rendered.body.replace(/rpt_[0-9A-Z]{26}/u, "<id>");
	ok(
		plain
			.output()
			.out.replace(/rpt_[0-9A-Z]{26}/u, "<id>")
			.includes(body),
	);
});

test("outside a terminal without --yes nothing is sent and the exit names --yes", async () => {
	const { bodyFile, calls, deps, output } = scratch();
	strictEqual(await runReport(compose(bodyFile), deps), 2);
	ok(output().err.includes("--yes"));
	strictEqual(calls.filter((call) => call.args[0] === "issue").length, 0);
});

test("the preview before consent asks gh nothing, not even auth status", async () => {
	const { bodyFile, calls, deps, output } = scratch();
	strictEqual(await runReport(compose(bodyFile), deps), 2);
	ok(output().out.includes("fix: x fails on y"));
	deepStrictEqual(
		calls.filter((call) => call.file !== "git"),
		[],
	);
});

test("--yes with a signed-in gh files the issue once and status lists it", async () => {
	const { bodyFile, calls, deps, output } = scratch();
	strictEqual(await runReport([...compose(bodyFile), "--yes"], deps), 0);
	strictEqual(calls.filter((call) => call.args[0] === "issue" && call.args[1] === "create").length, 1);
	ok(output().out.includes("https://github.com/iowarp/clio-coder/issues/452"));
	strictEqual(await runReport(["status"], deps), 0);
	ok(
		/rpt_[0-9A-Z]{26}\s+sent\s+bug\s+fix: x fails on y\s+https:\/\/github\.com\/iowarp\/clio-coder\/issues\/452/u.test(
			output().out,
		),
	);
});

test("a command a Clio session's bash ran is refused with --body-file --yes and the draft is kept as the agent's", async () => {
	const { bodyFile, calls, deps, output } = scratch();
	deps.env = { AI_AGENT: "clio-coder" };
	strictEqual(await runReport([...compose(bodyFile), "--yes"], deps), 2);
	ok(output().err.includes("nothing sent: an agent's draft is reviewed in a terminal"));
	strictEqual(calls.filter((call) => call.args[0] === "issue").length, 0);
	strictEqual(await runReport(["status"], deps), 0);
	ok(/rpt_[0-9A-Z]{26}\s+draft\s+bug\s+fix: x fails on y/u.test(output().out));
});

test("the editor opens the draft inside the reports drafts directory, never the shared temp dir", async () => {
	const { deps, output } = scratch();
	const record = join(deps.cwd ?? "", "editor-path");
	deps.interactive = true;
	deps.env = { EDITOR: `f() { printf %s "$1" > '${record}'; exit 3; }; f` };
	strictEqual(await runReport(["bug", "--title", "fix: x fails on y"], deps), 2);
	ok(output().err.includes("external editor exited with code 3"));
	const opened = readFileSync(record, "utf8");
	strictEqual(dirname(opened), join(deps.stateDir ?? "", "reports", "drafts"));
	strictEqual(existsSync(opened), false);
});
