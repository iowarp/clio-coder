import { deepStrictEqual, doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { STORE_REPLACES_ARG } from "../../src/core/store-paths.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	createRedactionTally,
	redactCommandOutputSecrets,
	redactSecretsText,
} from "../../src/domains/evidence/redact.js";
import { describeCallTarget, WORKER_CALL_TARGET_MAX_CHARS } from "../../src/domains/safety/call-target.js";
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

	it("summarizes webhooks, GitLab tokens, AWS secret keys and opaque path segments, and the journal hides the shapes", () => {
		// Each shape is joined at runtime so secret scanners do not read these documentation examples as leaks.
		const secrets: Array<[string, string]> = [
			[
				`https://hooks.slack.com/services/${["T0AAAAAAA", "B0BBBBBBB", "abcdefghijklmnopqrstuvwx"].join("/")}`,
				"abcdefghijklmnopqrstuvwx",
			],
			[
				`https://api.telegram.org/bot${["123456789", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(":")}/sendMessage`,
				"AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
			],
			[
				`https://discord.com/api/webhooks/${["123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"].join("/")}`,
				"abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
			],
			[["glpat", "abcdefghijklmnopqrst"].join("-"), "abcdefghijklmnopqrst"],
			[["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"), "bPxRfiCYEXAMPLEKEY"],
		];
		for (const [value, secret] of secrets) {
			strictEqual(target({ target: value }), `target=<string ${value.length} bytes>`, value);
			// The run journal keeps the card text through evidence redaction, which knows these shapes.
			ok(!redactSecretsText(`sent ${value} ok`, createRedactionTally()).includes(secret), value);
			// Command output masks every shape but the AWS secret key, which needs the randomness check.
			if (!value.startsWith("wJalr")) ok(!redactCommandOutputSecrets(`sent ${value} ok`).includes(secret), value);
		}
		// A webhook of a service no rule knows still hides its opaque path segment.
		const opaque = "https://example.com/hook/Wm8kQ2xR9vT4pL7nZ3yH6cJd";
		strictEqual(target({ url: opaque }), `url=<string ${opaque.length} bytes>`);
		for (const value of [
			"/data/Project2/RawImages/Batch7/Sample12",
			"/models/Qwen2.5-Coder-32B-Instruct-GGUF",
			"/scratch/x86_64-pc-linux-gnu-gcc-13/experiment-results-2024-05-01",
			"CamelCaseFileNameWithNumbers123",
		]) {
			strictEqual(target({ path: value }), `path=${value}`);
			strictEqual(redactSecretsText(value, createRedactionTally()), value);
		}
	});

	it("masks an adjacent quoted assignment whole in the display redactor", () => {
		ok(!redactSecretString("API_KEY=\"\"'opaque-session-12345' run").includes("opaque-session"));
	});

	it("masks JSON-keyed values, Authorization and bearer values and bare git host tokens in the display redactor", () => {
		// Joined at runtime so secret scanners do not read these fixtures as leaks.
		const gitToken = ["ghp", "FAKEfakeFAKEfakeFAKE1234"].join("_");
		const shown = [
			`curl -d '{"token":"opaque-session-12345"}' https://h.example`,
			`{"apiKey": "opaque-session-12345"}`,
			"{'password': 'opaque-session-12345'}",
			"Authorization: Basic opaque-session-12345",
			"Authorization: Bearer opaque-session-12345",
			"bearer opaque-session-12345",
			`export GH=${gitToken}`,
		].map(redactSecretString);
		for (const line of shown) ok(!line.includes("opaque-session") && !line.includes(gitToken), line);
		strictEqual(redactSecretString('{"author":"Jane Doe","max_tokens":42}'), '{"author":"Jane Doe","max_tokens":42}');
		strictEqual(redactSecretString("the bearer of bad news"), "the bearer of bad news");
	});
});

describe("approval line of a store put that replaces a blob", () => {
	it("says what the put replaces in plain words, never admission's marker", () => {
		const named = { op: "put", tag: "fleet", blob: "v1", path: "out/v1.txt", note: "hello", [STORE_REPLACES_ARG]: 26894 };
		// The worker's escalation event, which the operator feed prints, and the approval card.
		const event = describeCallTarget(ToolNames.Store, named, undefined, WORKER_CALL_TARGET_MAX_CHARS);
		const card = describeCallTarget(ToolNames.Store, named);
		for (const line of [event, card]) {
			ok(line.startsWith("replaces fleet:v1 (26894 bytes)"), line);
			doesNotMatch(line, /__storeReplaces|=26894/u);
		}
		strictEqual(
			describeCallTarget(ToolNames.Store, { op: "put", tag: "fleet", path: "out/v3.csv", [STORE_REPLACES_ARG]: 1234 }),
			"replaces fleet:v3.csv (1234 bytes) · op=<string 3 bytes> · tag=<string 5 bytes> · path=out/v3.csv",
		);
		strictEqual(
			describeCallTarget(ToolNames.Store, { op: "put", tag: "fleet", path: "out/v3.csv" }),
			"op=<string 3 bytes> · tag=<string 5 bytes> · path=out/v3.csv",
		);
	});
});
