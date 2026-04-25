import { ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bashTool, buildToolEnv } from "../../src/tools/bash.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		Reflect.deleteProperty(process.env, key);
	}
	Object.assign(process.env, ORIGINAL_ENV);
});

describe("bash tool environment", () => {
	it("does not leak Clio control env into child commands by default", () => {
		process.env.CLIO_DEV = "1";
		process.env.CLIO_SELF_DEV = "1";
		process.env.CLIO_INTERACTIVE = "1";
		process.env.CLIO_RESUME_SESSION_ID = "session-123";

		const env = buildToolEnv();

		strictEqual(env.CLIO_DEV, undefined);
		strictEqual(env.CLIO_SELF_DEV, undefined);
		strictEqual(env.CLIO_INTERACTIVE, undefined);
		strictEqual(env.CLIO_RESUME_SESSION_ID, undefined);
	});

	it("scrubs parent env even when a command string mentions control env", () => {
		process.env.CLIO_DEV = "1";
		process.env.CLIO_SELF_DEV = "1";
		process.env.CLIO_INTERACTIVE = "1";

		const env = buildToolEnv();

		strictEqual(env.CLIO_DEV, undefined);
		strictEqual(env.CLIO_SELF_DEV, undefined);
		strictEqual(env.CLIO_INTERACTIVE, undefined);
	});

	it("still allows explicit shell assignments inside the command", async () => {
		process.env.CLIO_DEV = "parent";

		const result = await bashTool.run({
			command: "CLIO_DEV=child printenv CLIO_DEV",
		});

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") strictEqual(result.output.trim(), "child");
	});

	it("runs child commands with scrubbed control env", async () => {
		process.env.CLIO_DEV = "1";
		process.env.CLIO_SELF_DEV = "1";
		process.env.CLIO_INTERACTIVE = "1";

		const clioDev = "$" + "{CLIO_DEV-}";
		const clioSelfDev = "$" + "{CLIO_SELF_DEV-}";
		const clioInteractive = "$" + "{CLIO_INTERACTIVE-}";
		const result = await bashTool.run({
			command: `printf "%s|%s|%s" "${clioDev}" "${clioSelfDev}" "${clioInteractive}"`,
		});

		strictEqual(result.kind, "ok");
		if (result.kind === "ok") strictEqual(result.output.trim(), "||");
	});

	it("honors abort signals for long-running commands", async () => {
		const controller = new AbortController();
		const started = bashTool.run(
			{
				command: "sleep 5; printf done",
				timeout_ms: 10_000,
			},
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 20);
		const result = await started;

		strictEqual(result.kind, "error");
		if (result.kind === "error") strictEqual(result.message, "bash: command aborted");
	});

	it("escalates aborted commands that ignore sigterm", async () => {
		const controller = new AbortController();
		// The shell runs with `-l`, which on cold CI runners can spend a few
		// hundred ms reading /etc/profile before reaching the user command. If
		// SIGTERM arrives before the trap is installed, bash dies at the
		// default disposition and the escalation path never runs. Wait long
		// enough for the trap to take effect on the slowest runners we see.
		const startedAt = Date.now();
		const started = bashTool.run(
			{
				command: 'trap "" TERM; end=$((SECONDS + 12)); while [ "$SECONDS" -lt "$end" ]; do sleep 1; done',
				timeout_ms: 16_000,
			},
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 1500);
		const result = await started;
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.kind, "error");
		if (result.kind === "error") strictEqual(result.message, "bash: command aborted");
		ok(elapsedMs >= 1500 + 4_500, `expected abort escalation after the grace period, got ${elapsedMs}ms`);
		ok(elapsedMs < 1500 + 9_000, `expected abort escalation within window, got ${elapsedMs}ms`);
	});

	it("reports output cap exits explicitly", async () => {
		const result = await bashTool.run({
			command: "yes hello | head -c 3000000",
			timeout_ms: 10_000,
		});

		strictEqual(result.kind, "error");
		if (result.kind === "error") strictEqual(result.message, "bash: command output exceeded 2000000 bytes");
	});
});
