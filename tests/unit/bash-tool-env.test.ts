import { strictEqual } from "node:assert/strict";
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
		process.env.CLIO_PHASE1_INTERACTIVE = "1";
		process.env.CLIO_RESUME_SESSION_ID = "session-123";

		const env = buildToolEnv();

		strictEqual(env.CLIO_DEV, undefined);
		strictEqual(env.CLIO_SELF_DEV, undefined);
		strictEqual(env.CLIO_INTERACTIVE, undefined);
		strictEqual(env.CLIO_PHASE1_INTERACTIVE, undefined);
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
});
