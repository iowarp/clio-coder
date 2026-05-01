import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runAuthCommand } from "../../src/cli/auth.js";
import { type ConnectableProviderRow, renderConnectableProviderRows } from "../../src/cli/provider-target.js";
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
const ORIGINAL_PATH = process.env.PATH;
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

function installClaudeShim(dir: string, script: string): void {
	const binPath = join(dir, "claude");
	writeFileSync(binPath, script, "utf8");
	chmodSync(binPath, 0o755);
	process.env.PATH = `${dir}${delimiter}${ORIGINAL_PATH ?? ""}`;
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

	it("auth login stores oauth credentials and auth status/logout reflect them", async () => {
		const login = await captureOutput(() => runAuthCommand(["login", TEST_PROVIDER_ID]));
		strictEqual(login.result, 0);
		const stored = openAuthStorage().get(TEST_PROVIDER_ID);
		ok(stored && stored.type === "oauth");

		const status = await captureOutput(() => runAuthCommand(["status", TEST_PROVIDER_ID]));
		strictEqual(status.result, 0);
		ok(new RegExp(`${TEST_PROVIDER_ID}\\s+Clio CLI OAuth\\s+oauth\\s+present`).test(status.stdout), status.stdout);

		const logout = await captureOutput(() => runAuthCommand(["logout", TEST_PROVIDER_ID]));
		strictEqual(logout.result, 0);
		strictEqual(openAuthStorage().get(TEST_PROVIDER_ID), undefined);

		const after = await captureOutput(() => runAuthCommand(["status", TEST_PROVIDER_ID]));
		strictEqual(after.result, 1);
		ok(new RegExp(`${TEST_PROVIDER_ID}\\s+Clio CLI OAuth\\s+-\\s+absent`).test(after.stdout), after.stdout);
	});

	it("auth status probes Claude native CLI auth without storing Clio credentials", async () => {
		installClaudeShim(
			scratch,
			'#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then echo \'Logged in as test@example.com\'; exit 0; fi\nexit 2\n',
		);

		const status = await captureOutput(() => runAuthCommand(["status", "claude-code-cli"]));
		strictEqual(status.result, 0);
		ok(/claude-code-cli\s+Claude Code CLI\s+cli\s+authenticated/.test(status.stdout), status.stdout);
		strictEqual(openAuthStorage().get("claude-code-cli"), undefined);
	});

	it("auth login for Claude native CLI prints handoff guidance in non-interactive tests", async () => {
		const login = await captureOutput(() => runAuthCommand(["login", "claude-code-cli"]));
		strictEqual(login.result, 0);
		ok(login.stdout.includes("claude auth login"));
		strictEqual(openAuthStorage().get("claude-code-cli"), undefined);
	});

	it("auth list --help prints usage instead of provider rows", async () => {
		const help = await captureOutput(() => runAuthCommand(["list", "--help"]));
		strictEqual(help.result, 0);
		ok(help.stdout.includes("usage: clio auth list"), help.stdout);
		ok(!help.stdout.includes("targets="), help.stdout);
	});

	it("renders auth provider rows with dynamic columns for long display names", () => {
		const rows: ConnectableProviderRow[] = [
			{
				entry: {
					runtimeId: "short",
					label: "Short",
					group: "cloud-api",
					summary: "short",
					modelHints: [],
					featured: false,
					connectable: true,
					supportsCustomUrl: false,
				},
				status: {
					providerId: "short",
					available: false,
					credentialType: null,
					source: "none",
					detail: null,
				},
				targetCount: 0,
			},
			{
				entry: {
					runtimeId: "google",
					label: "Google Generative AI",
					group: "cloud-api",
					summary: "gemini",
					modelHints: [],
					featured: false,
					connectable: true,
					supportsCustomUrl: false,
				},
				status: {
					providerId: "google",
					available: false,
					credentialType: null,
					source: "none",
					detail: null,
				},
				targetCount: 12,
			},
		];
		const rendered = renderConnectableProviderRows(rows);
		const rowLines = rendered.split("\n").filter((line) => line.startsWith("  "));
		strictEqual(rowLines.length, 2);
		strictEqual(rowLines[0]?.indexOf("disconnected"), rowLines[1]?.indexOf("disconnected"));
		ok(!rendered.includes("\t"), rendered);
	});
});
