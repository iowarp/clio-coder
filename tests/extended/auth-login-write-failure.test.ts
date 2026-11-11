/**
 * `clio-coder auth login` against a config directory it cannot write printed
 * `ok: authenticated <provider>`, exited 0, warned about the unencrypted key it
 * had just stored, and left the credentials file byte-identical. The refusal was
 * already recorded (AuthStorage.persist() puts it in damageReason()); the login
 * flow simply never asked after the write.
 */
import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readApiKey, runAuthCommand } from "../../src/cli/auth.js";
import { runTargetRemove } from "../../src/cli/configure.js";
import { listLogoutChoices } from "../../src/cli/provider-target.js";

const LOGOUT_SETTINGS = [
	"version: 2",
	"targets:",
	"  - id: work-openai",
	"    runtime: openai",
	"    defaultModel: gpt-5",
	"    auth:",
	"      apiKeyRef: target:work-openai",
	"",
].join("\n");

import { isolateClioEnv } from "../harness/scratch-env.js";

const RUNTIME = "openai";
const STORED_KEY = "sk-not-a-real-key-already-stored";

async function captureAuth(args: ReadonlyArray<string>): Promise<{ code: number; stdout: string; stderr: string }> {
	return captureCli(() => runAuthCommand(args));
}

async function captureCli(
	run: () => number | Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const outWrite = process.stdout.write.bind(process.stdout);
	const errWrite = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		if (typeof chunk !== "string") return outWrite.call(process.stdout, chunk);
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await run();
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = outWrite;
		process.stderr.write = errWrite;
	}
}

describe("contracts/auth login against an unwritable credentials store", () => {
	let scratch: Awaited<ReturnType<typeof isolateClioEnv>>;
	let configDir: string;
	let credentials: string;
	// A process running as root writes through mode 0500 regardless, so the
	// premise of this test does not hold there.
	const asRoot = process.getuid?.() === 0;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-auth-write-failure-");
		configDir = join(scratch.dir, "config");
		credentials = join(configDir, "credentials.yaml");
	});

	afterEach(() => {
		try {
			chmodSync(configDir, 0o700);
		} catch {
			// The directory may not exist if setup failed; restore() cleans up.
		}
		scratch.restore();
	});

	function seedStore(): string {
		writeFileSync(
			credentials,
			["version: 2", "entries:", `  ${RUNTIME}:`, "    type: api_key", `    key: "${STORED_KEY}"`, ""].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);
		return readFileSync(credentials, "utf8");
	}

	it("reports the refusal, exits non-zero, and claims neither success nor a stored key", async (t) => {
		if (asRoot) return t.skip("mode 0500 does not stop a root process from writing");
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
		const before = seedStore();
		chmodSync(configDir, 0o500);

		const { code, stdout, stderr } = await captureAuth(["login", RUNTIME, "--api-key", "sk-not-a-real-key-new"]);

		strictEqual(code, 1, "a login that wrote nothing must not exit 0");
		ok(!stdout.includes("ok:"), `no success line over a file that was not written; got: ${stdout}`);
		ok(!stderr.includes("unencrypted"), "no plaintext-storage warning for a key that was never stored");
		ok(stderr.includes("was not stored"), `the failure is named; got: ${stderr}`);
		ok(stderr.includes(credentials), `the affected file is named; got: ${stderr}`);

		chmodSync(configDir, 0o700);
		strictEqual(readFileSync(credentials, "utf8"), before, "the store on disk is byte-identical");
		ok(readFileSync(credentials, "utf8").includes(STORED_KEY), "the previously stored key survives");
	});

	// The guard is about a write that failed. The ordinary path must still work.
	it("still reports success and warns about plaintext when the write lands", async () => {
		const { code, stdout, stderr } = await captureAuth(["login", RUNTIME, "--api-key", "sk-not-a-real-key-new"]);

		strictEqual(code, 0);
		ok(stdout.includes(`ok: authenticated ${RUNTIME}`), `got: ${stdout}`);
		ok(stderr.includes("unencrypted"), `got: ${stderr}`);
		ok(existsSync(credentials), "the credentials file exists");
		ok(readFileSync(credentials, "utf8").includes("sk-not-a-real-key-new"), "the key reached disk");
	});
});

describe("contracts/auth login key prompt on a dumb terminal", () => {
	it("reads the key with echo off and writes no character of it", async () => {
		const input = new PassThrough() as unknown as NodeJS.ReadStream;
		const output = new PassThrough() as unknown as NodeJS.WriteStream;
		const rawModeCalls: boolean[] = [];
		let rendered = "";
		Object.assign(input, {
			isTTY: true,
			setRawMode: (value: boolean) => {
				rawModeCalls.push(value);
				return input;
			},
		});
		Object.assign(output, { isTTY: true, columns: 80 });
		output.on("data", (chunk: Buffer) => {
			rendered += chunk.toString("utf8");
		});
		const term = process.env.TERM;
		process.env.TERM = "dumb";
		try {
			const key = ["sk", "FAKEdumbterminal0000"].join("-");
			const read = readApiKey("API key for OpenAI", { input, output });
			strictEqual(rawModeCalls[0], true, "echo goes off before the first key byte arrives");
			input.write(`${key}x\u007f\r`);
			strictEqual(await read, key);
			strictEqual(rawModeCalls.at(-1), false, "the terminal is restored");
			ok(!rendered.includes(key.slice(3)), `no echo of the key; got: ${JSON.stringify(rendered)}`);
			ok(!rendered.includes("\u001b["), "a dumb terminal gets no escape sequences");
			const cancelled = readApiKey("API key for OpenAI", { input, output });
			input.write("partial\u0003");
			strictEqual(await cancelled, null);
		} finally {
			if (term === undefined) delete process.env.TERM;
			else process.env.TERM = term;
		}
	});
});

describe("contracts/auth logout <runtime> with only a target key stored", () => {
	it("names the target that holds a key instead of saying nothing is stored", async () => {
		const scratch = await isolateClioEnv("clio-coder-auth-logout-runtime-");
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(configDir, "settings.yaml"), LOGOUT_SETTINGS);
			writeFileSync(
				join(configDir, "credentials.yaml"),
				["version: 2", "entries:", "  target:work-openai:", "    type: api_key", `    key: "${STORED_KEY}"`, ""].join("\n"),
				{ encoding: "utf8", mode: 0o600 },
			);
			const { code, stderr } = await captureAuth(["logout", RUNTIME]);
			strictEqual(code, 1);
			ok(stderr.includes("work-openai"), stderr);
			ok(stderr.includes("auth logout <target-id>"), stderr);
		} finally {
			scratch.restore();
		}
	});
});

describe("contracts/auth logout listing", () => {
	it("lists the target that holds a key by its own id, which logout then removes", async () => {
		const scratch = await isolateClioEnv("clio-coder-auth-logout-list-");
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(configDir, "settings.yaml"), LOGOUT_SETTINGS);
			writeFileSync(
				join(configDir, "credentials.yaml"),
				["version: 2", "entries:", "  target:work-openai:", "    type: api_key", `    key: "${STORED_KEY}"`, ""].join("\n"),
				{ encoding: "utf8", mode: 0o600 },
			);
			const listing = await captureAuth(["logout"]);
			strictEqual(listing.code, 2);
			const listed = listing.stdout
				.split("\n")
				.map((line) => line.trim().split(/\s+/u)[0] ?? "")
				.filter((id) => id === RUNTIME || id === "work-openai");
			strictEqual(listed.join(","), "work-openai", listing.stdout);
			const removed = await captureAuth(["logout", "work-openai"]);
			strictEqual(removed.code, 0, removed.stderr);
		} finally {
			scratch.restore();
		}
	});
});

describe("contracts/auth logout when a target is named after its runtime", () => {
	it("lists each stored key once under a spelling that removes exactly that key", async () => {
		const scratch = await isolateClioEnv("clio-coder-auth-logout-shadow-");
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(configDir, "settings.yaml"),
				[
					"version: 2",
					"targets:",
					"  - id: openai",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: target:openai",
					"  - id: mirror",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: openai",
					"",
				].join("\n"),
			);
			const credentials = join(configDir, "credentials.yaml");
			writeFileSync(
				credentials,
				[
					"version: 2",
					"entries:",
					"  openai:",
					"    type: api_key",
					'    key: "sk-runtime-not-real"',
					"  target:openai:",
					"    type: api_key",
					`    key: "${STORED_KEY}"`,
					"",
				].join("\n"),
				{ encoding: "utf8", mode: 0o600 },
			);
			const ids = (stdout: string): string[] =>
				stdout
					.split("\n")
					.filter((line) => line.startsWith("  "))
					.map((line) => line.trim().split(/\s+/u)[0] ?? "");
			const listing = await captureAuth(["logout"]);
			strictEqual(ids(listing.stdout).join(","), "runtime:openai,openai", listing.stdout);
			ok(listing.stdout.includes("mirror"), listing.stdout);

			const runtime = await captureAuth(["logout", "runtime:openai"]);
			strictEqual(runtime.code, 0, runtime.stderr);
			const left = readFileSync(credentials, "utf8");
			ok(left.includes("target:openai"), left);
			ok(!/^\s+openai:/mu.test(left), left);
			strictEqual(ids((await captureAuth(["logout"])).stdout).join(","), "openai");

			const target = await captureAuth(["logout", "openai"]);
			strictEqual(target.code, 0, target.stderr);
			ok(!readFileSync(credentials, "utf8").includes("target:openai"));
		} finally {
			scratch.restore();
		}
	});
});

describe("contracts/auth logout of a key stored for the desktop app", () => {
	it("lists the variable's stored copy apart from the runtime's key and removes each alone", async () => {
		const scratch = await isolateClioEnv("clio-coder-auth-logout-envcopy-");
		const saved = process.env.CLIO_TEST_LAB_KEY;
		delete process.env.CLIO_TEST_LAB_KEY;
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(configDir, "settings.yaml"),
				[
					"version: 2",
					"targets:",
					"  - id: lab",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyEnvVar: CLIO_TEST_LAB_KEY",
					"",
				].join("\n"),
			);
			const credentials = join(configDir, "credentials.yaml");
			const storeBoth = (): void =>
				writeFileSync(
					credentials,
					[
						"version: 2",
						"entries:",
						"  openai:",
						"    type: api_key",
						'    key: "sk-runtime-not-real"',
						"  env:CLIO_TEST_LAB_KEY:",
						"    type: api_key",
						`    key: "${STORED_KEY}"`,
						"",
					].join("\n"),
					{ encoding: "utf8", mode: 0o600 },
				);
			const ids = (stdout: string): string[] =>
				stdout
					.split("\n")
					.filter((line) => line.startsWith("  "))
					.map((line) => line.trim().split(/\s+/u)[0] ?? "");

			storeBoth();
			strictEqual(ids((await captureAuth(["logout"])).stdout).join(","), "openai,lab");
			strictEqual(
				listLogoutChoices()
					.map((choice) => `${choice.id}=${choice.entry}`)
					.join(","),
				"openai=openai,lab=env:CLIO_TEST_LAB_KEY",
			);
			const copyRemoved = await captureAuth(["logout", "lab"]);
			strictEqual(copyRemoved.code, 0, copyRemoved.stderr);
			ok(copyRemoved.stdout.includes("env:CLIO_TEST_LAB_KEY"), copyRemoved.stdout);
			let left = readFileSync(credentials, "utf8");
			ok(!left.includes("env:CLIO_TEST_LAB_KEY"), left);
			ok(left.includes("sk-runtime-not-real"), left);

			storeBoth();
			const runtimeRemoved = await captureAuth(["logout", "openai"]);
			strictEqual(runtimeRemoved.code, 0, runtimeRemoved.stderr);
			left = readFileSync(credentials, "utf8");
			ok(!left.includes("sk-runtime-not-real"), left);
			ok(left.includes("env:CLIO_TEST_LAB_KEY"), left);
			strictEqual(ids((await captureAuth(["logout"])).stdout).join(","), "lab");
		} finally {
			if (saved === undefined) delete process.env.CLIO_TEST_LAB_KEY;
			else process.env.CLIO_TEST_LAB_KEY = saved;
			scratch.restore();
		}
	});
});

describe("contracts/targets remove and the removed target's stored key", () => {
	it("drops the key the target owned and keeps the runtime's key, saying which", async () => {
		const scratch = await isolateClioEnv("clio-coder-target-remove-key-");
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(configDir, "settings.yaml"),
				[
					"version: 2",
					"targets:",
					"  - id: openai",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: target:openai",
					"  - id: mirror",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: openai",
					"",
				].join("\n"),
			);
			const credentials = join(configDir, "credentials.yaml");
			writeFileSync(
				credentials,
				[
					"version: 2",
					"entries:",
					"  openai:",
					"    type: api_key",
					'    key: "sk-runtime-not-real"',
					"  target:openai:",
					"    type: api_key",
					`    key: "${STORED_KEY}"`,
					"",
				].join("\n"),
				{ encoding: "utf8", mode: 0o600 },
			);
			const own = await captureCli(() => runTargetRemove("openai"));
			strictEqual(own.code, 0, own.stderr);
			ok(own.stdout.includes("removed its stored key target:openai"), own.stdout);
			let left = readFileSync(credentials, "utf8");
			ok(!left.includes("target:openai"), left);
			ok(/^\s+openai:/mu.test(left), left);

			const shared = await captureCli(() => runTargetRemove("mirror"));
			strictEqual(shared.code, 0, shared.stderr);
			ok(shared.stdout.includes("kept the stored key openai"), shared.stdout);
			left = readFileSync(credentials, "utf8");
			ok(/^\s+openai:/mu.test(left), left);
		} finally {
			scratch.restore();
		}
	});

	it("keeps a key another target still reads", async () => {
		const scratch = await isolateClioEnv("clio-coder-target-remove-shared-");
		try {
			const configDir = join(scratch.dir, "config");
			mkdirSync(configDir, { recursive: true, mode: 0o700 });
			writeFileSync(
				join(configDir, "settings.yaml"),
				[
					"version: 2",
					"targets:",
					"  - id: work-a",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: target:work",
					"  - id: work-b",
					"    runtime: openai",
					"    defaultModel: gpt-5",
					"    auth:",
					"      apiKeyRef: target:work",
					"",
				].join("\n"),
			);
			const credentials = join(configDir, "credentials.yaml");
			writeFileSync(
				credentials,
				["version: 2", "entries:", "  target:work:", "    type: api_key", `    key: "${STORED_KEY}"`, ""].join("\n"),
				{ encoding: "utf8", mode: 0o600 },
			);
			const removed = await captureCli(() => runTargetRemove("work-a"));
			strictEqual(removed.code, 0, removed.stderr);
			ok(removed.stdout.includes("kept the stored key target:work: work-b still uses it"), removed.stdout);
			ok(readFileSync(credentials, "utf8").includes("target:work"));
		} finally {
			scratch.restore();
		}
	});
});
