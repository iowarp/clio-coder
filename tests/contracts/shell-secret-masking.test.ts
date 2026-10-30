import { doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { afterEach, it } from "node:test";
import { rememberResolvedSecret } from "../../src/core/sandbox/env-scrub.js";
import { runOperatorShellLine } from "../../src/domains/session/operator-shell.js";
import { bashTool } from "../../src/tools/bash.js";

/**
 * Known credential values never reach a captured shell result: a credential
 * variable's value and a credential Clio resolved are masked, while a value
 * too short to mask safely and a path under a credential name print as they are.
 * The names avoid the `*_TOKEN` and `*_API_KEY` shapes an unsandboxed command
 * never inherits, so the child really prints each value.
 */

const KEY = "sk-mask-fixture-0123456789abcdef";
const RESOLVED = "resolved-credential-fixture-42";
const FIXTURE_ENV = {
	MASK_FIXTURE_DEPLOY_KEY: KEY,
	MASK_FIXTURE_SMTP_PASS: "short7",
	MASK_FIXTURE_SSH_KEY: "/home/fixture/.ssh/id_ed25519",
};
const COMMAND = `printf '%s|%s|%s|%s\\n' "$MASK_FIXTURE_DEPLOY_KEY" "$MASK_FIXTURE_SMTP_PASS" "$MASK_FIXTURE_SSH_KEY" '${RESOLVED}'; sleep 0.2`;
const MASKED = "[redacted:known]|short7|/home/fixture/.ssh/id_ed25519|[redacted:known]";

function fixtureEnv(): void {
	Object.assign(process.env, FIXTURE_ENV);
	rememberResolvedSecret(RESOLVED);
}

afterEach(() => {
	for (const name of Object.keys(FIXTURE_ENV)) delete process.env[name];
});

it("masks credential values in bash progress and results and leaves short and path values alone", async () => {
	fixtureEnv();
	const progress: string[] = [];
	const result = await bashTool.run(
		{ command: COMMAND, timeout_ms: 5_000 },
		{
			onUpdate: (update) => {
				if (update.kind === "ok") progress.push(update.output);
			},
		},
	);
	ok(result.kind === "ok", JSON.stringify(result));
	strictEqual(result.output.split("\n")[0], MASKED);
	ok(progress.length > 0, "the command reported progress");
	for (const shown of progress) {
		doesNotMatch(shown, new RegExp(KEY));
		doesNotMatch(shown, new RegExp(RESOLVED));
	}
});

it("masks credential values in the operator shell record", async () => {
	fixtureEnv();
	const run = await runOperatorShellLine({
		command: COMMAND,
		cwd: process.cwd(),
		excludeFromContext: false,
		parentTurnId: null,
		signal: new AbortController().signal,
	});
	strictEqual(run.entry.output.trim(), MASKED);
});
