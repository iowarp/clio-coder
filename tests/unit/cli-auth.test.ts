import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runAuthCommand } from "../../src/cli/auth.js";
import { runConnectCommand } from "../../src/cli/login.js";
import { runDisconnectCommand } from "../../src/cli/logout.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openAuthStorage } from "../../src/domains/providers/auth/index.js";
import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderInterface,
	registerEngineOAuthProvider,
	unregisterEngineOAuthProvider,
} from "../../src/engine/oauth.js";

const ORIGINAL_ENV = { ...process.env };
const TEST_PROVIDER_ID = "clio-cli-oauth";

const TEST_PROVIDER: OAuthProviderInterface = {
	id: TEST_PROVIDER_ID,
	name: "Clio CLI OAuth",
	async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return {
			access: "cli-access",
			refresh: "cli-refresh",
			expires: Date.now() + 60_000,
		};
	},
	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return credentials;
	},
	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const realStdout = process.stdout.write.bind(process.stdout);
	const realStderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await fn();
		return { result, stdout, stderr };
	} finally {
		process.stdout.write = realStdout;
		process.stderr.write = realStderr;
	}
}

describe("cli auth commands", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-cli-auth-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		registerEngineOAuthProvider(TEST_PROVIDER);
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		try {
			unregisterEngineOAuthProvider(TEST_PROVIDER_ID);
		} catch {
			// provider may already be absent
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("connect stores oauth credentials and auth status/disconnect reflect them", async () => {
		const connect = await captureOutput(() => runConnectCommand([TEST_PROVIDER_ID]));
		strictEqual(connect.result, 0);
		const stored = openAuthStorage().get(TEST_PROVIDER_ID);
		ok(stored && stored.type === "oauth");

		const status = await captureOutput(() => runAuthCommand(["status", TEST_PROVIDER_ID]));
		strictEqual(status.result, 0);
		ok(status.stdout.includes(`${TEST_PROVIDER_ID}\toauth\tpresent`));

		const disconnect = await captureOutput(() => runDisconnectCommand([TEST_PROVIDER_ID]));
		strictEqual(disconnect.result, 0);
		strictEqual(openAuthStorage().get(TEST_PROVIDER_ID), undefined);

		const after = await captureOutput(() => runAuthCommand(["status", TEST_PROVIDER_ID]));
		strictEqual(after.result, 1);
		ok(after.stdout.includes(`${TEST_PROVIDER_ID}\t-\tabsent`));
	});
});
