import {
	AcpClient,
	AcpClientError,
	type AcpClientTiming,
	type AcpFailure,
	type AcpLaunchSpec,
	type AcpPermissionRequest,
	AcpRemoteError,
	AcpTimeoutError,
	localAcpLaunch,
	type ValidatedAcpUpdate,
} from "./acp-client.ts";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const ENGINE_KINDS = ["fake", "clio-acp"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export const ENGINE_PHASES = [
	"ready",
	"unprobed",
	"probing",
	"unavailable",
	"starting",
	"connected",
	"running",
	"awaiting-approval",
	"cancelling",
	"failed",
] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

export type EngineSource =
	| "simulated-by-workbench"
	| "reported-by-clio"
	| "observed-on-acp"
	| "observed-by-workbench"
	| "independently-verified";

export type ReadinessKey = "runtime" | "protocol" | "project" | "target" | "authentication" | "provider" | "context";
export type ReadinessState = "ready" | "unavailable" | "failed";

export interface EngineReadinessFact {
	readonly key: ReadinessKey;
	readonly label: string;
	readonly state: ReadinessState;
	readonly detail: string;
	readonly source: EngineSource;
}

export interface EngineSnapshot {
	readonly kind: EngineKind;
	readonly phase: EnginePhase;
	readonly facts: readonly EngineReadinessFact[];
	readonly checkedAt?: string;
}

export interface EngineProject {
	readonly projectId: string;
	readonly trustedRoot: string;
	readonly displayName: string;
}

export interface EngineContext {
	readonly projectId: string;
	readonly engineKind: EngineKind;
	readonly generation: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export interface EngineUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
}

export type EngineEvent =
	| Readonly<{
		type: "engine.state";
		projectId: string;
		snapshot: EngineSnapshot;
	}>
	| Readonly<{
		type: "turn.started";
		context: EngineContext;
		promptSummary: string;
		scenario?: "complete" | "failure";
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.text" | "turn.thought";
		context: EngineContext;
		text: string;
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.agent";
		context: EngineContext;
		agentId: string;
		name: string;
		task: string;
		status: "active" | "complete" | "canceled" | "failed";
		summary: string;
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.tool";
		context: EngineContext;
		toolCallId: string;
		title: string;
		kind: string;
		status: "in_progress" | "completed" | "failed" | "canceled";
		summary: string;
		locations: readonly (readonly string[])[];
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.change";
		context: EngineContext;
		path: readonly string[];
		summary: string;
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.permission.requested";
		context: EngineContext;
		permissionId: string;
		toolCallId: string;
		title: string;
		kind: string;
		locations: readonly (readonly string[])[];
		expiresAt: string;
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.permission.resolved";
		context: EngineContext;
		permissionId: string;
		decision: "allow_once" | "reject_once" | "cancelled" | "timeout" | "disconnect";
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.evidence";
		context: EngineContext;
		label: string;
		detail: string;
		status: "observed" | "reported" | "unavailable";
		source: EngineSource;
	}>
	| Readonly<{
		type: "turn.terminal";
		context: EngineContext;
		outcome: "completed" | "canceled" | "failed";
		code: string;
		summary: string;
		stopReason?: (typeof PROMPT_STOP_REASONS)[number];
		usage?: EngineUsage;
		source: EngineSource;
	}>;

export interface EngineSink {
	emit(event: EngineEvent): void;
	refreshProject(projectId: string): Promise<void>;
}

export interface ClioLauncher {
	probe(trustedRoot: string): Promise<Readonly<{ version: string }>>;
	launch(trustedRoot: string): AcpLaunchSpec;
}

export interface LocalClioLauncherOptions {
	readonly executable?: string;
	readonly prefixArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly clearEnv?: boolean;
	readonly permissionTimeoutMs?: number;
	readonly probeTimeoutMs?: number;
}

export interface EngineCoordinatorOptions {
	readonly launcher: ClioLauncher;
	readonly eventDelayMs?: number;
	readonly acpTiming?: AcpClientTiming;
	readonly promptTimeoutMs?: number;
	readonly now?: () => number;
}

export interface StartTurnInput {
	readonly owner: EngineSink;
	readonly project: EngineProject;
	readonly prompt: string;
	readonly fakeScenario?: "complete" | "failure";
}

export interface ResolvePermissionInput {
	readonly owner: EngineSink;
	readonly projectId: string;
	readonly turnId: string;
	readonly permissionId: string;
	readonly decision: "allow_once" | "reject_once";
}

export interface CancelTurnInput {
	readonly owner: EngineSink;
	readonly projectId: string;
	readonly turnId: string;
}

export class EngineError extends Error {
	readonly code: "invalid" | "conflict" | "not-ready" | "not-found" | "internal";

	constructor(code: EngineError["code"], message: string) {
		super(message);
		this.name = "EngineError";
		this.code = code;
	}
}

const encoder = new TextEncoder();
const MAX_PROMPT_BYTES = 4 * 1024;
const MAX_CUMULATIVE_STREAM_BYTES = 256 * 1024;
const MAX_ACP_UPDATES_PER_TURN = 1_024;
const MAX_TOOLS_PER_TURN = 128;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROBE_CLEANUP_OBSERVATION_MS = 2_000;
const PROBE_HELPER_TIMEOUT_MS = 250;
const INITIALIZE_TIMEOUT_MS = 5_000;
const NEW_SESSION_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_SESSION_ID_BYTES = 128;
const MAX_STOP_REASON_BYTES = 64;
const MAX_TOOL_KIND_BYTES = 64;
const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;
const MAX_PERMISSION_TIMEOUT_MS = 300_000;
const PROMPT_STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;

function bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || bytes(value) > maximum) {
		throw new EngineError("internal", `${label} failed validation.`);
	}
	return value;
}

function safeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function fakeFacts(): readonly EngineReadinessFact[] {
	return [
		{
			key: "runtime",
			label: "Engine",
			state: "ready",
			detail: "Deterministic in-host fixture",
			source: "simulated-by-workbench",
		},
		{
			key: "protocol",
			label: "Protocol",
			state: "unavailable",
			detail: "ACP is not used in fake mode",
			source: "simulated-by-workbench",
		},
		{
			key: "project",
			label: "Project",
			state: "ready",
			detail: "Opaque project boundary retained",
			source: "observed-by-workbench",
		},
		{
			key: "target",
			label: "Target",
			state: "unavailable",
			detail: "No provider target is used",
			source: "simulated-by-workbench",
		},
		{
			key: "authentication",
			label: "Authentication",
			state: "unavailable",
			detail: "No credentials are used",
			source: "simulated-by-workbench",
		},
		{
			key: "provider",
			label: "Provider",
			state: "unavailable",
			detail: "No provider request is made",
			source: "simulated-by-workbench",
		},
		{
			key: "context",
			label: "Context",
			state: "unavailable",
			detail: "Clio context is not loaded",
			source: "simulated-by-workbench",
		},
	];
}

function unprobedFacts(): readonly EngineReadinessFact[] {
	return [
		{ key: "runtime", label: "Runtime", state: "unavailable", detail: "Not checked", source: "observed-by-workbench" },
		{
			key: "protocol",
			label: "Protocol",
			state: "unavailable",
			detail: "Not checked",
			source: "observed-by-workbench",
		},
		{
			key: "project",
			label: "Project",
			state: "unavailable",
			detail: "Not revalidated",
			source: "observed-by-workbench",
		},
		{
			key: "target",
			label: "Target",
			state: "unavailable",
			detail: "Not exposed by the safe probe",
			source: "observed-by-workbench",
		},
		{
			key: "authentication",
			label: "Authentication",
			state: "unavailable",
			detail: "Not exposed by the safe probe",
			source: "observed-by-workbench",
		},
		{
			key: "provider",
			label: "Provider",
			state: "unavailable",
			detail: "No provider request was made",
			source: "observed-by-workbench",
		},
		{
			key: "context",
			label: "Context",
			state: "unavailable",
			detail: "Not exposed by the safe probe",
			source: "observed-by-workbench",
		},
	];
}

function readyClioFacts(version: string): readonly EngineReadinessFact[] {
	return [
		{ key: "runtime", label: "Runtime", state: "ready", detail: version, source: "observed-by-workbench" },
		{
			key: "protocol",
			label: "Protocol",
			state: "ready",
			detail: "Clio advertises the ACP v1 command",
			source: "observed-by-workbench",
		},
		{
			key: "project",
			label: "Project",
			state: "ready",
			detail: "Trusted canonical root revalidated",
			source: "observed-by-workbench",
		},
		{
			key: "target",
			label: "Target",
			state: "unavailable",
			detail: "Validated on first prompt admission",
			source: "observed-by-workbench",
		},
		{
			key: "authentication",
			label: "Authentication",
			state: "unavailable",
			detail: "Validated on first prompt admission",
			source: "observed-by-workbench",
		},
		{
			key: "provider",
			label: "Provider",
			state: "unavailable",
			detail: "No health request was made",
			source: "observed-by-workbench",
		},
		{
			key: "context",
			label: "Context",
			state: "unavailable",
			detail: "Reported context metadata is unavailable",
			source: "observed-by-workbench",
		},
	];
}

function unavailableFacts(): readonly EngineReadinessFact[] {
	return unprobedFacts().map((fact) =>
		fact.key === "runtime" || fact.key === "protocol" || fact.key === "project"
			? { ...fact, state: "failed" as const, detail: "Required readiness check failed" }
			: fact
	);
}

function safeSnapshot(
	kind: EngineKind,
	phase: EnginePhase,
	facts: readonly EngineReadinessFact[],
	checkedAt?: string,
): EngineSnapshot {
	return { kind, phase, facts, ...(checkedAt === undefined ? {} : { checkedAt }) };
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	let output = new Uint8Array(0);
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return output;
			if (output.byteLength + value.byteLength > MAX_PROBE_OUTPUT_BYTES) {
				throw new EngineError("not-ready", "The Clio readiness probe exceeded its output bound.");
			}
			const combined = new Uint8Array(output.byteLength + value.byteLength);
			combined.set(output);
			combined.set(value, output.byteLength);
			output = combined;
		}
	} finally {
		reader.releaseLock();
	}
}

function boundedProbeValue<T>(
	operation: Promise<T>,
	milliseconds: number,
): Promise<Readonly<{ completed: true; value: T }> | Readonly<{ completed: false }>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Readonly<{ completed: false }>>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout({ completed: false }), milliseconds);
	});
	return Promise.race([
		operation.then((value) => ({ completed: true as const, value })),
		timeout,
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function runProbeKillHelper(args: readonly string[]): Promise<boolean | null> {
	try {
		const helper = new Deno.Command("kill", {
			args: [...args],
			stdin: "null",
			stdout: "null",
			stderr: "null",
		}).spawn();
		const completed = await boundedProbeValue(helper.status, PROBE_HELPER_TIMEOUT_MS);
		if (!completed.completed) {
			try {
				helper.kill("SIGKILL");
			} catch {
				// The helper may have exited at its timeout boundary.
			}
			return null;
		}
		return completed.value.success;
	} catch {
		return null;
	}
}

async function signalOwnedProbeGroup(pid: number, signal: Deno.Signal): Promise<void> {
	try {
		Deno.kill(-pid, signal);
		return;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return;
		if (
			!(error instanceof Deno.errors.PermissionDenied) && !(error instanceof Deno.errors.NotCapable)
		) return;
	}

	// Executable-scoped --allow-run does not authorize process-wide Deno.kill.
	// The separately allowlisted helper receives only this owned negative PGID.
	await runProbeKillHelper(["-s", signal.replace(/^SIG/u, ""), "--", `-${pid}`]);
}

function ownedProbeGroupExists(pid: number): Promise<boolean | null> {
	return runProbeKillHelper(["-s", "0", "--", `-${pid}`]);
}

async function waitForOwnedProbeGroupExit(pid: number): Promise<boolean> {
	const deadline = Date.now() + PROBE_CLEANUP_OBSERVATION_MS;
	while (true) {
		const exists = await ownedProbeGroupExists(pid);
		if (exists === false) return true;
		if (exists === null || Date.now() >= deadline) return false;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(10, deadline - Date.now())));
	}
}

async function retireProbeProcess(
	child: Deno.ChildProcess,
	status: Promise<Deno.CommandStatus>,
	ownsProcessGroup: boolean,
): Promise<boolean> {
	if (ownsProcessGroup) await signalOwnedProbeGroup(child.pid, "SIGKILL");
	else {
		try {
			child.kill("SIGKILL");
		} catch {
			// The direct child may already have exited normally.
		}
	}
	const leaderExited = (await boundedProbeValue(status, PROBE_CLEANUP_OBSERVATION_MS)).completed;
	if (!ownsProcessGroup) return leaderExited;
	return leaderExited && await waitForOwnedProbeGroupExit(child.pid);
}

async function runProbeCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<Record<string, string>> | undefined,
	clearEnv: boolean | undefined,
	timeoutMs: number,
): Promise<string> {
	const ownsProcessGroup = Deno.build.os !== "windows";
	const child = new Deno.Command(command, {
		args: [...args],
		cwd,
		...(env === undefined ? {} : { env: { ...env } }),
		...(clearEnv === undefined ? {} : { clearEnv }),
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
		detached: ownsProcessGroup,
	}).spawn();
	const status = child.status;
	const stdout = readBounded(child.stdout);
	const stderr = readBounded(child.stderr).catch(() => new Uint8Array(0));
	let outcome: Readonly<{ succeeded: true; text: string }> | Readonly<{ succeeded: false; error: unknown }>;
	try {
		let completed: Awaited<ReturnType<typeof boundedProbeOutcome>>;
		try {
			completed = await boundedProbeOutcome(status, stdout, stderr, timeoutMs);
		} catch {
			throw new EngineError("not-ready", "The Clio readiness probe returned an invalid bounded result.");
		}
		if (!completed.completed) throw new EngineError("not-ready", "The Clio readiness probe timed out.");
		const [commandStatus, output] = completed.value;
		if (!commandStatus.success) {
			throw new EngineError("not-ready", "The Clio readiness probe did not complete successfully.");
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
		} catch {
			throw new EngineError("not-ready", "The Clio readiness probe returned invalid text.");
		}
		if (text.length === 0 || bytes(text) > MAX_PROBE_OUTPUT_BYTES) {
			throw new EngineError("not-ready", "The Clio readiness probe returned no bounded result.");
		}
		outcome = { succeeded: true, text };
	} catch (error) {
		outcome = { succeeded: false, error };
	}
	if (!await retireProbeProcess(child, status, ownsProcessGroup)) {
		throw new EngineError("not-ready", "The Clio readiness probe could not retire its owned process scope.");
	}
	if (!outcome.succeeded) throw outcome.error;
	return outcome.text;
}

function boundedProbeOutcome(
	status: Promise<Deno.CommandStatus>,
	stdout: Promise<Uint8Array>,
	stderr: Promise<Uint8Array>,
	timeoutMs: number,
): Promise<
	| Readonly<{ completed: true; value: readonly [Deno.CommandStatus, Uint8Array, Uint8Array] }>
	| Readonly<{ completed: false }>
> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ completed: false }>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout({ completed: false }), timeoutMs);
	});
	return Promise.race([
		Promise.all([status, stdout, stderr]).then((value) => ({ completed: true as const, value })),
		timeout,
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export function createLocalClioLauncher(options: LocalClioLauncherOptions = {}): ClioLauncher {
	const executable = options.executable ?? "clio-coder";
	const prefixArgs = [...(options.prefixArgs ?? [])];
	const permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000;
	const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	return {
		async probe(trustedRoot) {
			const versionOutput = await runProbeCommand(
				executable,
				[...prefixArgs, "--version"],
				trustedRoot,
				options.env,
				options.clearEnv,
				probeTimeoutMs,
			);
			const helpOutput = await runProbeCommand(
				executable,
				[...prefixArgs, "acp", "--help"],
				trustedRoot,
				options.env,
				options.clearEnv,
				probeTimeoutMs,
			);
			if (!helpOutput.includes("clio-coder acp")) {
				throw new EngineError("not-ready", "The installed Clio command did not advertise its ACP subcommand.");
			}
			const version = versionOutput.split(/\r?\n/, 1)[0]?.slice(0, 128) ?? "";
			if (version.length === 0 || hasControlCharacter(version)) {
				throw new EngineError("not-ready", "The installed Clio version response was invalid.");
			}
			return { version };
		},
		launch(trustedRoot) {
			const launch = localAcpLaunch(executable, trustedRoot, permissionTimeoutMs, prefixArgs);
			return {
				...launch,
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.clearEnv === undefined ? {} : { clearEnv: options.clearEnv }),
			};
		},
	};
}

interface ProjectEngineState {
	snapshot: EngineSnapshot;
	trustedRoot?: string;
}

interface BaseRun {
	readonly owner: EngineSink;
	readonly project: EngineProject;
	readonly context: EngineContext;
	settling: boolean;
}

interface FakeRun extends BaseRun {
	readonly kind: "fake";
	readonly scenario: "complete" | "failure";
	readonly permissionId: string;
	readonly timers: Set<ReturnType<typeof setTimeout>>;
	permissionExpiresAt: number | null;
	permissionTimer: ReturnType<typeof setTimeout> | null;
	phase: "running" | "awaiting-approval" | "finishing";
}

interface RealTool {
	readonly publicId: string;
	readonly rawTitle: string;
	readonly kind: string;
	readonly locations: readonly (readonly string[])[];
	terminal: boolean;
}

interface RealPermission {
	readonly publicId: string;
	readonly request: AcpPermissionRequest;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface RealRun extends BaseRun {
	readonly kind: "clio-acp";
	readonly client: AcpClient;
	readonly done: Promise<void>;
	readonly resolveDone: () => void;
	rawSessionId: string | null;
	supportsClose: boolean;
	promptActive: boolean;
	cancelRequested: boolean;
	streamBytes: number;
	streamTail: string;
	streamTailType: "message" | "thought" | null;
	projectionClosed: boolean;
	updateCount: number;
	hasSubstantiveActivity: boolean;
	toolCounter: number;
	readonly tools: Map<string, RealTool>;
	permission: RealPermission | null;
	transportFailure: AcpFailure | null;
}

type ActiveRun = FakeRun | RealRun;

interface ProjectedPromptResult {
	readonly stopReason: (typeof PROMPT_STOP_REASONS)[number];
	readonly usage: EngineUsage;
}

interface TerminalProjection {
	readonly outcome: "completed" | "canceled" | "failed";
	readonly code: string;
	readonly summary: string;
	readonly stopReason?: (typeof PROMPT_STOP_REASONS)[number];
	readonly usage?: EngineUsage;
	readonly source: EngineSource;
	readonly cancelActive?: boolean;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

function validateProject(project: EngineProject): void {
	boundedString(project.projectId, "projectId", 128);
	boundedString(project.displayName, "project display name", 256);
	boundedString(project.trustedRoot, "trusted project root", 4 * 1024);
	if (!isAbsolute(project.trustedRoot)) throw new EngineError("invalid", "The trusted project root must be absolute.");
}

function isInsideRoot(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function canonicalExistingAncestor(candidate: string): string | null {
	let current = candidate;
	while (true) {
		try {
			return Deno.realPathSync(current);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) return null;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

function projectLocations(
	trustedRoot: string,
	rawLocations: readonly string[],
): readonly (readonly string[])[] {
	const result: Array<readonly string[]> = [];
	for (const rawLocation of rawLocations) {
		// ACP locations are untrusted presentation hints, never authority. A bad
		// hint disappears without turning an otherwise valid turn into a failure.
		if (!isAbsolute(rawLocation) || hasControlCharacter(rawLocation)) continue;
		const candidate = resolve(rawLocation);
		if (!isInsideRoot(trustedRoot, candidate)) continue;
		const ancestor = canonicalExistingAncestor(candidate);
		if (ancestor === null || !isInsideRoot(trustedRoot, ancestor)) continue;
		const local = relative(trustedRoot, candidate);
		if (local === "") continue;
		const segments = local.split(sep).filter((segment) => segment.length > 0);
		if (segments.some((segment) => segment === "." || segment === ".." || hasControlCharacter(segment))) continue;
		result.push(segments);
	}
	return result;
}

function safeToolTitle(kind: string): string {
	const labels: Readonly<Record<string, string>> = {
		read: "Read project content",
		edit: "Edit project content",
		delete: "Delete project content",
		move: "Move project content",
		search: "Search project content",
		execute: "Run a project command",
		think: "Reason about the task",
		fetch: "Fetch external content",
		switch_mode: "Change work mode",
		other: "Use a Clio tool",
	};
	return labels[kind] ?? labels.other ?? "Use a Clio tool";
}

function validateInitialize(value: unknown): Readonly<{ supportsClose: boolean }> {
	if (!isRecord(value) || value.protocolVersion !== 1 || !isRecord(value.agentInfo)) {
		throw new EngineError("internal", "Clio returned an invalid ACP initialize result.");
	}
	if (value.agentInfo.name !== "clio-coder" || !isRecord(value.agentCapabilities)) {
		throw new EngineError("internal", "The ACP peer did not identify as Clio.");
	}
	const capabilities = value.agentCapabilities;
	if (
		capabilities.loadSession !== false || !isRecord(capabilities.promptCapabilities) ||
		!isRecord(capabilities.mcpCapabilities) || !isRecord(capabilities._meta)
	) throw new EngineError("internal", "Clio returned unsupported ACP capabilities.");
	const sessionMeta = capabilities._meta["clio-coder/session"];
	if (!isRecord(sessionMeta) || sessionMeta.close !== true || capabilities._meta["clio-coder/tools"] !== "mediated") {
		throw new EngineError("internal", "Clio did not advertise the mediated ACP session contract.");
	}
	if (!Array.isArray(value.authMethods)) throw new EngineError("internal", "Clio returned invalid ACP auth metadata.");
	return { supportsClose: true };
}

function validateNewSession(value: unknown): string {
	if (!isRecord(value)) throw new EngineError("internal", "Clio returned an invalid ACP session result.");
	return boundedString(value.sessionId, "Clio sessionId", MAX_SESSION_ID_BYTES);
}

function validateUsage(value: unknown): EngineUsage {
	if (!isRecord(value)) throw new EngineError("internal", "Clio returned invalid bounded usage metadata.");
	const input = safeInteger(value.input);
	const output = safeInteger(value.output);
	const cacheRead = safeInteger(value.cacheRead);
	const cacheWrite = safeInteger(value.cacheWrite);
	const reasoning = safeInteger(value.reasoning);
	if (input === null || output === null || cacheRead === null || cacheWrite === null || reasoning === null) {
		throw new EngineError("internal", "Clio returned invalid bounded usage metadata.");
	}
	return { input, output, cacheRead, cacheWrite, reasoning };
}

function validatePromptResult(value: unknown): ProjectedPromptResult {
	if (!isRecord(value)) throw new EngineError("internal", "Clio returned an invalid ACP prompt result.");
	const stopReason = boundedString(value.stopReason, "Clio stopReason", MAX_STOP_REASON_BYTES);
	if (!(PROMPT_STOP_REASONS as readonly string[]).includes(stopReason)) {
		throw new EngineError("internal", "Clio returned an unsupported ACP stop reason.");
	}
	if (!isRecord(value._meta)) throw new EngineError("internal", "Clio omitted bounded ACP usage metadata.");
	const usage = validateUsage(value._meta["clio-coder/usage"]);
	return { stopReason: stopReason as ProjectedPromptResult["stopReason"], usage };
}

type PublicClioFailure = Readonly<Pick<TerminalProjection, "code" | "summary">>;

const CLIO_PROTOCOL_VERSION_FAILURE: PublicClioFailure = {
	code: "clio-protocol-version-unsupported",
	summary: "Clio does not support the ACP protocol version required by Workbench.",
};

const C001_REMOTE_ERROR_CODES = [
	"not_initialized",
	"already_initialized",
	"protocol_version_unsupported",
	"invalid_params",
	"session_cwd_mismatch",
	"session_limit",
	"session_unknown",
	"prompt_active",
	"prompt_not_admitted",
	"turn_failed",
	"parse_error",
	"invalid_request",
	"method_not_found",
	"internal_error",
	"input_line_too_large",
	"invalid_request_id",
] as const;
type C001RemoteErrorCode = (typeof C001_REMOTE_ERROR_CODES)[number];

const CLIO_REMOTE_FAILURES = {
	not_initialized: {
		code: "clio-not-initialized",
		summary: "Clio rejected the operation because its ACP session was not initialized.",
	},
	already_initialized: {
		code: "clio-already-initialized",
		summary: "Clio reported that its ACP connection was already initialized.",
	},
	protocol_version_unsupported: CLIO_PROTOCOL_VERSION_FAILURE,
	invalid_params: {
		code: "clio-invalid-params",
		summary: "Clio rejected the bounded ACP parameters.",
	},
	session_cwd_mismatch: {
		code: "clio-session-cwd-mismatch",
		summary: "Clio rejected the session because its project root did not match the launched workspace.",
	},
	session_limit: {
		code: "clio-session-limit",
		summary: "Clio rejected an unexpected additional session on this owned process.",
	},
	prompt_not_admitted: {
		code: "clio-prompt-not-admitted",
		summary: "Clio could not admit this turn.",
	},
	turn_failed: {
		code: "clio-turn-failed",
		summary: "Clio reported that the admitted turn failed.",
	},
	parse_error: {
		code: "clio-parse-error",
		summary: "Clio rejected input that did not parse as JSON.",
	},
	invalid_request: {
		code: "clio-invalid-request",
		summary: "Clio rejected an invalid JSON-RPC request shape.",
	},
	method_not_found: {
		code: "clio-method-not-found",
		summary: "Clio did not recognize the requested ACP method.",
	},
	internal_error: {
		code: "clio-internal-error",
		summary: "Clio reported an internal ACP handler failure.",
	},
	input_line_too_large: {
		code: "clio-input-line-too-large",
		summary: "Clio rejected an ACP input line that exceeded its bound.",
	},
	invalid_request_id: {
		code: "clio-invalid-request-id",
		summary: "Clio rejected an invalid JSON-RPC request identifier.",
	},
	prompt_active: {
		code: "clio-prompt-active",
		summary: "Clio reported an unexpected active-prompt conflict.",
	},
	session_unknown: {
		code: "clio-session-unknown",
		summary: "Clio no longer recognized the bounded session.",
	},
} satisfies Readonly<Record<C001RemoteErrorCode, PublicClioFailure>>;

const CLIO_ADMISSION_FAILURES: Readonly<Record<string, PublicClioFailure>> = {
	"orchestrator-not-configured": {
		code: "clio-admission-orchestrator-not-configured",
		summary: "Clio requires orchestrator configuration before it can start this turn.",
	},
	"target-unknown": {
		code: "clio-admission-target-unknown",
		summary: "Clio does not recognize the configured target for this turn.",
	},
	"target-not-configured": {
		code: "clio-admission-target-not-configured",
		summary: "Clio requires a configured target before it can start this turn.",
	},
	"target-not-found": {
		code: "clio-admission-target-not-found",
		summary: "Clio could not locate the configured target for this turn.",
	},
	"runtime-not-registered": {
		code: "clio-admission-runtime-not-registered",
		summary: "Clio requires a registered runtime for the configured target.",
	},
	"model-not-configured": {
		code: "clio-admission-model-not-configured",
		summary: "Clio requires a configured model before it can start this turn.",
	},
	"chat-unsupported": {
		code: "clio-admission-chat-unsupported",
		summary: "The configured Clio target does not support chat turns.",
	},
	"streaming-unsupported": {
		code: "clio-admission-streaming-unsupported",
		summary: "The configured Clio target does not support streaming turns.",
	},
	"admission-failed": {
		code: "clio-admission-failed",
		summary: "Clio could not admit this turn.",
	},
};

function protocolVersionFailure(supported: readonly number[] | undefined): PublicClioFailure {
	const versions = [...new Set((supported ?? []).filter((version) => Number.isSafeInteger(version) && version >= 0))]
		.sort((left, right) => left - right);
	return {
		code: CLIO_PROTOCOL_VERSION_FAILURE.code,
		summary: versions.length === 0
			? CLIO_PROTOCOL_VERSION_FAILURE.summary
			: `${CLIO_PROTOCOL_VERSION_FAILURE.summary} Supported versions: ${versions.join(", ")}.`,
	};
}

function mappedClioFailure(code: string): PublicClioFailure | undefined {
	if (!(C001_REMOTE_ERROR_CODES as readonly string[]).includes(code)) return undefined;
	return CLIO_REMOTE_FAILURES[code as C001RemoteErrorCode];
}

function failureProjection(error: unknown, transportFailure: AcpFailure | null): TerminalProjection {
	if (error instanceof AcpRemoteError && error.remote !== null) {
		const projected = error.remote.code === "protocol_version_unsupported"
			? protocolVersionFailure(error.remote.supported)
			: error.remote.code === "prompt_not_admitted" && error.remote.reason !== undefined
			? CLIO_ADMISSION_FAILURES[error.remote.reason] ?? CLIO_REMOTE_FAILURES.prompt_not_admitted
			: mappedClioFailure(error.remote.code);
		return {
			outcome: "failed",
			code: projected?.code ?? "clio-operation-rejected",
			summary: projected?.summary ?? "Clio rejected the bounded ACP operation.",
			source: "reported-by-clio",
		};
	}
	if (transportFailure !== null) {
		return {
			outcome: "failed",
			code: `acp-${transportFailure.code}`,
			summary: transportFailure.message,
			source: "observed-by-workbench",
		};
	}
	if (error instanceof AcpClientError) {
		return {
			outcome: "failed",
			code: "acp-client-failure",
			summary: "The bounded Clio ACP client could not complete this turn.",
			source: "observed-by-workbench",
		};
	}
	return {
		outcome: "failed",
		code: "acp-contract-failure",
		summary: "Clio did not satisfy the bounded Workbench integration contract.",
		source: "observed-by-workbench",
	};
}

function sameLocations(
	left: readonly (readonly string[])[],
	right: readonly (readonly string[])[],
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function consumeProjectRedaction(
	pending: string,
	trustedRoot: string,
	final: boolean,
): Readonly<{ text: string; remainder: string }> {
	if (final) return { text: pending.replaceAll(trustedRoot, "[project]"), remainder: "" };
	let offset = 0;
	let text = "";
	while (offset < pending.length) {
		const matchAt = pending.indexOf(trustedRoot, offset);
		if (matchAt >= 0) {
			text += `${pending.slice(offset, matchAt)}[project]`;
			offset = matchAt + trustedRoot.length;
			continue;
		}
		const tail = pending.slice(offset);
		let retained = Math.min(tail.length, trustedRoot.length - 1);
		while (retained > 0 && !tail.endsWith(trustedRoot.slice(0, retained))) retained -= 1;
		text += tail.slice(0, tail.length - retained);
		return { text, remainder: tail.slice(tail.length - retained) };
	}
	return { text, remainder: "" };
}

export class EngineCoordinator {
	readonly #launcher: ClioLauncher;
	readonly #eventDelayMs: number;
	readonly #acpTiming: AcpClientTiming;
	readonly #permissionTimeoutMs: number;
	readonly #promptTimeoutMs: number;
	readonly #now: () => number;
	readonly #projects = new Map<string, ProjectEngineState>();
	#active: ActiveRun | null = null;
	#counter = 0;
	#closed = false;

	constructor(options: EngineCoordinatorOptions) {
		this.#launcher = options.launcher;
		this.#eventDelayMs = options.eventDelayMs ?? 120;
		if (!Number.isSafeInteger(this.#eventDelayMs) || this.#eventDelayMs < 0 || this.#eventDelayMs > 10_000) {
			throw new EngineError("invalid", "eventDelayMs must be a bounded non-negative integer.");
		}
		this.#acpTiming = options.acpTiming ?? {};
		this.#permissionTimeoutMs = this.#acpTiming.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.#permissionTimeoutMs) || this.#permissionTimeoutMs < 1 ||
			this.#permissionTimeoutMs > MAX_PERMISSION_TIMEOUT_MS
		) throw new EngineError("invalid", "permissionTimeoutMs must be a bounded positive integer.");
		this.#promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.#promptTimeoutMs) || this.#promptTimeoutMs < 1 ||
			this.#promptTimeoutMs > DEFAULT_PROMPT_TIMEOUT_MS
		) throw new EngineError("invalid", "promptTimeoutMs must be a bounded positive integer.");
		this.#now = options.now ?? Date.now;
	}

	snapshot(projectId: string): EngineSnapshot {
		boundedString(projectId, "projectId", 128);
		return this.#projectState(projectId).snapshot;
	}

	select(owner: EngineSink, project: EngineProject, kind: EngineKind): EngineSnapshot {
		this.#assertOpen();
		validateProject(project);
		if (!(ENGINE_KINDS as readonly string[]).includes(kind)) throw new EngineError("invalid", "Unknown engine kind.");
		if (this.#active !== null) throw new EngineError("conflict", "Cancel the active turn before changing engines.");
		const snapshot = kind === "fake"
			? safeSnapshot("fake", "ready", fakeFacts())
			: safeSnapshot("clio-acp", "unprobed", unprobedFacts());
		this.#projects.set(project.projectId, { snapshot });
		owner.emit({ type: "engine.state", projectId: project.projectId, snapshot });
		return snapshot;
	}

	async probe(owner: EngineSink, project: EngineProject): Promise<EngineSnapshot> {
		this.#assertOpen();
		validateProject(project);
		if (this.#active !== null) throw new EngineError("conflict", "Cancel the active turn before checking readiness.");
		const current = this.#projectState(project.projectId);
		if (current.snapshot.kind !== "clio-acp") {
			throw new EngineError("invalid", "Select Clio before checking readiness.");
		}
		const probing = safeSnapshot("clio-acp", "probing", unprobedFacts());
		this.#projects.set(project.projectId, { snapshot: probing });
		owner.emit({ type: "engine.state", projectId: project.projectId, snapshot: probing });
		try {
			const result = await this.#launcher.probe(project.trustedRoot);
			const version = boundedString(result.version, "Clio version", 128);
			if (hasControlCharacter(version)) throw new EngineError("not-ready", "The installed Clio version was invalid.");
			const ready = safeSnapshot("clio-acp", "ready", readyClioFacts(version), new Date(this.#now()).toISOString());
			this.#projects.set(project.projectId, { snapshot: ready, trustedRoot: project.trustedRoot });
			owner.emit({ type: "engine.state", projectId: project.projectId, snapshot: ready });
			return ready;
		} catch (error) {
			const unavailable = safeSnapshot(
				"clio-acp",
				"unavailable",
				unavailableFacts(),
				new Date(this.#now()).toISOString(),
			);
			this.#projects.set(project.projectId, { snapshot: unavailable });
			owner.emit({ type: "engine.state", projectId: project.projectId, snapshot: unavailable });
			if (error instanceof EngineError) throw error;
			throw new EngineError("not-ready", "The local Clio readiness check failed.");
		}
	}

	async start(input: StartTurnInput): Promise<EngineContext> {
		// Keep command failures on the asynchronous host boundary used by the
		// WebSocket dispatcher, even though all admission checks are local.
		await Promise.resolve();
		this.#assertOpen();
		validateProject(input.project);
		const prompt = input.prompt.trim();
		if (prompt.length === 0 || bytes(prompt) > MAX_PROMPT_BYTES) {
			throw new EngineError("invalid", "The prompt must contain at most 4 KiB of non-blank text.");
		}
		if (this.#active !== null) throw new EngineError("conflict", "The single Workbench engine slot is already active.");
		const state = this.#projectState(input.project.projectId);
		if (state.snapshot.phase !== "ready") {
			throw new EngineError(
				"not-ready",
				"The selected engine requires an explicit readiness transition before another turn.",
			);
		}
		if (state.snapshot.kind === "fake") return this.#startFake(input, prompt);
		if (
			state.trustedRoot !== input.project.trustedRoot ||
			!state.snapshot.facts.filter((fact) =>
				fact.key === "runtime" || fact.key === "protocol" || fact.key === "project"
			)
				.every((fact) => fact.state === "ready")
		) throw new EngineError("not-ready", "Check Clio readiness again for this trusted project root.");
		return this.#startReal(input, prompt);
	}

	async resolvePermission(input: ResolvePermissionInput): Promise<void> {
		this.#assertOpen();
		const run = this.#active;
		if (
			run === null || run.owner !== input.owner || run.project.projectId !== input.projectId ||
			run.context.turnId !== input.turnId
		) throw new EngineError("not-found", "That permission does not belong to the active project turn.");
		if (run.kind === "fake") {
			if (run.phase !== "awaiting-approval" || run.permissionId !== input.permissionId) {
				throw new EngineError("not-found", "That fake permission is no longer active.");
			}
			if (run.permissionExpiresAt === null || this.#now() >= run.permissionExpiresAt) {
				await this.#expireFakePermission(run);
				throw new EngineError("not-found", "That fake permission has expired.");
			}
			this.#resolveFakePermission(run, input.decision);
			return;
		}
		if (run.permission === null || run.permission.publicId !== input.permissionId) {
			throw new EngineError("not-found", "That Clio permission is no longer active.");
		}
		let expired = false;
		try {
			expired = await this.#settleRealPermission(run, input.decision, input.decision);
			this.#resumeRealAfterPermission(run);
		} catch {
			await this.#finishReal(run, {
				outcome: "failed",
				code: "permission-settlement-failed",
				summary: "Workbench could not settle the bounded Clio permission request.",
				source: "observed-by-workbench",
				cancelActive: true,
			});
			throw new EngineError("internal", "The permission decision could not be delivered safely.");
		}
		if (expired) throw new EngineError("not-found", "That Clio permission has expired.");
	}

	async cancel(input: CancelTurnInput): Promise<void> {
		this.#assertOpen();
		const run = this.#active;
		if (
			run === null || run.owner !== input.owner || run.project.projectId !== input.projectId ||
			run.context.turnId !== input.turnId
		) throw new EngineError("not-found", "That turn is not active for this project client.");
		if (run.kind === "fake") {
			await this.#cancelFake(run, "Canceled by the operator.");
			return;
		}
		run.cancelRequested = true;
		this.#setRunPhase(run, "cancelling");
		if (run.permission !== null) {
			try {
				await this.#settleRealPermission(run, "cancelled", "cancelled");
			} catch {
				// Owned process retirement below is the fail-closed settlement fallback.
			}
		}
		await this.#finishReal(run, {
			outcome: "canceled",
			code: "operator-cancelled",
			summary: "The Clio turn was canceled and its owned process was retired.",
			stopReason: "cancelled",
			source: "observed-by-workbench",
			cancelActive: true,
		});
		await run.done;
	}

	async disconnect(owner: EngineSink): Promise<void> {
		const run = this.#active;
		if (run === null || run.owner !== owner) return;
		if (run.kind === "fake") {
			await this.#cancelFake(run, "The local client disconnected; the turn failed closed.", "disconnect");
			return;
		}
		run.cancelRequested = true;
		if (run.permission !== null) {
			try {
				await this.#settleRealPermission(run, "disconnect", "cancelled");
			} catch {
				// Owned process retirement below is the fail-closed settlement fallback.
			}
		}
		await this.#finishReal(run, {
			outcome: "canceled",
			code: "client-disconnected",
			summary: "The local client disconnected; the Clio turn failed closed.",
			stopReason: "cancelled",
			source: "observed-by-workbench",
			cancelActive: true,
		});
		await run.done;
	}

	async close(): Promise<void> {
		if (this.#closed) {
			const active = this.#active;
			if (active?.kind === "clio-acp") await active.done;
			return;
		}
		this.#closed = true;
		const run = this.#active;
		if (run === null) return;
		if (run.kind === "fake") await this.#cancelFake(run, "Workbench is shutting down.", "disconnect");
		else {
			run.cancelRequested = true;
			if (run.permission !== null) {
				try {
					await this.#settleRealPermission(run, "disconnect", "cancelled");
				} catch {
					// Owned process retirement below is the fail-closed settlement fallback.
				}
			}
			await this.#finishReal(run, {
				outcome: "canceled",
				code: "host-shutdown",
				summary: "Workbench shut down and retired the owned Clio process.",
				stopReason: "cancelled",
				source: "observed-by-workbench",
				cancelActive: true,
			});
			await run.done;
		}
	}

	#projectState(projectId: string): ProjectEngineState {
		let state = this.#projects.get(projectId);
		if (state === undefined) {
			state = { snapshot: safeSnapshot("fake", "ready", fakeFacts()) };
			this.#projects.set(projectId, state);
		}
		return state;
	}

	#assertOpen(): void {
		if (this.#closed) throw new EngineError("not-ready", "The Workbench engine coordinator is closed.");
	}

	#nextSuffix(): string {
		this.#counter += 1;
		return String(this.#counter).padStart(4, "0");
	}

	#startFake(input: StartTurnInput, prompt: string): EngineContext {
		const suffix = this.#nextSuffix();
		const context: EngineContext = {
			projectId: input.project.projectId,
			engineKind: "fake",
			generation: `generation-fake-${suffix}`,
			sessionId: `session-fake-${suffix}`,
			turnId: `turn-fake-${suffix}`,
		};
		const run: FakeRun = {
			kind: "fake",
			owner: input.owner,
			project: input.project,
			context,
			settling: false,
			scenario: input.fakeScenario ?? "complete",
			permissionId: `permission-fake-${suffix}`,
			timers: new Set(),
			permissionExpiresAt: null,
			permissionTimer: null,
			phase: "running",
		};
		this.#active = run;
		this.#setRunPhase(run, "running");
		input.owner.emit({
			type: "turn.started",
			context,
			promptSummary: prompt.slice(0, 260),
			scenario: run.scenario,
			source: "simulated-by-workbench",
		});
		this.#scheduleFake(run, 1, () =>
			input.owner.emit({
				type: "turn.thought",
				context,
				text: "Planning a bounded investigation before any consequential action.",
				source: "simulated-by-workbench",
			}));
		this.#scheduleFake(run, 2, () =>
			input.owner.emit({
				type: "turn.agent",
				context,
				agentId: "agent-evidence-01",
				name: "Evidence scout",
				task: "Check the numerical-method boundary",
				status: "active",
				summary: "A project-keyed deterministic agent started.",
				source: "simulated-by-workbench",
			}));
		this.#scheduleFake(run, 3, () => this.#emitFakeTool(run, "in_progress"));
		this.#scheduleFake(run, 4, () => this.#emitFakeTool(run, "completed"));
		this.#scheduleFake(run, 5, () =>
			input.owner.emit({
				type: "turn.change",
				context,
				path: ["analysis", "convergence-notes.md"],
				summary: "Prepared an attributed fake artifact; no project file was written.",
				source: "simulated-by-workbench",
			}));
		this.#scheduleFake(run, 6, () => {
			run.phase = "awaiting-approval";
			this.#setRunPhase(run, "awaiting-approval");
			const expiresAt = this.#armFakePermissionDeadline(run);
			input.owner.emit({
				type: "turn.permission.requested",
				context,
				permissionId: run.permissionId,
				toolCallId: "tool-fake-artifact",
				title: "Record the fake analysis artifact?",
				kind: "edit",
				locations: [["analysis", "convergence-notes.md"]],
				expiresAt: new Date(expiresAt).toISOString(),
				source: "simulated-by-workbench",
			});
		});
		return context;
	}

	#emitFakeTool(run: FakeRun, status: "in_progress" | "completed"): void {
		run.owner.emit({
			type: "turn.tool",
			context: run.context,
			toolCallId: "tool-fake-inspect",
			title: "Inspect convergence inputs",
			kind: "read",
			status,
			summary: status === "completed"
				? "Fixture inspection finished with a bounded result."
				: "Reading a purpose-built fake DTO.",
			locations: [["data", "mesh-study.csv"]],
			source: "simulated-by-workbench",
		});
	}

	#resolveFakePermission(run: FakeRun, decision: "allow_once" | "reject_once"): void {
		this.#clearFakePermissionDeadline(run);
		run.phase = "finishing";
		run.owner.emit({
			type: "turn.permission.resolved",
			context: run.context,
			permissionId: run.permissionId,
			decision,
			source: "simulated-by-workbench",
		});
		if (decision === "reject_once") {
			this.#scheduleFake(run, 1, async () => {
				run.owner.emit({
					type: "turn.agent",
					context: run.context,
					agentId: "agent-evidence-01",
					name: "Evidence scout",
					task: "Check the numerical-method boundary",
					status: "canceled",
					summary: "The rejected branch was not applied.",
					source: "simulated-by-workbench",
				});
				await this.#finishFake(run, "canceled", "operator-rejected", "The operator rejected the fake artifact action.");
			});
			return;
		}
		this.#scheduleFake(run, 1, () =>
			run.owner.emit({
				type: "turn.evidence",
				context: run.context,
				label: run.scenario === "failure" ? "Focused deterministic check failed" : "Focused deterministic check",
				detail: run.scenario === "failure"
					? "One requested fixture failed."
					: "Twelve deterministic fixtures passed; no live Clio process or provider was contacted.",
				status: "observed",
				source: "simulated-by-workbench",
			}));
		this.#scheduleFake(run, 2, () =>
			run.owner.emit({
				type: "turn.agent",
				context: run.context,
				agentId: "agent-evidence-01",
				name: "Evidence scout",
				task: "Check the numerical-method boundary",
				status: run.scenario === "failure" ? "failed" : "complete",
				summary: run.scenario === "failure" ? "Returned a bounded failure." : "Returned observed fixture evidence.",
				source: "simulated-by-workbench",
			}));
		this.#scheduleFake(run, 3, () =>
			this.#finishFake(
				run,
				run.scenario === "failure" ? "failed" : "completed",
				run.scenario === "failure" ? "fake-verification-failed" : "fake-completed",
				run.scenario === "failure"
					? "The deterministic verifier reached its configured failure outcome."
					: "Request, work, attributed change, observed check, and outcome are linked.",
			));
	}

	async #cancelFake(
		run: FakeRun,
		summary: string,
		permissionDecision: "cancelled" | "timeout" | "disconnect" = "cancelled",
		terminalCode = "fake-cancelled",
	): Promise<void> {
		this.#clearFakePermissionDeadline(run);
		if (run.phase === "awaiting-approval") {
			run.owner.emit({
				type: "turn.permission.resolved",
				context: run.context,
				permissionId: run.permissionId,
				decision: permissionDecision,
				source: "observed-by-workbench",
			});
		}
		run.owner.emit({
			type: "turn.agent",
			context: run.context,
			agentId: "agent-evidence-01",
			name: "Evidence scout",
			task: "Check the numerical-method boundary",
			status: "canceled",
			summary: "The deterministic activity stopped at the operator boundary.",
			source: "simulated-by-workbench",
		});
		await this.#finishFake(run, "canceled", terminalCode, summary);
	}

	async #expireFakePermission(run: FakeRun): Promise<void> {
		if (this.#active !== run || run.settling || run.phase !== "awaiting-approval") return;
		await this.#cancelFake(
			run,
			"The fake permission expired and the deterministic turn failed closed.",
			"timeout",
			"permission-timeout",
		);
	}

	#finishFake(
		run: FakeRun,
		outcome: "completed" | "canceled" | "failed",
		code: string,
		summary: string,
	): Promise<void> {
		if (run.settling || this.#active !== run) return Promise.resolve();
		run.settling = true;
		this.#clearFakePermissionDeadline(run);
		for (const timer of run.timers) clearTimeout(timer);
		run.timers.clear();
		run.owner.emit({
			type: "turn.terminal",
			context: run.context,
			outcome,
			code,
			summary,
			source: "simulated-by-workbench",
		});
		this.#active = null;
		const snapshot = safeSnapshot("fake", "ready", fakeFacts());
		this.#projects.set(run.project.projectId, { snapshot });
		run.owner.emit({ type: "engine.state", projectId: run.project.projectId, snapshot });
		this.#refreshProjectBestEffort(run);
		return Promise.resolve();
	}

	#scheduleFake(run: FakeRun, step: number, action: () => void | Promise<void>): void {
		const timer = setTimeout(() => {
			run.timers.delete(timer);
			if (this.#active === run && !run.settling) void action();
		}, this.#eventDelayMs * step);
		run.timers.add(timer);
	}

	#armFakePermissionDeadline(run: FakeRun): number {
		const expiresAt = this.#now() + this.#permissionTimeoutMs;
		run.permissionExpiresAt = expiresAt;
		const timer = setTimeout(() => {
			run.timers.delete(timer);
			if (run.permissionTimer !== timer) return;
			run.permissionTimer = null;
			if (this.#active === run && !run.settling && run.phase === "awaiting-approval") {
				void this.#expireFakePermission(run).catch(() => undefined);
			}
		}, this.#permissionTimeoutMs);
		run.permissionTimer = timer;
		run.timers.add(timer);
		return expiresAt;
	}

	#clearFakePermissionDeadline(run: FakeRun): void {
		if (run.permissionTimer !== null) {
			clearTimeout(run.permissionTimer);
			run.timers.delete(run.permissionTimer);
			run.permissionTimer = null;
		}
		run.permissionExpiresAt = null;
	}

	#startReal(input: StartTurnInput, prompt: string): EngineContext {
		let run: RealRun | null = null;
		const client = AcpClient.spawn(this.#launcher.launch(input.project.trustedRoot), {
			onUpdate: (generation, update) => {
				if (run === null) throw new EngineError("internal", "Clio emitted an update before ownership was bound.");
				this.#handleRealUpdate(run, generation, update);
			},
			onPermission: (generation, request) => {
				if (run === null) throw new EngineError("internal", "Clio requested permission before ownership was bound.");
				this.#handleRealPermission(run, generation, request);
			},
			onFailure: (generation, failure) => {
				if (run !== null && run.context.generation === generation) run.transportFailure = failure;
			},
		}, this.#acpTiming);
		const suffix = this.#nextSuffix();
		const context: EngineContext = {
			projectId: input.project.projectId,
			engineKind: "clio-acp",
			generation: client.generation,
			sessionId: `session-clio-${suffix}`,
			turnId: `turn-clio-${suffix}`,
		};
		const completion = deferred();
		run = {
			kind: "clio-acp",
			owner: input.owner,
			project: input.project,
			context,
			client,
			done: completion.promise,
			resolveDone: completion.resolve,
			settling: false,
			rawSessionId: null,
			supportsClose: false,
			promptActive: false,
			cancelRequested: false,
			streamBytes: 0,
			streamTail: "",
			streamTailType: null,
			projectionClosed: false,
			updateCount: 0,
			hasSubstantiveActivity: false,
			toolCounter: 0,
			tools: new Map(),
			permission: null,
			transportFailure: null,
		};
		this.#active = run;
		this.#setRunPhase(run, "starting");
		void this.#driveReal(run, prompt);
		return context;
	}

	async #driveReal(run: RealRun, prompt: string): Promise<void> {
		try {
			const initialize = await run.client.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "clio-workbench", title: "Clio Workbench", version: "0.0.1" },
			}, INITIALIZE_TIMEOUT_MS);
			if (run.settling) return;
			run.supportsClose = validateInitialize(initialize).supportsClose;
			this.#setRunPhase(run, "connected");
			const session = await run.client.request("session/new", {
				cwd: run.project.trustedRoot,
				mcpServers: [],
			}, NEW_SESSION_TIMEOUT_MS);
			if (run.settling) return;
			run.rawSessionId = validateNewSession(session);
			this.#setRunPhase(run, "running");
			run.owner.emit({
				type: "turn.started",
				context: run.context,
				promptSummary: prompt.slice(0, 260),
				source: "observed-by-workbench",
			});
			run.promptActive = true;
			const result = await run.client.request("session/prompt", {
				sessionId: run.rawSessionId,
				prompt: [{ type: "text", text: prompt }],
			}, this.#promptTimeoutMs);
			run.promptActive = false;
			if (run.settling) return;
			const projected = validatePromptResult(result);
			const incomplete = [...run.tools.values()].filter((tool) => !tool.terminal);
			for (const tool of incomplete) {
				tool.terminal = true;
				run.owner.emit({
					type: "turn.tool",
					context: run.context,
					toolCallId: tool.publicId,
					title: safeToolTitle(tool.kind),
					kind: tool.kind,
					status: "failed",
					summary: "Clio ended before reporting a terminal tool status.",
					locations: tool.locations,
					source: "observed-by-workbench",
				});
			}
			if (incomplete.length > 0) {
				await this.#finishReal(run, {
					outcome: "failed",
					code: "incomplete-tool-lifecycle",
					summary: "Clio ended with an incomplete tool lifecycle.",
					stopReason: projected.stopReason,
					usage: projected.usage,
					source: "observed-by-workbench",
				});
				return;
			}
			if (projected.stopReason === "end_turn") {
				this.#flushRealText(run);
				if (!run.hasSubstantiveActivity) {
					await this.#finishReal(run, {
						outcome: "failed",
						code: "empty-turn",
						summary: "Clio returned an empty turn without substantive projected ACP activity.",
						stopReason: projected.stopReason,
						usage: projected.usage,
						source: "observed-on-acp",
					});
					return;
				}
			}
			const completed = projected.stopReason === "end_turn";
			const cancelled = projected.stopReason === "cancelled";
			await this.#finishReal(run, {
				outcome: completed ? "completed" : cancelled ? "canceled" : "failed",
				code: completed ? "clio-completed" : cancelled ? "clio-cancelled" : `clio-${projected.stopReason}`,
				summary: completed
					? "Clio completed the bounded ACP turn."
					: cancelled
					? "Clio reported that the bounded turn was canceled."
					: `Clio stopped the bounded turn with ${projected.stopReason.replaceAll("_", " ")}.`,
				stopReason: projected.stopReason,
				usage: projected.usage,
				source: "reported-by-clio",
			});
		} catch (error) {
			const promptTimedOut = error instanceof AcpTimeoutError && error.method === "session/prompt";
			if (!promptTimedOut) run.promptActive = false;
			if (!run.settling) {
				const terminal = failureProjection(error, run.transportFailure);
				await this.#finishReal(
					run,
					promptTimedOut ? { ...terminal, cancelActive: true } : terminal,
				);
			}
		}
	}

	#handleRealUpdate(run: RealRun, generation: string, update: ValidatedAcpUpdate): void {
		if (this.#active !== run || generation !== run.context.generation) {
			throw new EngineError("internal", "A stale Clio update crossed its engine generation.");
		}
		if (run.rawSessionId === null || update.sessionId !== run.rawSessionId || !run.promptActive) {
			throw new EngineError("internal", "A Clio update crossed its bounded session turn.");
		}
		if (run.projectionClosed) return;
		if (run.updateCount >= MAX_ACP_UPDATES_PER_TURN) {
			this.#closeRealProjectionForBudget(
				run,
				"workbench-update-budget-exceeded",
				"Workbench stopped projecting Clio updates after the bounded update budget was exceeded.",
			);
			return;
		}
		run.updateCount += 1;
		if (update.type !== "tool") {
			const nextStreamBytes = run.streamBytes + bytes(update.text);
			if (nextStreamBytes > MAX_CUMULATIVE_STREAM_BYTES) {
				this.#closeRealProjectionForBudget(
					run,
					"workbench-stream-budget-exceeded",
					"Workbench stopped projecting Clio text after the bounded stream budget was exceeded.",
				);
				return;
			}
			run.streamBytes = nextStreamBytes;
			if (update.text.length > 0) this.#emitRealText(run, update.type, update.text);
			return;
		}
		this.#flushRealText(run);
		const locations = projectLocations(run.project.trustedRoot, update.locations);
		let tool = run.tools.get(update.toolCallId);
		if (tool === undefined) {
			if (
				update.variant !== "start" || run.tools.size >= MAX_TOOLS_PER_TURN || update.status === "completed" ||
				update.status === "failed"
			) {
				throw new EngineError("internal", "Clio emitted an invalid tool lifecycle.");
			}
			run.toolCounter += 1;
			tool = {
				publicId: `tool-clio-${run.toolCounter}`,
				rawTitle: update.title,
				kind: boundedString(update.kind, "Clio tool kind", MAX_TOOL_KIND_BYTES),
				locations,
				terminal: false,
			};
			run.tools.set(update.toolCallId, tool);
		} else if (
			update.variant !== "update" || tool.terminal || tool.rawTitle !== update.title || tool.kind !== update.kind ||
			!sameLocations(tool.locations, locations)
		) throw new EngineError("internal", "Clio changed or replayed a bounded tool identity.");
		const terminal = update.status === "completed" || update.status === "failed";
		if (terminal) tool.terminal = true;
		run.hasSubstantiveActivity = true;
		run.owner.emit({
			type: "turn.tool",
			context: run.context,
			toolCallId: tool.publicId,
			title: safeToolTitle(tool.kind),
			kind: tool.kind,
			status: update.status === "pending" ? "in_progress" : update.status,
			summary: terminal ? "Clio reported a terminal tool status." : "Clio reported bounded tool activity.",
			locations: tool.locations,
			source: "observed-on-acp",
		});
	}

	#closeRealProjectionForBudget(run: RealRun, code: string, summary: string): void {
		if (run.projectionClosed) return;
		run.projectionClosed = true;
		void this.#finishReal(run, {
			outcome: "failed",
			code,
			summary,
			source: "observed-by-workbench",
			cancelActive: true,
		}).catch(() => undefined);
	}

	#handleRealPermission(run: RealRun, generation: string, request: AcpPermissionRequest): void {
		if (
			this.#active !== run || generation !== run.context.generation || !run.promptActive ||
			run.rawSessionId === null || request.sessionId !== run.rawSessionId || run.permission !== null
		) throw new EngineError("internal", "A stale or concurrent Clio permission crossed its turn boundary.");
		const tool = run.tools.get(request.toolCallId);
		if (tool === undefined || tool.terminal || tool.rawTitle !== request.title || tool.kind !== request.kind) {
			throw new EngineError("internal", "Clio requested permission for an unknown tool identity.");
		}
		const locations = projectLocations(run.project.trustedRoot, request.locations);
		if (!sameLocations(tool.locations, locations)) {
			throw new EngineError("internal", "Clio changed a tool location at the permission boundary.");
		}
		if (run.cancelRequested) {
			void request.resolve("cancelled").catch(() =>
				this.#finishReal(run, {
					outcome: "failed",
					code: "permission-settlement-failed",
					summary: "Workbench could not reject a late Clio permission during cancellation.",
					source: "observed-by-workbench",
					cancelActive: true,
				})
			).catch(() => undefined);
			return;
		}
		if (run.settling) throw new EngineError("internal", "A stale Clio permission crossed its turn boundary.");
		const publicId = `permission-clio-${crypto.randomUUID()}`;
		const waitMs = Math.max(0, request.expiresAt - this.#now());
		const timer = setTimeout(() => {
			if (this.#active === run && run.permission?.publicId === publicId) {
				void this.#settleRealPermission(run, "timeout", "reject_once")
					.then(() => this.#resumeRealAfterPermission(run))
					.catch(() =>
						this.#finishReal(run, {
							outcome: "failed",
							code: "permission-settlement-failed",
							summary: "Workbench could not settle the expired Clio permission request.",
							source: "observed-by-workbench",
							cancelActive: true,
						})
					)
					.catch(() => undefined);
			}
		}, waitMs);
		run.permission = { publicId, request, expiresAt: request.expiresAt, timer };
		this.#setRunPhase(run, "awaiting-approval");
		run.owner.emit({
			type: "turn.permission.requested",
			context: run.context,
			permissionId: publicId,
			toolCallId: tool.publicId,
			title: safeToolTitle(tool.kind),
			kind: tool.kind,
			locations: tool.locations,
			expiresAt: new Date(request.expiresAt).toISOString(),
			source: "observed-on-acp",
		});
	}

	async #settleRealPermission(
		run: RealRun,
		publicDecision: "allow_once" | "reject_once" | "cancelled" | "timeout" | "disconnect",
		wireDecision: "allow_once" | "reject_once" | "cancelled",
	): Promise<boolean> {
		const permission = run.permission;
		if (permission === null) throw new EngineError("not-found", "That Clio permission is no longer active.");
		const expiredOperatorDecision = (publicDecision === "allow_once" || publicDecision === "reject_once") &&
			this.#now() >= permission.expiresAt;
		run.permission = null;
		clearTimeout(permission.timer);
		await permission.request.resolve(expiredOperatorDecision ? "reject_once" : wireDecision);
		run.owner.emit({
			type: "turn.permission.resolved",
			context: run.context,
			permissionId: permission.publicId,
			decision: expiredOperatorDecision ? "timeout" : publicDecision,
			source: "observed-by-workbench",
		});
		return expiredOperatorDecision;
	}

	async #finishReal(run: RealRun, terminal: TerminalProjection): Promise<void> {
		if (run.settling || this.#active !== run) return;
		const cancelActive = terminal.cancelActive ?? run.promptActive;
		if (cancelActive) run.cancelRequested = true;
		run.settling = true;
		let retirementFailed = false;
		let finalizationFailed = false;
		try {
			try {
				this.#flushRealText(run);
			} catch {
				finalizationFailed = true;
			}
			if (run.permission !== null) {
				try {
					await this.#settleRealPermission(run, "cancelled", "cancelled");
				} catch {
					finalizationFailed = true;
				}
			}
			try {
				const retirement = await run.client.retire({
					sessionId: run.rawSessionId ?? undefined,
					supportsClose: run.supportsClose,
					cancelActive,
				});
				retirementFailed = !retirement.exited;
			} catch {
				retirementFailed = true;
			}
			// Retirement may legitimately project the owned prompt's final cancellation
			// sweep before that prompt settles. Release any remaining safe text before
			// publishing the one terminal event.
			try {
				this.#flushRealText(run);
			} catch {
				finalizationFailed = true;
			}

			type TerminalMode = "original" | "termination-failure" | "finalization-failure";
			const emitTerminal = (mode: TerminalMode): void =>
				run.owner.emit({
					type: "turn.terminal",
					context: run.context,
					outcome: mode === "original" ? terminal.outcome : "failed",
					code: mode === "termination-failure"
						? "termination-failure"
						: mode === "finalization-failure"
						? "workbench-finalization-failure"
						: terminal.code,
					summary: mode === "termination-failure"
						? "The owned Clio process did not exit within its cleanup bound."
						: mode === "finalization-failure"
						? "Workbench could not finalize the bounded turn projection safely."
						: terminal.summary,
					...(terminal.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
					...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
					source: mode === "original" ? terminal.source : "observed-by-workbench",
				});
			const initialMode: TerminalMode = retirementFailed
				? "termination-failure"
				: finalizationFailed
				? "finalization-failure"
				: "original";
			try {
				emitTerminal(initialMode);
			} catch {
				finalizationFailed = true;
				try {
					emitTerminal("finalization-failure");
				} catch {
					// Final ownership release below must not depend on a failing sink.
				}
			}

			try {
				const prior = this.#projectState(run.project.projectId).snapshot;
				const phase: EnginePhase = retirementFailed || finalizationFailed || terminal.outcome === "failed"
					? "failed"
					: "ready";
				const snapshot = safeSnapshot("clio-acp", phase, prior.facts, prior.checkedAt);
				this.#projects.set(run.project.projectId, { snapshot, trustedRoot: run.project.trustedRoot });
				try {
					run.owner.emit({ type: "engine.state", projectId: run.project.projectId, snapshot });
				} catch {
					// The coordinator state remains authoritative if its sink has failed.
				}
			} catch {
				// Ownership release below is the final fail-safe boundary.
			}
		} finally {
			if (this.#active === run) this.#active = null;
			run.resolveDone();
			this.#refreshProjectBestEffort(run);
		}
	}

	#emitRealText(run: RealRun, type: "message" | "thought", text: string): void {
		if (run.streamTailType !== null && run.streamTailType !== type) this.#flushRealText(run);
		run.streamTailType = type;
		const projected = consumeProjectRedaction(run.streamTail + text, run.project.trustedRoot, false);
		run.streamTail = projected.remainder;
		if (projected.text.length === 0) return;
		if (type === "message" && projected.text.trim().length > 0) run.hasSubstantiveActivity = true;
		run.owner.emit({
			type: type === "message" ? "turn.text" : "turn.thought",
			context: run.context,
			text: projected.text,
			source: "observed-on-acp",
		});
	}

	#flushRealText(run: RealRun): void {
		if (run.streamTailType === null) return;
		const type = run.streamTailType;
		const projected = consumeProjectRedaction(run.streamTail, run.project.trustedRoot, true);
		run.streamTail = projected.remainder;
		run.streamTailType = null;
		if (projected.text.length === 0) return;
		if (type === "message" && projected.text.trim().length > 0) run.hasSubstantiveActivity = true;
		run.owner.emit({
			type: type === "message" ? "turn.text" : "turn.thought",
			context: run.context,
			text: projected.text,
			source: "observed-on-acp",
		});
	}

	#setRunPhase(run: ActiveRun, phase: EnginePhase): void {
		if (this.#active !== run || run.settling) return;
		const current = this.#projectState(run.project.projectId);
		const snapshot = safeSnapshot(current.snapshot.kind, phase, current.snapshot.facts, current.snapshot.checkedAt);
		this.#projects.set(run.project.projectId, { snapshot, trustedRoot: current.trustedRoot });
		run.owner.emit({ type: "engine.state", projectId: run.project.projectId, snapshot });
	}

	#resumeRealAfterPermission(run: RealRun): void {
		if (!run.cancelRequested && run.permission === null) this.#setRunPhase(run, "running");
	}

	#refreshProjectBestEffort(run: ActiveRun): void {
		try {
			void run.owner.refreshProject(run.project.projectId).catch(() => undefined);
		} catch {
			// Project refresh is presentation-only and cannot hold lifecycle cleanup open.
		}
	}
}
