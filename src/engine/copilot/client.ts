/**
 * One Copilot runtime per process, started through the official SDK as a signed-in user.
 *
 * Clio passes no token and reads no token store. `useLoggedInUser` lets the runtime pick the login
 * itself: the official `copilot login` stored on disk under `COPILOT_HOME` (default `~/.copilot`), the
 * GitHub CLI's `gh auth login`, or a `copilot login` kept in the system keychain. The SDK's `empty` mode
 * Clio runs in turns the keychain off; a process where an operator can answer a keychain prompt
 * (`src/core/copilot-keychain.ts`) turns it back on and keeps every other empty-mode setting. GitHub token
 * variables are removed from the runtime's environment so an ambient `GH_TOKEN` cannot stand in for a login,
 * and the variables a parent Copilot CLI exports are removed so the SDK always starts its own bundled runtime.
 * The SDK identifies itself to GitHub with its own client identity plus `clientName`; Clio sets no request
 * headers of its own.
 */
import type { ChildProcess } from "node:child_process";
import type { CopilotClient, ModelInfo } from "@github/copilot-sdk";
import { COPILOT_HEADLESS_LOGIN_FIX, copilotKeychainAllowed } from "../../core/copilot-keychain.js";
import type { ThinkingLevel } from "../../core/defaults.js";
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
	"GitHub Copilot is not signed in. Sign in with the official GitHub Copilot CLI (`copilot login`) or the GitHub CLI (`gh auth login`), then retry. CLIO Coder never signs in to Copilot itself.";

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

/**
 * Variables a parent Copilot CLI exports to its children. Pinned SDK 1.0.26 launches `COPILOT_CLI_PATH` in
 * place of its bundled runtime (`client.js` `conn.path ?? effectiveEnv.COPILOT_CLI_PATH`), so an inherited
 * value would start the parent's Copilot CLI, whose protocol the pinned SDK may not speak. The rest describe
 * the parent's loader and session, not the runtime Clio starts.
 */
const HOST_RUNTIME_ENV_VARS = [
	"COPILOT_CLI_PATH",
	"COPILOT_CLI",
	"COPILOT_CLI_RESOLVED_DIST_DIR",
	"COPILOT_CLI_BINARY_VERSION",
	"COPILOT_LOADER_PID",
	"COPILOT_AGENT_SESSION_ID",
] as const;

const PROTOCOL_MISMATCH = /SDK protocol version mismatch/;

/** The runtime Clio started speaks a protocol the pinned SDK does not; updating the SDK is not the operator's fix. */
export class CopilotRuntimeMismatchError extends Error {
	readonly code = "COPILOT_RUNTIME_MISMATCH";
	constructor(detail: string) {
		super(
			`The GitHub Copilot runtime that started speaks a different protocol version than CLIO Coder's pinned @github/copilot-sdk, so it is not the runtime bundled with that SDK. The likely cause is an inherited or foreign Copilot CLI runtime, such as another Copilot CLI install the SDK resolved in place of its own. Reinstall the component with \`clio-coder tools install copilot-sdk\` and retry. (${detail})`,
		);
		this.name = "CopilotRuntimeMismatchError";
	}
}

/** Start a client, naming a protocol mismatch for what it is. */
async function startClient(client: CopilotClient): Promise<void> {
	try {
		await client.start();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (PROTOCOL_MISMATCH.test(message))
			throw new CopilotRuntimeMismatchError(message.replace(/\.? Please update .*$/, ""));
		throw err;
	}
}

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

/** The runtime's environment: no token that could stand in for a login, nothing pointing at a parent's Copilot CLI. */
function runtimeEnvironment(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of [...TOKEN_ENV_VARS, ...HOST_RUNTIME_ENV_VARS]) delete env[name];
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
		`@github/copilot-sdk no longer exposes ${missingFields.join(", ")} where CLIO Coder expects them (pinned 1.0.26); one-shot commands may not exit and a lost Copilot runtime may not be detected.`,
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
			"@github/copilot-sdk no longer has buildRuntimeEnv (pinned 1.0.26); CLIO Coder cannot open the Copilot runtime's keychain. Re-verify the keychain override in src/engine/copilot/client.ts.",
		);
	internals.buildRuntimeEnv = function (this: unknown): RuntimeEnv {
		const env = build.call(this);
		if (env.COPILOT_DISABLE_KEYTAR !== "1")
			throw new Error(
				"@github/copilot-sdk no longer sets COPILOT_DISABLE_KEYTAR where CLIO Coder expects it (pinned 1.0.26); CLIO Coder cannot open the Copilot runtime's keychain. Re-verify the keychain override in src/engine/copilot/client.ts.",
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
			const started = startClient(client).then(() => {
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

/** Return the already-started shared client without spawning a runtime; `null` if none is connected. */
export function heldCopilotClient(): CopilotClient | null {
	if (!shared || disconnected(shared.client)) return null;
	const internals = shared.client as unknown as PinnedClientInternals;
	if (internals.state && internals.state !== "connected") return null;
	return shared.client;
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
		await startClient(client);
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

export type CopilotContextTier = "default" | "long_context";

/** A model's token prices on one tier, in the runtime's own unit (AI credits per `batchSize` tokens). */
export interface CopilotModelPrices {
	input: number | undefined;
	output: number | undefined;
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
	batchSize: number | undefined;
}

/** One tier's token prices exactly as the listing states them; each price is per `batchSize` tokens. */
export interface CopilotListingTierPrices {
	inputPrice?: number;
	outputPrice?: number;
	/** The SDK marks this deprecated in favour of `cacheReadPrice`; carried while the listing still states it. */
	cachePrice?: number;
	cacheReadPrice?: number;
	cacheWritePrice?: number;
	cacheWrite1hPrice?: number;
	/** The SDK marks this deprecated in favour of `maxPromptTokens`; carried while the listing still states it. */
	contextMax?: number;
	maxPromptTokens?: number;
}

export interface CopilotListingTokenPrices extends CopilotListingTierPrices {
	batchSize?: number;
	longContext?: CopilotListingTierPrices;
}

/** A server-driven promotion the listing states for the signed-in account. */
export interface CopilotListingPromo {
	id?: string;
	discountPercent?: number;
	endsAt?: string;
	message?: string;
	showBanner?: boolean;
}

/**
 * The seat's tariff for one model as the SDK listing (`@experimental`) reports it. A field the listing left
 * out stays absent; nothing here is defaulted, converted or priced.
 */
export interface CopilotListingBilling {
	multiplier?: number;
	discountPercent?: number;
	promo?: CopilotListingPromo;
	tokenPrices?: CopilotListingTokenPrices;
}

export interface CopilotModelRow {
	id: string;
	label: string;
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
	/**
	 * The effort values the listing names for this model (`supportedReasoningEfforts`) in Clio's vocabulary,
	 * `none` read as `off`; absent when the model takes no effort.
	 */
	reasoningLevels?: ThinkingLevel[];
	/** The listing's `defaultReasoningEffort`, when it names one. */
	reasoningDefaultLevel?: ThinkingLevel;
	/** The tier the window and prices were read for; `default` unless the target opted into `long_context`. */
	contextTier: CopilotContextTier;
	prices: CopilotModelPrices | undefined;
	/**
	 * The long-context tier's window and prices, when the listing publishes that tier
	 * (`billing.tokenPrices.longContext`). A copilot-sdk target with `contextTier: long_context` reads these.
	 */
	longContext?: { contextWindow: number | undefined; prices: CopilotModelPrices | undefined };
	/** The listing's full billing for this model; absent when the listing states none. */
	billing?: CopilotListingBilling;
	/** When the listing was read (ISO 8601), the as-of time of `billing`. */
	listingReadAt: string;
}

/**
 * Models the signed-in account may use, from the runtime's own listing. A model whose policy is disabled
 * or still unconfigured is left out: enabling one is the account owner's decision in GitHub, never Clio's.
 * Each row carries the default tier and, when the listing has one, the long-context tier beside it.
 */
export function listCopilotModels(): Promise<CopilotModelRow[]> {
	return held(() => listHeld());
}

/**
 * The prompt budget Copilot enforces sits under the context window; compaction must trip below it. A session
 * on the default tier has the budget `billing.tokenPrices.maxPromptTokens`; one opted into `long_context` has
 * `billing.tokenPrices.longContext.maxPromptTokens`. `capabilities.limits` can describe the long-context tier
 * (live 2026-11-10: Claude Opus 5.5 limits 1M, default tier 200K, the budget the runtime refused at). A model
 * whose listing has no long-context budget keeps its default budget whatever tier was asked for.
 */
function promptWindow(model: ModelInfo, tier: CopilotContextTier): number | undefined {
	const limits = model.capabilities?.limits;
	const prices = model.billing?.tokenPrices;
	const longBudget = tier === "long_context" ? prices?.longContext?.maxPromptTokens : undefined;
	const budgets = [
		limits?.max_context_window_tokens,
		limits?.max_prompt_tokens,
		longBudget ?? prices?.maxPromptTokens,
	].filter((tokens): tokens is number => tokens !== undefined);
	return budgets.length === 0 ? undefined : Math.min(...budgets);
}

/** The tier's prices: the long-context ones under `long_context` when the listing has them, else the default ones. */
function tierPrices(model: ModelInfo, tier: CopilotContextTier): CopilotModelPrices | undefined {
	const prices = model.billing?.tokenPrices;
	if (!prices) return undefined;
	const source = tier === "long_context" && prices.longContext ? prices.longContext : prices;
	return {
		input: source.inputPrice,
		output: source.outputPrice,
		cacheRead: source.cacheReadPrice ?? source.cachePrice,
		cacheWrite: source.cacheWritePrice,
		batchSize: prices.batchSize,
	};
}

const EFFORT_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A listed effort value in Clio's vocabulary; the runtime's `none` is Clio's `off`. */
function listedLevel(effort: string | undefined): ThinkingLevel | undefined {
	if (effort === "none") return "off";
	return EFFORT_ORDER.find((level) => level !== "off" && level === effort);
}

/** The listing's effort set, ordered and deduplicated, for a model that takes an effort. */
function listedReasoning(model: ModelInfo): Pick<CopilotModelRow, "reasoningLevels" | "reasoningDefaultLevel"> {
	if (model.capabilities?.supports?.reasoningEffort !== true) return {};
	const listed = new Set((model.supportedReasoningEfforts ?? []).map((effort) => listedLevel(effort)));
	const levels = EFFORT_ORDER.filter((level) => listed.has(level));
	if (levels.length === 0) return {};
	const preset = listedLevel(model.defaultReasoningEffort);
	return { reasoningLevels: levels, ...(preset && levels.includes(preset) ? { reasoningDefaultLevel: preset } : {}) };
}

const TIER_PRICE_KEYS = [
	"inputPrice",
	"outputPrice",
	"cachePrice",
	"cacheReadPrice",
	"cacheWritePrice",
	"cacheWrite1hPrice",
	"contextMax",
	"maxPromptTokens",
] as const satisfies readonly (keyof CopilotListingTierPrices)[];
const PROMO_KEYS = [
	"id",
	"discountPercent",
	"endsAt",
	"message",
	"showBanner",
] as const satisfies readonly (keyof CopilotListingPromo)[];

/** The named fields the source states, each copied as is; a field it left out stays out. */
function stated<T extends object>(source: T, keys: readonly (keyof T)[]): T {
	const out: Partial<T> = {};
	for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
	return out as T;
}

/** The listing's billing for one model, field for field. The SDK's public `ModelInfo` type omits `promo` and `discountPercent`. */
function listingBilling(model: ModelInfo): CopilotListingBilling | undefined {
	const billing = model.billing as CopilotListingBilling | undefined;
	if (!billing) return undefined;
	const prices = billing.tokenPrices;
	return {
		...stated(billing, ["multiplier", "discountPercent"]),
		...(billing.promo ? { promo: stated(billing.promo, PROMO_KEYS) } : {}),
		...(prices
			? {
					tokenPrices: {
						...stated(prices, [...TIER_PRICE_KEYS, "batchSize"]),
						...(prices.longContext ? { longContext: stated(prices.longContext, TIER_PRICE_KEYS) } : {}),
					},
				}
			: {}),
	};
}

/** One listing row read for a tier; the contract test feeds it a faked listing row. */
export function copilotModelRow(
	model: ModelInfo,
	contextTier: CopilotContextTier = "default",
	listingReadAt: string = new Date().toISOString(),
): CopilotModelRow {
	const long = model.billing?.tokenPrices?.longContext;
	const billing = listingBilling(model);
	return {
		id: model.id,
		label: model.name || model.id,
		contextWindow: promptWindow(model, contextTier),
		maxOutputTokens: model.capabilities?.limits?.max_output_tokens,
		vision: model.capabilities?.supports?.vision === true,
		reasoning: model.capabilities?.supports?.reasoningEffort === true,
		...listedReasoning(model),
		contextTier,
		prices: tierPrices(model, contextTier),
		...(long
			? {
					longContext: {
						contextWindow: promptWindow(model, "long_context"),
						prices: tierPrices(model, "long_context"),
					},
				}
			: {}),
		...(billing ? { billing } : {}),
		listingReadAt,
	};
}

/**
 * When the runtime fetched each listed model. The SDK's `listModels` answers from a per-client cache that hands back
 * the same model objects until it refetches, so a cache hit keeps the time of the fetch that produced it and never
 * passes an old tariff off as freshly read.
 */
const listingFetchedAt = new WeakMap<ModelInfo, string>();

async function listHeld(): Promise<CopilotModelRow[]> {
	await copilotAccount();
	const client = await copilotClient();
	const models: ModelInfo[] = await client.listModels();
	const answeredAt = new Date().toISOString();
	return models
		.filter((model) => model.policy === undefined || model.policy.state === "enabled")
		.map((model) => {
			let readAt = listingFetchedAt.get(model);
			if (readAt === undefined) {
				readAt = answeredAt;
				listingFetchedAt.set(model, readAt);
			}
			return copilotModelRow(model, "default", readAt);
		});
}
