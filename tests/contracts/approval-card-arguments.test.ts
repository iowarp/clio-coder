import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCallTarget } from "../../src/domains/safety/call-target.js";
import { redactSecretString } from "../../src/domains/safety/redaction.js";

/**
 * A tool with no curated field list (MCP and other dynamic tools) shows short
 * one-line string arguments on the approval card. The TUI card, the ACP
 * permission request and the GUI all read this text, so nothing a secret rule
 * would hide may reach it.
 */
describe("approval card arguments of an uncurated tool", () => {
	const target = (args: Record<string, unknown>) => describeCallTarget("mcp_slurm__slurm_submit", args, undefined, 1000);

	it("shows short one-line strings whole and summarizes the rest", () => {
		strictEqual(
			target({
				script: "/home/r/jobs/age.sbatch",
				partition: "gpu sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0",
				api_token: "plain-value",
				notes: "one\ntwo",
				content: "short",
				long: "z".repeat(97),
			}),
			"script=/home/r/jobs/age.sbatch · partition=gpu [redacted:sk-key] · api_token=<string 11 bytes> · " +
				"notes=<string 7 bytes> · content=<string 5 bytes> · long=<string 97 bytes>",
		);
		strictEqual(describeCallTarget("write", { path: "a.txt", content: "hi" }), "a.txt · content=<string 2 bytes>");
	});

	it("redacts a token that a terminal escape splits", () => {
		strictEqual(target({ option: "gh\u001b[0mp_ABCDEFGHIJKLMNOPQRST1234" }), "option=[redacted:github-token]");
	});

	it("keeps environment and header containers summarized", () => {
		strictEqual(
			target({
				env: "SESSION_COOKIE=opaque-session-12345",
				environment: "PASSWORD=x",
				headers: "Cookie: sid=opaque",
				cookie: "sid=opaque",
			}),
			"env=<string 35 bytes> · environment=<string 10 bytes> · headers=<string 18 bytes> · cookie=<string 10 bytes>",
		);
	});

	it("hides a quoted assignment through its closing quote", () => {
		strictEqual(target({ cmd: 'PASSWORD="top secret12345" run' }), "cmd=PASSWORD=[redacted:assignment] run");
		strictEqual(redactSecretString("API_KEY='a b c' next"), "API_KEY=[redacted] next");
		strictEqual(redactSecretString('TOKEN="$GITHUB_TOKEN"'), 'TOKEN="$GITHUB_TOKEN"');
	});
});
