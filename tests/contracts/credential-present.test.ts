import { deepStrictEqual, match, ok } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * credential_present through a worker registry against a real process
 * environment and a real env file. Every result is checked for the secret
 * values themselves, because the tool's whole contract is presence without
 * disclosure.
 */

const ENV_KEY = "CLIO_CREDENTIAL_PRESENT_TEST_ENV";
const ENV_VALUE = "env-secret-7f3a";
const FILE_VALUE = "file-secret-91cd";

describe("credential_present tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let envFile: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-credential-present-");
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: scratch.dir }));
		envFile = join(scratch.dir, ".env");
		writeFileSync(
			envFile,
			[
				`FILE_ONLY_KEY=${FILE_VALUE}`,
				`  export EXPORTED_KEY=${FILE_VALUE}`,
				`# COMMENTED_KEY=${FILE_VALUE}`,
				"EMPTY_KEY=",
				`${ENV_KEY}=${FILE_VALUE}`,
				`FILE_ONLY_KEY_SUFFIX=${FILE_VALUE}`,
			].join("\n"),
		);
		process.env[ENV_KEY] = ENV_VALUE;
	});
	afterEach(() => {
		delete process.env[ENV_KEY];
		scratch.restore();
	});

	async function call(args: Record<string, unknown>): Promise<ToolResult> {
		const verdict = await registry.invoke({ tool: ToolNames.CredentialPresent, args });
		if (verdict.kind !== "ok") throw new Error(`credential_present was not admitted: ${JSON.stringify(verdict)}`);
		const serialized = JSON.stringify(verdict.result);
		ok(!serialized.includes(ENV_VALUE) && !serialized.includes(FILE_VALUE), `a credential value leaked: ${serialized}`);
		return verdict.result;
	}

	async function summary(args: Record<string, unknown>): Promise<unknown> {
		const result = await call(args);
		if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
		deepStrictEqual(JSON.parse(result.output), result.details?.credentialPresent);
		return result.details?.credentialPresent;
	}

	it("reports environment presence by name and never the value", async () => {
		deepStrictEqual(await summary({ name: ENV_KEY }), {
			name: ENV_KEY,
			present: true,
			source: "environment",
			checked: ["environment"],
		});
		deepStrictEqual(await summary({ name: "CLIO_CREDENTIAL_PRESENT_TEST_ABSENT", source: "env" }), {
			name: "CLIO_CREDENTIAL_PRESENT_TEST_ABSENT",
			present: false,
			source: "none",
			checked: ["environment"],
		});
	});

	it("matches an env file key exactly, including export lines and empty values, but not comments or prefixes", async () => {
		for (const [name, present] of [
			["FILE_ONLY_KEY", true],
			["EXPORTED_KEY", true],
			["EMPTY_KEY", true],
			["COMMENTED_KEY", false],
			["FILE_ONLY", false],
		] as const) {
			deepStrictEqual(await summary({ name, source: "file", file: envFile }), {
				name,
				present,
				source: present ? "file" : "none",
				checked: ["file"],
				file: envFile,
			});
		}
	});

	it("checks both sources under auto when a file is named and says which held the key", async () => {
		deepStrictEqual(await summary({ name: ENV_KEY, file: envFile }), {
			name: ENV_KEY,
			present: true,
			source: "both",
			checked: ["environment", "file"],
			file: envFile,
		});
		deepStrictEqual(await summary({ name: "FILE_ONLY_KEY", source: "auto", file: envFile }), {
			name: "FILE_ONLY_KEY",
			present: true,
			source: "file",
			checked: ["environment", "file"],
			file: envFile,
		});
	});

	it("tells a missing env file apart from an absent key", async () => {
		const missing = join(scratch.dir, "no-such.env");
		deepStrictEqual(await summary({ name: "FILE_ONLY_KEY", source: "file", file: missing }), {
			name: "FILE_ONLY_KEY",
			present: false,
			source: "none",
			checked: ["file"],
			file: missing,
			fileMissing: true,
		});
	});

	it("refuses an invalid name, source, or missing file before reading anything", async () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{}, /name is required/],
			[{ name: "   " }, /name is required/],
			[{ name: "1_LEADING_DIGIT" }, /name must match \[A-Za-z_\]\[A-Za-z0-9_\]\*/],
			[{ name: "HAS-DASH" }, /name must match/],
			[{ name: `${ENV_KEY}=x` }, /name must match/],
			[{ name: ENV_KEY, source: "vault" }, /source must be auto, environment, env, or file/],
			[{ name: ENV_KEY, source: "file" }, /file is required/],
		];
		for (const [args, expected] of cases) {
			const result = await call(args);
			if (result.kind !== "error") throw new Error(`expected error for ${JSON.stringify(args)}`);
			match(result.message, expected, JSON.stringify(args));
		}
	});
});
