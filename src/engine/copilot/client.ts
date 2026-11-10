/**
 * One Copilot runtime per process, started through the official SDK as a signed-in user.
 *
 * Clio passes no token and reads no token store. `useLoggedInUser` lets the runtime pick the login
 * itself: the official `copilot login` stored on disk under `COPILOT_HOME` (default `~/.copilot`), the
 * GitHub CLI's `gh auth login`, or a `copilot login` kept in the system keychain. The SDK's `empty` mode
 * Clio runs in turns the keychain off; a process where an operator can answer a keychain prompt
 * (`src/core/copilot-keychain.ts`) turns it back on and keeps every other empty-mode setting. GitHub token
 * variables are removed from the runtime's environment so an ambient `GH_TOKEN` cannot stand in for a login.
 * The SDK identifies itself to GitHub with its own client identity plus `clientName`; Clio sets no request
 * headers of its own.
 */
import type { ChildProcess } from "node:child_process";
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import { COPILOT_HEADLESS_LOGIN_FIX, copilotKeychainAllowed } from "../../core/copilot-keychain.js";
import { type CopilotSdkModule, loadCopilotSdk } from "./sdk-module.js";
import { copilotSessionFsConfig } from "./session-fs.js";

export const COPILOT_CLIENT_NAME = "clio-coder";

/** The GitHub account the official Copilot runtime is signed in as. Signing in is the authorization. */
export interface CopilotAccount {
	/** GitHub login the official Copilot runtime reports as signed in. */
	login: string;
	/** GitHub host, `https://github.com` unless the account is on GHE. */
	host: string;
}

export const COPILOT_LOGIN_MESSAGE =
	"GitHub Copilot is not signed in. Sign in with the official GitHub Copilot CLI (`copilot login`) or the GitHub CLI (`gh auth login`), then retry. Clio never signs in to Copilot itself.";

/** Why a process without an operator can miss a login the TUI sees. */
const KEYCHAIN_CLOSED_NOTE = `This process has no operator to answer a keychain prompt (headless \`clio-coder run\`, fleet workers, scripts), so the Copilot runtime keeps the system keychain closed and a \`copilot login\` stored only there is not visible here; the TUI, ACP and the GUI can use it. For headless use, ${COPILOT_HEADLESS_LOGIN_FIX}. \`clio-coder doctor\` in a terminal shows which login the runtime sees.`;

/** Environment variables that would authenticate the runtime as someone other than a signed-in user. */
const TOKEN_ENV_VARS = [
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;

export class CopilotLoginRequiredError extends Error {
	readonly code = "COPILOT_LOGIN_REQUIRED";
	constructor(detail?: string, keychainClosed = false) {
		super(
			[COPILOT_LOGIN_MESSAGE, ...(keychainClosed ? [KEYCHAIN_CLOSED_NOTE] : []), ...(detail ? [`(${detail})`] : [])].join(
				" ",
			),
		);
		this.name = "CopilotLoginRequiredError";
	}
}

function runtimeEnvironment(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of TOKEN_ENV_VARS) delete env[name];
	return env;
}

let shared: { client: CopilotClient; started: Promise<void>; keychain: boolean } | null = null;
let holds = 0;

/** The private fields of pinned SDK 1.0.26 this module relies on; nothing public exposes them. */
interface PinnedClientInternals {
	cliProcess?: ChildProcess | null;
	cliStartTimeout?: ReturnType<typeof setTimeout> | null;
	state?: string;
}

let layoutWarned = false;

/**
 * A missing private field means the SDK changed under the pin: one-shot commands may hang again and a lost
 * runtime may go unnoticed. Say so once instead of skipping silently.
 */
function warnLayout(missingFields: readonly string[]): void {
	if (layoutWarned || missingFields.length === 0) return;
	layoutWarned = true;
	process.emitWarning(
		`@github/copilot-sdk no longer exposes ${missingFields.join(", ")} where Clio expects them (pinned 1.0.26); one-shot commands may not exit and a lost Copilot runtime may not be detected.`,
		{ code: "CLIO_CODER_COPILOT_SDK_LAYOUT" },
	);
}

const runtimeGoneListeners = new Set<(client: CopilotClient, reason: string) => void>();

/** Notified when a started runtime exits or its connection is lost; its sessions are gone with it. */
export function onCopilotRuntimeGone(listener: (client: CopilotClient, reason: string) => void): void {
	runtimeGoneListeners.add(listener);
}

/** Forget a client whose runtime is gone, so the next use starts a fresh one, and tell its users. */
function invalidate(client: CopilotClient, reason: string): void {
	if (shared?.client !== client) return;
	shared = null;
	for (const listener of runtimeGoneListeners) listener(client, reason);
	void client.forceStop().catch(() => {});
}

function watchRuntime(client: CopilotClient): void {
	const internals = client as unknown as PinnedClientInternals;
	const child = internals.cliProcess;
	const absent = [
		...(child ? [] : ["cliProcess"]),
		...("cliStartTimeout" in internals ? [] : ["cliStartTimeout"]),
		...(typeof internals.state === "string" ? [] : ["state"]),
	];
	warnLayout(absent);
	if (!child) return;
	const gone = () => invalidate(client, "The GitHub Copilot runtime exited; its sessions were lost.");
	child.once("exit", gone);
	child.stdout?.once("close", gone);
}

/** A client whose connection the SDK marked closed cannot be used again; only a fresh start helps. */
function disconnected(client: CopilotClient): boolean {
	const state = (client as unknown as PinnedClientInternals).state;
	return state === "disconnected" || state === "error";
}

/**
 * The runtime child and its stdio pipes keep Node's event loop alive, so a one-shot command (configure, a
 * probe, headless run) would never exit while it runs. Work that awaits the runtime holds it; with no hold
 * the child and its pipes are unreferenced, so the process can exit, and the runtime ends with it when its
 * stdin closes. Live sessions survive an idle period between turns: nothing is stopped, only unreferenced.
 */
function setRuntimeReferenced(client: CopilotClient, referenced: boolean): void {
	// Pinned SDK 1.0.26 keeps the stdio child in `cliProcess` and leaves its 30 s start timeout armed after a
	// successful start (`cliStartTimeout`); it exposes no public handle for either. watchRuntime warns when absent.
	const internals = client as unknown as PinnedClientInternals;
	const child = internals.cliProcess;
	if (!child) return;
	for (const handle of [child, child.stdin, child.stdout, child.stderr, internals.cliStartTimeout]) {
		const counted = handle as { ref?: () => void; unref?: () => void } | null;
		if (referenced) counted?.ref?.();
		else counted?.unref?.();
	}
}

/** Keep the runtime referenced until the returned release runs. */
export function holdCopilotClient(): () => void {
	holds += 1;
	if (holds === 1 && shared)
		void shared.started.then(() => shared && holds > 0 && setRuntimeReferenced(shared.client, true)).catch(() => {});
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds -= 1;
		if (holds === 0 && shared) {
			const current = shared;
			void current.started.then(() => holds === 0 && setRuntimeReferenced(current.client, false)).catch(() => {});
		}
	};
}

async function held<T>(use: () => Promise<T>): Promise<T> {
	const release = holdCopilotClient();
	try {
		return await use();
	} finally {
		release();
	}
}

type RuntimeEnv = Record<string, string | undefined>;

/**
 * Let the runtime read its own system keychain. Pinned SDK 1.0.26 sets `COPILOT_DISABLE_KEYTAR=1` in
 * `buildRuntimeEnv` for `mode: "empty"`, after the caller's `env`, so no option can clear it. The wrapper drops
 * only that variable from the child's environment; the empty-mode prompt, tool and persistence settings and
 * its file-logging default are untouched. The SDK is a separately installed component, so a dependency patch
 * would never reach an npm install. A different SDK fails the start here instead of silently keeping the
 * keychain closed.
 */
function openRuntimeKeychain(client: CopilotClient): void {
	const internals = client as unknown as { buildRuntimeEnv?: (this: unknown) => RuntimeEnv };
	const build = internals.buildRuntimeEnv;
	if (typeof build !== "function")
		throw new Error(
			"@github/copilot-sdk no longer has buildRuntimeEnv (pinned 1.0.26); Clio cannot open the Copilot runtime's keychain. Re-verify the keychain override in src/engine/copilot/client.ts.",
		);
	internals.buildRuntimeEnv = function (this: unknown): RuntimeEnv {
		const env = build.call(this);
		if (env.COPILOT_DISABLE_KEYTAR !== "1")
			throw new Error(
				"@github/copilot-sdk no longer sets COPILOT_DISABLE_KEYTAR where Clio expects it (pinned 1.0.26); Clio cannot open the Copilot runtime's keychain. Re-verify the keychain override in src/engine/copilot/client.ts.",
			);
		delete env.COPILOT_DISABLE_KEYTAR;
		return env;
	};
}

/** A client in Clio's isolation settings; `keychain` decides whether the runtime may read the system keychain. */
export function createCopilotClient(sdk: CopilotSdkModule, keychain: boolean): CopilotClient {
	const client = new sdk.CopilotClient({
		useLoggedInUser: true,
		// "empty" keeps the runtime's own memory, skills, session store and config discovery off: Clio
		// supplies the prompt and every tool, and keeps the transcript.
		mode: "empty",
		// Empty mode needs a persistence location; session records go under Clio's cache, or stay in memory in
		// read-only mode (session-fs.ts).
		sessionFs: copilotSessionFsConfig(),
		env: runtimeEnvironment(),
		logLevel: "error",
	});
	if (keychain) openRuntimeKeychain(client);
	return client;
}

/** The process's runtime client, started on first use; concurrent callers share one start. */
export async function copilotClient(): Promise<CopilotClient> {
	if (shared && disconnected(shared.client)) {
		const stale = shared;
		await stale.started.catch(() => {});
		if (shared === stale && disconnected(stale.client)) invalidate(stale.client, "The Copilot connection was lost.");
	}
	if (!shared) {
		const sdk = await loadCopilotSdk();
		if (!shared) {
			// Read once per runtime start: a surface opts in before its first Copilot use.
			const keychain = copilotKeychainAllowed();
			const client = createCopilotClient(sdk, keychain);
			const started = client.start().then(() => {
				watchRuntime(client);
				setRuntimeReferenced(client, holds > 0);
			});
			shared = { client, started, keychain };
			started.catch(() => {
				if (shared?.client === client) shared = null;
			});
		}
	}
	const current = shared;
	if (!current) throw new Error("Copilot runtime failed to start");
	await current.started;
	return current.client;
}

/**
 * Stop the shared runtime when nothing holds it, so the next use starts one that reads a login made since it
 * started (an interactive `copilot login` run by `auth login copilot-sdk`).
 */
export function restartIdleCopilotClient(): void {
	if (shared && holds === 0) invalidate(shared.client, "Restarted to read a new GitHub Copilot login.");
}

/** The GitHub account the runtime is signed in as, or a login-required error naming `copilot login`. */
export function copilotAccount(): Promise<CopilotAccount> {
	return held(async () => {
		const client = await copilotClient();
		const status = await client.getAuthStatus();
		if (!status.isAuthenticated || !status.login)
			throw new CopilotLoginRequiredError(status.statusMessage, shared?.client === client && !shared.keychain);
		return { login: status.login, host: status.host ?? "https://github.com" };
	});
}

export interface CopilotSignInStatus {
	signedIn: boolean;
	login?: string;
	/** GitHub host of the login, `https://github.com` unless it is on GHE. */
	host?: string;
	/** Where the runtime found the login: `user` (a `copilot login`) or `gh-cli` (`gh auth login`). */
	authType?: string;
}

/**
 * Ask a short-lived runtime, separate from the process's shared one, whether it is signed in with the
 * keychain open or closed. Doctor compares the two to spot a login only the keychain holds; Clio sees only
 * the runtime's answer, never a token.
 */
export async function probeCopilotSignIn(keychain: boolean): Promise<CopilotSignInStatus> {
	const client = createCopilotClient(await loadCopilotSdk(), keychain);
	try {
		await client.start();
		const status = await client.getAuthStatus();
		return {
			signedIn: status.isAuthenticated && Boolean(status.login),
			...(status.login ? { login: status.login } : {}),
			...(status.host ? { host: status.host } : {}),
			...(status.authType ? { authType: status.authType } : {}),
		};
	} finally {
		await client.stop().catch(() => client.forceStop());
	}
}

export interface CopilotModelRow {
	id: string;
	label: string;
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
}

/**
 * Models the signed-in account may use, from the runtime's own listing. A model whose policy is disabled
 * or still unconfigured is left out: enabling one is the account owner's decision in GitHub, never Clio's.
 */
export function listCopilotModels(): Promise<CopilotModelRow[]> {
	return held(() => listHeld());
}

async function listHeld(): Promise<CopilotModelRow[]> {
	await copilotAccount();
	const client = await copilotClient();
	const models: ModelInfo[] = await client.listModels();
	const rows = models
		.filter((model) => model.policy === undefined || model.policy.state === "enabled")
		.map(
			(model): CopilotModelRow => ({
				id: model.id,
				label: model.name || model.id,
				contextWindow: model.capabilities?.limits?.max_context_window_tokens,
				maxOutputTokens: model.capabilities?.limits?.max_output_tokens,
				vision: model.capabilities?.supports?.vision === true,
				reasoning: model.capabilities?.supports?.reasoningEffort === true,
			}),
		);
	return rows;
}
