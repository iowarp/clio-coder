import { doesNotMatch, ok, strictEqual } from "node:assert/strict";
import { afterEach, it } from "node:test";
import { rememberResolvedSecret } from "../../src/core/sandbox/env-scrub.js";
import { CommandOutputMask } from "../../src/domains/evidence/output-mask.js";
import { runOperatorShellLine } from "../../src/domains/session/operator-shell.js";
import { bashTool } from "../../src/tools/bash.js";

/**
 * Known credential values never reach a captured shell result: a credential
 * variable's value and a credential Clio resolved are masked, while a value
 * too short to mask safely and a path under a credential name print as they are.
 * An unsandboxed child no longer inherits credential-named variables, so the
 * command prints each fixture value literally, as output that obtained it some
 * other way would.
 */

const KEY = "sk-mask-fixture-0123456789abcdef";
const RESOLVED = "resolved-credential-fixture-42";
const FIXTURE_ENV = {
	MASK_FIXTURE_DEPLOY_KEY: KEY,
	MASK_FIXTURE_SMTP_PASS: "short7",
	MASK_FIXTURE_SSH_KEY: "/home/fixture/.ssh/id_ed25519",
};
const COMMAND = `printf '%s|%s|%s|%s\\n' '${KEY}' '${FIXTURE_ENV.MASK_FIXTURE_SMTP_PASS}' '${FIXTURE_ENV.MASK_FIXTURE_SSH_KEY}' '${RESOLVED}'; sleep 0.2`;
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

it("masks a credential by its shape, even split across writes, and leaves ordinary output alone", async () => {
	const halves = ["ghp_ZQXJ01", "23456789ZQXJabcdef"];
	const ordinary = "BASE_TOKENS=100 max_tokens: 128000000 sk-worker-deployment";
	const progress: string[] = [];
	const result = await bashTool.run(
		{
			command: `echo '${ordinary}'; printf 'split ${halves[0]}'; sleep 0.3; printf '${halves[1]}\\n'`,
			timeout_ms: 5_000,
		},
		{
			onUpdate: (update) => {
				if (update.kind === "ok") progress.push(update.output);
			},
		},
	);
	ok(result.kind === "ok", JSON.stringify(result));
	strictEqual(result.output.split("\n").slice(0, 2).join("\n"), `${ordinary}\nsplit [redacted:github-token]`);
	ok(progress.length > 0, "the command reported progress");
	for (const shown of progress) doesNotMatch(shown, /ZQXJ/u);
});

it("masks a stream to the same text wherever it is split and never shows the secret", () => {
	const secret = ["ghs", "_", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"].join("");
	// Leads that read across a line break, and a literal marker that changes how a block's quoted values are marked.
	const tricky = [
		`{"authorization": "token ${secret}"}`,
		"password '",
		`token:"authorization": "token ${secret}"token:`,
		"config token:",
		` "x": "y", "password": "a ${secret} b"`,
		"[redacted]",
		`TOKEN="a ${secret} b" Authorization: Bearer ${secret}`,
		"",
	].join("\n");
	const filler = "2026-11-20T01:00:00Z INFO step done in 12 ms\n".repeat(97);
	const stream = (filler + tricky).repeat(40);
	const starts: number[] = [];
	for (let at = stream.indexOf(tricky); at >= 0; at = stream.indexOf(tricky, at + 1)) starts.push(at);
	const mask = (pieces: string[]): string => {
		const output = new CommandOutputMask([]);
		let text = "";
		for (const piece of pieces) {
			text += output.push(piece);
			ok(!output.frame().includes(secret), "a frame shows the secret");
		}
		return text + output.end();
	};
	const whole = mask([stream]);
	ok(!whole.includes(secret));
	let seed = 7;
	const next = (below: number): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return Math.floor((seed / 2147483648) * below);
	};
	for (let trial = 0; trial < 60; trial += 1) {
		// Most cuts land inside a tricky stretch, where a line-by-line commit used to change the result.
		const cuts = new Set<number>();
		for (let count = 1 + next(6); count > 0; count -= 1) {
			cuts.add(count % 3 === 0 ? next(stream.length) : (starts[next(starts.length)] ?? 0) + next(tricky.length));
		}
		const points = [0, ...[...cuts].sort((a, b) => a - b), stream.length];
		const pieces = points.slice(1).map((end, index) => stream.slice(points[index], end));
		const masked = mask(pieces);
		ok(!masked.includes(secret), `split at ${points.join(",")} shows the secret`);
		strictEqual(masked, whole, `split at ${points.join(",")} masks differently`);
	}
});
