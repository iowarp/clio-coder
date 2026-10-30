/**
 * Quota adapter for the `codex-cli` runtime.
 *
 * Clio does not store Codex CLI credentials of its own: the runtime runs the
 * installed `codex` command, which keeps its OAuth record in `auth.json`
 * under `CODEX_HOME` or `~/.codex`. This adapter reads that file and never
 * writes it. The default location is a foreign user root, so a relocated
 * Clio home or `CLIO_CODER_INTEROP_HOME=none` turns it off unless
 * `CODEX_HOME` names it explicitly (#434).
 *
 * The request and response parsing live in `codex-usage.ts`, shared with the
 * `codex` adapter for Clio's own login.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { explicitAgentHome, interopDisabled, isClioHomeRelocated } from "../../core/xdg.js";
import type { CodexAccountToken } from "./codex-usage.js";
import { fetchCodexUsage, isRecord } from "./codex-usage.js";
import type { QuotaProvider, UsageSnapshot } from "./types.js";

export const CODEX_CLI_QUOTA_PROVIDER_ID = "codex-cli";

const DISPLAY_NAME = "Codex CLI";
const REQUEST_TIMEOUT_MS = 15_000;

export interface CodexCliQuotaOptions {
	/** Override the credential file location; defaults to `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. */
	credentialsPath?: string;
	/** Replace credential reading entirely, which is how tests supply a token. */
	readCredentials?: () => Promise<CodexAccountToken | null>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	now?: () => Date;
}

/** Codex's default credential file path, or null when interop rules exclude it. */
function defaultCodexCredentialsPath(): string | null {
	const home = explicitAgentHome("CODEX_HOME");
	if (home) return join(home, "auth.json");
	return isClioHomeRelocated() || interopDisabled() ? null : join(homedir(), ".codex", "auth.json");
}

/** Extract the access token and account id from a parsed credential document. */
function parseCodexCliCredentials(raw: unknown): CodexAccountToken | null {
	if (!isRecord(raw)) return null;
	const tokens = raw.tokens;
	if (!isRecord(tokens)) return null;
	const accessToken = tokens.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) return null;
	const accountId = tokens.account_id;
	return {
		accessToken,
		accountId: typeof accountId === "string" ? accountId : null,
	};
}

async function readCredentialsFile(path: string): Promise<CodexAccountToken | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		return parseCodexCliCredentials(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Build the read-only `codex-cli` quota adapter. */
export function createCodexCliQuotaProvider(options: CodexCliQuotaOptions = {}): QuotaProvider {
	const credentialsPath = options.credentialsPath ?? defaultCodexCredentialsPath();
	const readCredentials =
		options.readCredentials ??
		(() => (credentialsPath === null ? Promise.resolve(null) : readCredentialsFile(credentialsPath)));
	const doFetch = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());

	const snapshot = (
		status: UsageSnapshot["status"],
		message: string | null,
		extra: Partial<UsageSnapshot> = {},
	): UsageSnapshot => ({
		providerId: CODEX_CLI_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,
		status,
		windows: [],
		message,
		fetchedAt: now().toISOString(),
		...extra,
	});

	return {
		id: CODEX_CLI_QUOTA_PROVIDER_ID,
		displayName: DISPLAY_NAME,

		async detect(): Promise<boolean> {
			return (await readCredentials()) !== null;
		},

		async fetch(): Promise<UsageSnapshot> {
			const credentials = await readCredentials();
			if (credentials === null) {
				return snapshot("no_credentials", "No Codex CLI credentials found");
			}
			const usage = await fetchCodexUsage(credentials, {
				fetch: doFetch,
				timeoutMs,
				identity: { "User-Agent": "codex-cli" },
			});
			if (usage.status !== "ok") return snapshot(usage.status, usage.message ?? "Sign in with Codex again");
			return snapshot("ok", null, { windows: usage.windows, credits: usage.credits, plan: usage.plan });
		},
	};
}
