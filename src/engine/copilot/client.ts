/**
 * One Copilot runtime per process, started through the official SDK with the signed-in user only.
 *
 * Clio passes no token and reads no token store: `useLoggedInUser` makes the runtime use the login that
 * the official `copilot login` wrote under `COPILOT_HOME` (default `~/.copilot`). GitHub token variables
 * are removed from the runtime's environment so an ambient `GH_TOKEN` cannot stand in for that login.
 * The SDK identifies itself to GitHub with its own client identity plus `clientName`; Clio sets no
 * request headers of its own.
 */
import type { ChildProcess } from "node:child_process";
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import type { CopilotAccount } from "../../domains/providers/copilot-consent.js";
import { loadCopilotSdk } from "./sdk-module.js";
import { copilotSessionFsConfig } from "./session-fs.js";

export const COPILOT_CLIENT_NAME = "clio-coder";

export const COPILOT_LOGIN_MESSAGE =
	"GitHub Copilot is not signed in. Sign in with the official GitHub Copilot CLI (`copilot login`), then retry. Clio never signs in to Copilot itself.";

/** Environment variables that would authenticate the runtime as someone other than the `copilot login` user. */
const TOKEN_ENV_VARS = [
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;

export class CopilotLoginRequiredError extends Error {
	readonly code = "COPILOT_LOGIN_REQUIRED";
	constructor(detail?: string) {
		super(detail ? `${COPILOT_LOGIN_MESSAGE} (${detail})` : COPILOT_LOGIN_MESSAGE);
		this.name = "CopilotLoginRequiredError";
	}
}

function runtimeEnvironment(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of TOKEN_ENV_VARS) delete env[name];
	return env;
}

let shared: { client: CopilotClient; started: Promise<void> } | null = null;
let holds = 0;

/**
 * The runtime child and its stdio pipes keep Node's event loop alive, so a one-shot command (configure, a
 * probe, headless run) would never exit while it runs. Work that awaits the runtime holds it; with no hold
 * the child and its pipes are unreferenced, so the process can exit, and the runtime ends with it when its
 * stdin closes. Live sessions survive an idle period between turns: nothing is stopped, only unreferenced.
 */
function setRuntimeReferenced(client: CopilotClient, referenced: boolean): void {
	// Pinned SDK 1.0.26 keeps the stdio child in `cliProcess` and leaves its 30 s start timeout armed after a
	// successful start (`cliStartTimeout`); it exposes no public handle for either.
	const internals = client as unknown as {
		cliProcess?: ChildProcess | null;
		cliStartTimeout?: ReturnType<typeof setTimeout> | null;
	};
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
		void shared.started.then(() => shared && holds > 0 && setRuntimeReferenced(shared.client, true));
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

/** The process's runtime client, started on first use; concurrent callers share one start. */
export async function copilotClient(): Promise<CopilotClient> {
	if (!shared) {
		const sdk = await loadCopilotSdk();
		if (!shared) {
			const client = new sdk.CopilotClient({
				useLoggedInUser: true,
				// "empty" keeps the runtime's own memory, skills, session store and config discovery off: Clio
				// supplies the prompt and every tool, and keeps the transcript.
				mode: "empty",
				// Empty mode needs a persistence location; session records go under Clio's cache (session-fs.ts).
				sessionFs: copilotSessionFsConfig(),
				env: runtimeEnvironment(),
				logLevel: "error",
			});
			const started = client.start().then(() => setRuntimeReferenced(client, holds > 0));
			shared = { client, started };
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

/** The GitHub account the runtime is signed in as, or a login-required error naming `copilot login`. */
export function copilotAccount(): Promise<CopilotAccount> {
	return held(async () => {
		const client = await copilotClient();
		const status = await client.getAuthStatus();
		if (!status.isAuthenticated || !status.login) throw new CopilotLoginRequiredError(status.statusMessage);
		return { login: status.login, host: status.host ?? "https://github.com" };
	});
}

export interface CopilotModelRow {
	id: string;
	label: string;
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
	/** Premium-request multiplier the runtime reports for the model. */
	multiplier: number | undefined;
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
				multiplier: model.billing?.multiplier,
			}),
		);
	return rows;
}
