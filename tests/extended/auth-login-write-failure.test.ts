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
import { isolateClioEnv } from "../harness/scratch-env.js";

const RUNTIME = "openai";
const STORED_KEY = "sk-not-a-real-key-already-stored";

async function captureAuth(args: ReadonlyArray<string>): Promise<{ code: number; stdout: string; stderr: string }> {
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
		const code = await runAuthCommand(args);
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
