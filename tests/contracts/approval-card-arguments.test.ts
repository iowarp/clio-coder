import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCallTarget } from "../../src/domains/safety/call-target.js";
import { redactSecretString } from "../../src/domains/safety/redaction.js";

/**
 * A tool with no curated field list (MCP and other dynamic tools) shows a
 * string argument on the approval card only when its name is an allowlisted
 * plain identifier and its value is short, one line, of a conservative
 * charset and untouched by every secret rule. The TUI card, the ACP
 * permission request and the GUI all read this text, so everything else is
 * summarized by size, never masked in place.
 */
describe("approval card arguments of an uncurated tool", () => {
	const target = (args: Record<string, unknown>) => describeCallTarget("mcp_slurm__slurm_submit", args, undefined, 1000);

	it("shows the slurm_submit script path and plain choices in full", () => {
		strictEqual(
			target({
				script: "/home/researcher/hea/sigma/jobs/arc-melt-aging-0423.sbatch",
				partition: "gpu",
				job_name: "sigma-age",
				module: "hdf5@1.14.3+mpi",
				url: "https://h.example/x",
				cores: 8,
			}),
			"script=/home/researcher/hea/sigma/jobs/arc-melt-aging-0423.sbatch · partition=gpu · job_name=sigma-age · " +
				"module=hdf5@1.14.3+mpi · url=https://h.example/x · cores=8",
		);
		strictEqual(target({ script: `/${"a".repeat(95)}` }), `script=/${"a".repeat(95)}`);
		strictEqual(target({ script: `/${"a".repeat(96)}` }), "script=<string 97 bytes>");
		strictEqual(describeCallTarget("write", { path: "a.txt", content: "hi" }), "a.txt · content=<string 2 bytes>");
	});

	it("summarizes every reviewed disclosure", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ option: "gh\u001b[0mp_ABCDEFGHIJKLMNOPQRST1234" }, "option=<string 32 bytes>"],
			[{ env: "SESSION_COOKIE=opaque-session-12345" }, "env=<string 35 bytes>"],
			[{ env: 'PASSWORD="top secret12345"' }, "env=<string 26 bytes>"],
			[{ cmd: 'PASSWORD="top secret12345" run' }, "cmd=<string 30 bytes>"],
			[{ cmd: "API_KEY=\"\"'opaque-session-12345' run" }, "cmd=<string 36 bytes>"],
			[{ cmd: 'PASSWORD="top \\"quoted secret12345" run' }, "cmd=<string 39 bytes>"],
			[{ option: "authorization=Basic dXNlcjpwYXNzd29yZA==" }, "option=<string 40 bytes>"],
			[{ option: "Authorization=Bearer abcdefgh12345" }, "option=<string 34 bytes>"],
			[{ "pass\u001b[0mword": "opaque-session-12345" }, "password=<string 20 bytes>"],
			[{ "en\u001b[0mv": "opaque-session-12345" }, "env=<string 20 bytes>"],
			[{ "head\u001b[0mers": "opaque-session-12345" }, "headers=<string 20 bytes>"],
		];
		deepStrictEqual(
			cases.map(([args]) => target(args)),
			cases.map(([, expected]) => expected),
		);
	});

	it("summarizes an allowlisted name whose value is not plainly safe", () => {
		const values = [
			"Bearer abcdefgh12345",
			"Basic dXNlcjpwYXNzd29yZA",
			"ghp_ABCDEFGHIJKLMNOPQRST1234",
			"sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0",
			"https://u:p@h.example/x",
			"https://ghp_ABCDEFGH12345678@github.com/x",
			"https://h.example/x?token=1",
			"admin:hunter2@db.example.com",
			"token abcdefgh12345",
			"KEY=opaque",
			"/jobs/$HOME/x",
			"/jobs/a\u001b[0mb",
			"one\ntwo",
		];
		for (const value of values) {
			strictEqual(target({ target: value }), `target=<string ${value.length} bytes>`, JSON.stringify(value));
		}
		strictEqual(target({ "pa\u001b[0mth": "/home/x" }), "path=<string 7 bytes>");
		strictEqual(
			target({ notes: "short", api_token: "plain-value" }),
			"notes=<string 5 bytes> · api_token=<string 11 bytes>",
		);
	});

	it("masks an adjacent quoted assignment whole in the display redactor", () => {
		ok(!redactSecretString("API_KEY=\"\"'opaque-session-12345' run").includes("opaque-session"));
	});
});
