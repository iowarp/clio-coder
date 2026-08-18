import { isAbsolute } from "node:path";

export const ACP_PROTOCOL_VERSION = 1 as const;
export const ACP_MAX_FRAME_BYTES = 256 * 1024;
export const ACP_MAX_OUTBOUND_BYTES = 16 * 1024;
export const ACP_MAX_PENDING_REQUESTS = 16;
export const ACP_MAX_ID_BYTES = 128;
export const ACP_MAX_STDERR_TAIL_BYTES = 16 * 1024;

const ACP_MAX_METHOD_BYTES = 128;
const ACP_MAX_TITLE_BYTES = 512;
const ACP_MAX_PATH_BYTES = 4 * 1024;
const ACP_MAX_DELTA_BYTES = 16 * 1024;
const ACP_MAX_ERROR_MESSAGE_BYTES = 256;
const ACP_MAX_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

const TOOL_KINDS = [
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
] as const;
const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
const TOOL_STATUS_RANK: Readonly<Record<AcpToolStatus, number>> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
	failed: 2,
};
const OUTBOUND_REQUEST_METHODS = new Set([
	"initialize",
	"session/new",
	"session/prompt",
	"session/cancel",
	"session/close",
]);

export type AcpToolKind = (typeof TOOL_KINDS)[number];
export type AcpToolStatus = (typeof TOOL_STATUSES)[number];
export type AcpRequestId = number | string;
export type AcpTerminationScope = "posix-process-group" | "direct-child";

export interface AcpLaunchSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly clearEnv?: boolean;
	readonly terminationScope: AcpTerminationScope;
	readonly redact?: readonly string[];
}

export interface AcpRemoteErrorMeta {
	readonly version: 1;
	readonly code: string;
	readonly reason?: string;
	readonly supported?: readonly number[];
}

export type ValidatedAcpUpdate =
	| Readonly<{
		type: "message" | "thought";
		sessionId: string;
		text: string;
	}>
	| Readonly<{
		type: "tool";
		variant: "start" | "update";
		sessionId: string;
		toolCallId: string;
		title: string;
		kind: AcpToolKind;
		status: AcpToolStatus;
		locations: readonly string[];
	}>;

type ParsedAcpUpdate =
	| Readonly<{
		type: "message" | "thought";
		sessionId: string;
		text: string;
	}>
	| Readonly<{
		type: "tool";
		variant: "start" | "update";
		sessionId: string;
		toolCallId: string;
		title?: string;
		kind?: AcpToolKind;
		status: AcpToolStatus;
		locations?: readonly string[];
		rawInputSignature?: string;
	}>;

export type AcpPermissionDecision = "allow_once" | "reject_once" | "cancelled";

export interface AcpPermissionRequest {
	readonly requestId: AcpRequestId;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: AcpToolKind;
	readonly locations: readonly string[];
	readonly expiresAt: number;
	resolve(decision: AcpPermissionDecision): Promise<void>;
}

export type AcpFailureCode =
	| "protocol-failure"
	| "process-exited"
	| "stdio-failure"
	| "write-failure"
	| "termination-failure";

export interface AcpFailure {
	readonly code: AcpFailureCode;
	readonly message: string;
}

export interface AcpClientHooks {
	onUpdate?(generation: string, update: ValidatedAcpUpdate): void;
	onPermission?(generation: string, request: AcpPermissionRequest): void;
	onFailure?(generation: string, failure: AcpFailure): void;
}

export interface AcpClientTiming {
	readonly permissionTimeoutMs?: number;
	readonly writeTimeoutMs?: number;
	readonly cancelGraceMs?: number;
	readonly closeTimeoutMs?: number;
	readonly exitGraceMs?: number;
	readonly termGraceMs?: number;
	readonly killObservationMs?: number;
}

export interface AcpRetireOptions {
	readonly sessionId?: string;
	readonly supportsClose: boolean;
	readonly cancelActive: boolean;
}

export interface AcpRetireResult {
	readonly scope: AcpTerminationScope;
	readonly exited: boolean;
	readonly escalated: boolean;
	readonly promptSettledBeforeClose: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
}

interface ResolvedTiming {
	readonly permissionTimeoutMs: number;
	readonly writeTimeoutMs: number;
	readonly cancelGraceMs: number;
	readonly closeTimeoutMs: number;
	readonly exitGraceMs: number;
	readonly termGraceMs: number;
	readonly killObservationMs: number;
}

interface PendingRequest {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ActivePermission {
	readonly request: AcpPermissionRequest;
	readonly abandon: () => void;
}

interface ObservedTool {
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: AcpToolKind;
	readonly locations: readonly string[];
	readonly rawInputSignature?: string;
	status: AcpToolStatus;
}

export class AcpClientError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AcpClientError";
		this.code = code;
	}
}

export class AcpProtocolError extends AcpClientError {
	constructor(message = "The ACP peer violated the protocol.") {
		super("protocol-failure", message);
		this.name = "AcpProtocolError";
	}
}

export class AcpRemoteError extends AcpClientError {
	readonly rpcCode: number;
	readonly remote: AcpRemoteErrorMeta | null;

	constructor(method: string, rpcCode: number, remote: AcpRemoteErrorMeta | null) {
		super("remote-error", `The ACP peer rejected ${method} (JSON-RPC ${rpcCode}).`);
		this.name = "AcpRemoteError";
		this.rpcCode = rpcCode;
		this.remote = remote;
	}
}

export class AcpTimeoutError extends AcpClientError {
	readonly method: string;

	constructor(method: string) {
		super("request-timeout", `The ACP ${method} request timed out.`);
		this.name = "AcpTimeoutError";
		this.method = method;
	}
}

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function boundedUtf8Tail(value: string, maximumBytes: number): string {
	const characters = Array.from(value);
	let used = 0;
	let start = characters.length;
	while (start > 0) {
		const character = characters[start - 1];
		if (character === undefined) break;
		const size = byteLength(character);
		if (used + size > maximumBytes) break;
		used += size;
		start -= 1;
	}
	return characters.slice(start).join("");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function protocolFailure(message = "The ACP peer violated the protocol."): never {
	throw new AcpProtocolError(message);
}

function boundedString(value: unknown, label: string, maximumBytes: number, allowBlank = false): string {
	if (typeof value !== "string" || (!allowBlank && value.trim().length === 0) || byteLength(value) > maximumBytes) {
		return protocolFailure(`${label} was invalid or exceeded its bound.`);
	}
	return value;
}

function validRequestId(value: unknown): value is AcpRequestId {
	if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
	return typeof value === "string" && value.length > 0 && byteLength(value) <= ACP_MAX_ID_BYTES;
}

function exactEnum<T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
	if (typeof value !== "string" || !choices.includes(value)) return protocolFailure(`${label} was unsupported.`);
	return value as T[number];
}

function validateDuration(value: number, label: string, maximum = ACP_MAX_REQUEST_TIMEOUT_MS): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new AcpClientError("invalid-timeout", `${label} must be an integer from 1 through ${maximum}.`);
	}
	return value;
}

function resolvedTiming(input: AcpClientTiming): ResolvedTiming {
	return {
		permissionTimeoutMs: validateDuration(input.permissionTimeoutMs ?? 120_000, "permissionTimeoutMs", 300_000),
		writeTimeoutMs: validateDuration(input.writeTimeoutMs ?? 3_000, "writeTimeoutMs", 30_000),
		cancelGraceMs: validateDuration(input.cancelGraceMs ?? 5_000, "cancelGraceMs", 30_000),
		closeTimeoutMs: validateDuration(input.closeTimeoutMs ?? 3_000, "closeTimeoutMs", 30_000),
		exitGraceMs: validateDuration(input.exitGraceMs ?? 1_000, "exitGraceMs", 30_000),
		termGraceMs: validateDuration(input.termGraceMs ?? 500, "termGraceMs", 30_000),
		killObservationMs: validateDuration(input.killObservationMs ?? 2_000, "killObservationMs", 30_000),
	};
}

function clientPermissionWait(milliseconds: number): number {
	const margin = Math.min(1_000, Math.max(1, Math.floor(milliseconds / 10)));
	return Math.max(1, milliseconds - margin);
}

function validateArgument(value: string, label: string, maximumBytes = 4 * 1024): string {
	if (value.length === 0 || value.includes("\0") || byteLength(value) > maximumBytes) {
		throw new AcpClientError("invalid-launch", `${label} is invalid.`);
	}
	return value;
}

function validateExecutable(value: string, label: string): string {
	validateArgument(value, label);
	if (value.includes("/") || value.includes("\\")) {
		if (!isAbsolute(value)) {
			throw new AcpClientError("invalid-launch", `${label} must be absolute when it contains a path.`);
		}
	} else if (!/^[A-Za-z0-9._+-]+$/.test(value)) {
		throw new AcpClientError("invalid-launch", `${label} must be a simple executable name or absolute path.`);
	}
	return value;
}

function validatePermissionTimeout(value: number): number {
	return validateDuration(value, "permissionTimeoutMs", 300_000);
}

export function localAcpLaunch(
	executable: string,
	trustedRoot: string,
	permissionTimeoutMs: number,
	prefixArgs: readonly string[] = [],
): AcpLaunchSpec {
	validateExecutable(executable, "executable");
	validateArgument(trustedRoot, "trustedRoot");
	if (!isAbsolute(trustedRoot)) throw new AcpClientError("invalid-launch", "trustedRoot must be absolute.");
	const prefix = prefixArgs.map((argument, index) => validateArgument(argument, `prefixArgs[${index}]`));
	return {
		command: executable,
		args: [
			...prefix,
			"acp",
			"--cwd",
			trustedRoot,
			"--permission-timeout",
			String(validatePermissionTimeout(permissionTimeoutMs)),
		],
		cwd: trustedRoot,
		terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
		redact: [trustedRoot, executable],
	};
}

/**
 * Builds the non-shell argv for a future WSL project-mapping integration. Its
 * `direct-child` scope covers only the launched `wsl.exe` process; it neither
 * proves ownership of Linux descendants nor enables native Windows launch in
 * the Workbench product.
 */
export function wslAcpLaunch(
	wslExecutable: string,
	distro: string,
	linuxExecutable: string,
	linuxRoot: string,
	permissionTimeoutMs: number,
): AcpLaunchSpec {
	validateExecutable(wslExecutable, "wslExecutable");
	validateArgument(distro, "distro", 128);
	if (!/^[A-Za-z0-9._-]+$/.test(distro)) throw new AcpClientError("invalid-launch", "distro was invalid.");
	validateArgument(linuxExecutable, "linuxExecutable");
	validateArgument(linuxRoot, "linuxRoot");
	if (!linuxExecutable.startsWith("/") || !linuxRoot.startsWith("/")) {
		throw new AcpClientError("invalid-launch", "WSL executable and project root must be absolute Linux paths.");
	}
	return {
		command: wslExecutable,
		args: [
			"--distribution",
			distro,
			"--exec",
			linuxExecutable,
			"acp",
			"--cwd",
			linuxRoot,
			"--permission-timeout",
			String(validatePermissionTimeout(permissionTimeoutMs)),
		],
		terminationScope: "direct-child",
		redact: [linuxRoot, linuxExecutable],
	};
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return Uint8Array.from(right);
	if (right.byteLength === 0) return Uint8Array.from(left);
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

export class AcpLineFramer {
	readonly #maximumBytes: number;
	#remainder: Uint8Array = new Uint8Array(0);

	constructor(maximumBytes = ACP_MAX_FRAME_BYTES) {
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > ACP_MAX_FRAME_BYTES) {
			throw new AcpClientError("invalid-frame-bound", "ACP frame bound was invalid.");
		}
		this.#maximumBytes = maximumBytes;
	}

	push(chunk: Uint8Array): readonly Uint8Array[] {
		const frames: Uint8Array[] = [];
		let start = 0;
		for (let index = 0; index < chunk.byteLength; index += 1) {
			if (chunk[index] !== 0x0a) continue;
			const fragment = chunk.subarray(start, index);
			if (this.#remainder.byteLength + fragment.byteLength > this.#maximumBytes) {
				return protocolFailure("An ACP stdout frame exceeded 256 KiB.");
			}
			frames.push(concatBytes(this.#remainder, fragment));
			this.#remainder = new Uint8Array(0);
			start = index + 1;
		}
		const tail = chunk.subarray(start);
		if (this.#remainder.byteLength + tail.byteLength > this.#maximumBytes) {
			return protocolFailure("The partial ACP stdout frame exceeded 256 KiB.");
		}
		this.#remainder = concatBytes(this.#remainder, tail);
		return frames;
	}

	finish(): void {
		if (this.#remainder.byteLength === 0) return;
		let text: string;
		try {
			text = fatalDecoder.decode(this.#remainder);
		} catch {
			return protocolFailure("ACP stdout ended with invalid UTF-8.");
		}
		this.#remainder = new Uint8Array(0);
		if (text.trim().length !== 0) protocolFailure("ACP stdout ended with a partial frame.");
	}
}

function decodeFrame(frame: Uint8Array): string | null {
	let bytes = frame;
	if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d) bytes = bytes.subarray(0, -1);
	let text: string;
	try {
		text = fatalDecoder.decode(bytes);
	} catch {
		return protocolFailure("An ACP stdout frame was not valid UTF-8.");
	}
	return text.trim().length === 0 ? null : text;
}

function validateLocations(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 32) return protocolFailure("ACP tool locations were invalid.");
	return value.map((item) => {
		if (!isPlainRecord(item)) return protocolFailure("An ACP tool location was invalid.");
		return boundedString(item.path, "ACP tool location path", ACP_MAX_PATH_BYTES);
	});
}

function rawInputSignature(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) return protocolFailure("ACP tool rawInput was not a bounded record.");
	validateRawInputValue(value, 0);
	const serialized = JSON.stringify(value);
	if (byteLength(serialized) > 32 * 1024) return protocolFailure("ACP tool rawInput exceeded its bounded record size.");
	return serialized;
}

function validateRawInputValue(value: unknown, depth: number): void {
	if (typeof value === "string") {
		if (byteLength(value) > 4 * 1024) protocolFailure("ACP tool rawInput contained an oversized string.");
		return;
	}
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		// JSON.parse accepts exponent forms that overflow to Infinity, while
		// JSON.stringify rewrites every non-finite number to null. It also rewrites
		// negative zero to zero. Either rewrite would make two different permission
		// payloads share one signature, so reject those non-injective cases before
		// binding an approval to the announced tool call.
		if (!Number.isFinite(value) || Object.is(value, -0)) {
			protocolFailure("ACP tool rawInput contained a non-canonical number.");
		}
		return;
	}
	if (depth >= 8) protocolFailure("ACP tool rawInput exceeded its depth bound.");
	if (Array.isArray(value)) {
		for (const item of value) validateRawInputValue(item, depth + 1);
		return;
	}
	if (isPlainRecord(value)) {
		for (const item of Object.values(value)) validateRawInputValue(item, depth + 1);
		return;
	}
	protocolFailure("ACP tool rawInput contained an unsupported value.");
}

function validateUpdate(paramsValue: unknown): ParsedAcpUpdate {
	if (!isPlainRecord(paramsValue) || !isPlainRecord(paramsValue.update)) {
		return protocolFailure("session/update params were invalid.");
	}
	const sessionId = boundedString(paramsValue.sessionId, "session/update sessionId", ACP_MAX_ID_BYTES);
	const update = paramsValue.update;
	const updateKind = boundedString(update.sessionUpdate, "sessionUpdate", 64);
	if (updateKind === "agent_message_chunk" || updateKind === "agent_thought_chunk") {
		if (!isPlainRecord(update.content) || update.content.type !== "text") {
			return protocolFailure("An ACP text update had invalid content.");
		}
		return {
			type: updateKind === "agent_message_chunk" ? "message" : "thought",
			sessionId,
			text: boundedString(update.content.text, "ACP text delta", ACP_MAX_DELTA_BYTES, true),
		};
	}
	if (updateKind !== "tool_call" && updateKind !== "tool_call_update") {
		return protocolFailure("The ACP peer sent an unsupported session/update variant.");
	}
	const title = update.title === undefined
		? undefined
		: boundedString(update.title, "ACP tool title", ACP_MAX_TITLE_BYTES);
	const kind = update.kind === undefined ? undefined : exactEnum(update.kind, TOOL_KINDS, "ACP tool kind");
	if (updateKind === "tool_call" && (title === undefined || kind === undefined)) {
		return protocolFailure("An ACP tool start omitted its bounded identity fields.");
	}
	return {
		type: "tool",
		variant: updateKind === "tool_call" ? "start" : "update",
		sessionId,
		toolCallId: boundedString(update.toolCallId, "ACP toolCallId", ACP_MAX_ID_BYTES),
		...(title === undefined ? {} : { title }),
		...(kind === undefined ? {} : { kind }),
		status: exactEnum(update.status, TOOL_STATUSES, "ACP tool status"),
		...(update.locations === undefined ? {} : { locations: validateLocations(update.locations) }),
		...(update.rawInput === undefined ? {} : { rawInputSignature: rawInputSignature(update.rawInput) }),
	};
}

function toolKey(sessionId: string, toolCallId: string): string {
	return JSON.stringify([sessionId, toolCallId]);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateOptions(
	value: unknown,
): Readonly<{ allow: "allow-once"; reject: "reject-once" }> {
	if (!Array.isArray(value) || value.length !== 2) {
		return protocolFailure("ACP permission options were invalid.");
	}
	let allow = false;
	let reject = false;
	for (const item of value) {
		if (!isPlainRecord(item)) return protocolFailure("An ACP permission option was invalid.");
		const optionId = boundedString(item.optionId, "ACP permission optionId", ACP_MAX_ID_BYTES);
		if (optionId === "allow-once") {
			if (allow) return protocolFailure("ACP permission supplied a duplicate allow-once optionId.");
			allow = true;
		} else if (optionId === "reject-once") {
			if (reject) return protocolFailure("ACP permission supplied a duplicate reject-once optionId.");
			reject = true;
		} else return protocolFailure("ACP permission supplied an unsupported optionId.");
	}
	if (!allow || !reject) return protocolFailure("ACP permission lacked required one-shot optionIds.");
	return { allow: "allow-once", reject: "reject-once" };
}

function validateRemoteMeta(errorValue: Record<string, unknown>): AcpRemoteErrorMeta | null {
	const data = errorValue.data;
	if (!isPlainRecord(data) || !isPlainRecord(data._meta)) return null;
	const value = data._meta["clio-coder/error"];
	if (!isPlainRecord(value) || value.version !== 1) return null;
	const code = boundedString(value.code, "Clio error code", 64);
	if (!/^[a-z0-9_]+$/.test(code)) return protocolFailure("Clio error code was invalid.");
	let reason: string | undefined;
	if (value.reason !== undefined) {
		reason = boundedString(value.reason, "Clio error reason", 64);
		if (!/^[a-z0-9_-]+$/.test(reason)) return protocolFailure("Clio error reason was invalid.");
	}
	let supported: readonly number[] | undefined;
	if (value.supported !== undefined) {
		if (
			!Array.isArray(value.supported) || value.supported.length > 8 ||
			!value.supported.every((item) => Number.isSafeInteger(item))
		) return protocolFailure("Clio supported-version metadata was invalid.");
		supported = [...value.supported] as number[];
	}
	return {
		version: 1,
		code,
		...(reason === undefined ? {} : { reason }),
		...(supported === undefined ? {} : { supported }),
	};
}

function safeFailure(code: AcpFailureCode): AcpFailure {
	const messages: Readonly<Record<AcpFailureCode, string>> = {
		"protocol-failure": "The Clio ACP connection violated its bounded protocol.",
		"process-exited": "The owned Clio ACP process exited unexpectedly.",
		"stdio-failure": "The owned Clio ACP stdio channel failed.",
		"write-failure": "The owned Clio ACP input channel failed.",
		"termination-failure": "The owned Clio ACP process did not exit within the cleanup bound.",
	};
	return { code, message: messages[code] };
}

function boundedOutcome<T>(
	promise: Promise<T>,
	milliseconds: number,
): Promise<Readonly<{ completed: true; value: T }> | Readonly<{ completed: false }>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<Readonly<{ completed: false }>>((resolve) => {
		timer = setTimeout(() => resolve({ completed: false }), milliseconds);
	});
	return Promise.race([
		promise.then((value) => ({ completed: true as const, value })),
		timeout,
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	return (await boundedOutcome(promise.then(() => undefined, () => undefined), milliseconds)).completed;
}

export class AcpClient {
	readonly generation = `generation-${crypto.randomUUID()}`;
	readonly pid: number;
	readonly scope: AcpTerminationScope;

	readonly #hooks: AcpClientHooks;
	readonly #timing: ResolvedTiming;
	readonly #child: Deno.ChildProcess;
	readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #peerRequestIds = new Set<string>();
	readonly #tools = new Map<string, ObservedTool>();
	readonly #redactions: readonly string[];
	readonly #statusPromise: Promise<Deno.CommandStatus>;
	readonly #stdoutPromise: Promise<void>;
	readonly #stderrPromise: Promise<void>;
	readonly #lifecyclePromise: Promise<void>;
	#nextRequestId = 1;
	#writeTail: Promise<void> = Promise.resolve();
	#stderr: Uint8Array = new Uint8Array(0);
	#failed = false;
	#failureNotified = false;
	#frozen = false;
	#retiring = false;
	#writerClosed = false;
	#exitStatus: Deno.CommandStatus | null = null;
	#promptPromise: Promise<unknown> | null = null;
	#promptMayBeActiveRemotely = false;
	#activePermission: ActivePermission | null = null;
	#cleanupPromise: Promise<AcpRetireResult> | null = null;

	private constructor(spec: AcpLaunchSpec, hooks: AcpClientHooks, timing: AcpClientTiming) {
		validateLaunchSpec(spec);
		this.#hooks = hooks;
		this.#timing = resolvedTiming(timing);
		this.scope = spec.terminationScope;
		this.#redactions = [...(spec.redact ?? [])].filter((value) => value.length > 0);
		this.#child = new Deno.Command(spec.command, {
			args: [...spec.args],
			...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
			...(spec.env === undefined ? {} : { env: { ...spec.env } }),
			...(spec.clearEnv === undefined ? {} : { clearEnv: spec.clearEnv }),
			stdin: "piped",
			stdout: "piped",
			stderr: "piped",
			detached: spec.terminationScope === "posix-process-group",
		}).spawn();
		this.pid = this.#child.pid;
		this.#writer = this.#child.stdin.getWriter();
		this.#statusPromise = this.#child.status.then((status) => {
			this.#exitStatus = status;
			return status;
		});
		this.#stdoutPromise = this.#pumpStdout();
		this.#stderrPromise = this.#pumpStderr();
		this.#lifecyclePromise = Promise.all([
			this.#statusPromise,
			this.#stdoutPromise.catch(() => undefined),
			this.#stderrPromise.catch(() => undefined),
		]).then(() => undefined);
		void this.#statusPromise.then(async () => {
			await Promise.allSettled([this.#stdoutPromise, this.#stderrPromise]);
			if (!this.#retiring && !this.#failed) this.#fatal("process-exited");
		});
	}

	static spawn(spec: AcpLaunchSpec, hooks: AcpClientHooks = {}, timing: AcpClientTiming = {}): AcpClient {
		return new AcpClient(spec, hooks, timing);
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.#frozen || this.#failed) {
			return Promise.reject(new AcpClientError("client-closed", "The ACP child is closing."));
		}
		return this.#request(method, params, timeoutMs, false);
	}

	notify(method: "session/cancel", params: unknown): Promise<void> {
		if (this.#frozen || this.#failed) {
			return Promise.reject(new AcpClientError("client-closed", "The ACP child is closing."));
		}
		return this.#notify(method, params, false);
	}

	stderrTail(): string {
		let text = new TextDecoder().decode(this.#stderr);
		for (const secret of this.#redactions) text = text.replaceAll(secret, "[redacted]");
		text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
		text = text.replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]");
		return boundedUtf8Tail(text, ACP_MAX_STDERR_TAIL_BYTES);
	}

	retire(options: AcpRetireOptions): Promise<AcpRetireResult> {
		if (this.#cleanupPromise !== null) return this.#cleanupPromise;
		this.#cleanupPromise = this.#retireGracefully(options);
		return this.#cleanupPromise;
	}

	async #request(methodValue: string, params: unknown, timeoutMs: number, internal: boolean): Promise<unknown> {
		const method = boundedLocalMethod(methodValue);
		if (!OUTBOUND_REQUEST_METHODS.has(method)) {
			throw new AcpClientError("unsupported-method", `Unsupported ACP request method: ${method}`);
		}
		validateDuration(timeoutMs, `${method} timeout`);
		if (!internal && (this.#frozen || this.#failed)) {
			throw new AcpClientError("client-closed", "The ACP child is closing.");
		}
		if (this.#pending.size >= ACP_MAX_PENDING_REQUESTS) {
			throw new AcpClientError("pending-limit", "The ACP pending request limit is 16.");
		}
		if (!Number.isSafeInteger(this.#nextRequestId) || this.#nextRequestId < 1) {
			this.#fatal("protocol-failure");
			throw new AcpClientError("request-id-exhausted", "ACP request IDs were exhausted.");
		}
		const id = this.#nextRequestId;
		this.#nextRequestId += 1;
		let resolveResponse!: (value: unknown) => void;
		let rejectResponse!: (error: Error) => void;
		const response = new Promise<unknown>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (pending === undefined) return;
			this.#pending.delete(id);
			pending.reject(new AcpTimeoutError(method));
		}, timeoutMs);
		this.#pending.set(id, { method, resolve: resolveResponse, reject: rejectResponse, timer });
		void this.#writeMessage({ jsonrpc: "2.0", id, method, params }, internal).catch(() => {
			const pending = this.#pending.get(id);
			if (pending !== undefined) {
				this.#pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(new AcpClientError("write-failure", "The ACP request could not be written."));
			}
			this.#fatal("write-failure");
		});
		const tracked = response.finally(() => {
			if (method === "session/prompt" && this.#promptPromise === tracked) this.#promptPromise = null;
		});
		if (method === "session/prompt") {
			this.#promptMayBeActiveRemotely = true;
			this.#promptPromise = tracked;
		}
		return await tracked;
	}

	async #notify(method: string, params: unknown, internal: boolean): Promise<void> {
		if (method !== "session/cancel") throw new AcpClientError("unsupported-method", "Unsupported ACP notification.");
		if (!internal && (this.#frozen || this.#failed)) {
			throw new AcpClientError("client-closed", "The ACP child is closing.");
		}
		await this.#writeMessage({ jsonrpc: "2.0", method, params }, internal);
	}

	#writeMessage(value: unknown, internal: boolean): Promise<void> {
		if ((!internal && this.#frozen) || this.#writerClosed) {
			return Promise.reject(new AcpClientError("client-closed", "The ACP input stream is closed."));
		}
		let json: string;
		try {
			json = `${JSON.stringify(value)}\n`;
		} catch {
			return Promise.reject(new AcpClientError("invalid-outbound", "The ACP outbound message was not serializable."));
		}
		const bytes = encoder.encode(json);
		if (bytes.byteLength > ACP_MAX_OUTBOUND_BYTES) {
			return Promise.reject(new AcpClientError("outbound-too-large", "The ACP outbound message exceeded 16 KiB."));
		}
		const write = this.#writeTail.then(async () => {
			const outcome = await boundedOutcome(this.#writer.write(bytes), this.#timing.writeTimeoutMs);
			if (!outcome.completed) throw new AcpTimeoutError("stdin write");
		});
		this.#writeTail = write.catch(() => undefined);
		return write;
	}

	async #pumpStdout(): Promise<void> {
		const framer = new AcpLineFramer();
		const reader = this.#child.stdout.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (this.#failed) continue;
				for (const frame of framer.push(value)) {
					const text = decodeFrame(frame);
					if (text !== null) await this.#consumeFrame(text);
				}
			}
			framer.finish();
			if (!this.#retiring && !this.#failed) this.#fatal("process-exited");
		} catch (error) {
			if (!this.#failed) this.#fatal(error instanceof AcpProtocolError ? "protocol-failure" : "stdio-failure");
		} finally {
			reader.releaseLock();
		}
	}

	async #pumpStderr(): Promise<void> {
		const reader = this.#child.stderr.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#stderr = concatBytes(this.#stderr, value).subarray(
					Math.max(0, this.#stderr.byteLength + value.byteLength - ACP_MAX_STDERR_TAIL_BYTES),
				);
			}
		} catch {
			if (!this.#failed) this.#fatal("stdio-failure");
		} finally {
			reader.releaseLock();
		}
	}

	async #consumeFrame(frame: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame);
		} catch {
			return protocolFailure("An ACP stdout frame was not valid JSON.");
		}
		if (!isPlainRecord(parsed) || parsed.jsonrpc !== "2.0") {
			return protocolFailure("An ACP stdout frame was not JSON-RPC 2.0.");
		}
		const hasMethod = Object.hasOwn(parsed, "method");
		const hasId = Object.hasOwn(parsed, "id");
		const hasResult = Object.hasOwn(parsed, "result");
		const hasError = Object.hasOwn(parsed, "error");
		if (hasMethod) {
			if (hasResult || hasError) return protocolFailure("An ACP method frame mixed incompatible shapes.");
			const method = boundedString(parsed.method, "ACP method", ACP_MAX_METHOD_BYTES);
			if (hasId) await this.#consumeIncomingRequest(method, parsed.id, parsed.params);
			else this.#consumeNotification(method, parsed.params);
			return;
		}
		if (!hasId || hasResult === hasError) return protocolFailure("An ACP response shape was invalid.");
		if (!Number.isSafeInteger(parsed.id) || (parsed.id as number) < 1) {
			return protocolFailure("An ACP response id did not match the host request namespace.");
		}
		const id = parsed.id as number;
		const pending = this.#pending.get(id);
		if (pending === undefined) return protocolFailure("The ACP peer sent an unknown, duplicate, or late response id.");
		if (hasResult) {
			this.#pending.delete(id);
			clearTimeout(pending.timer);
			if (pending.method === "session/prompt") this.#promptMayBeActiveRemotely = false;
			pending.resolve(parsed.result);
			return;
		}
		if (!isPlainRecord(parsed.error) || !Number.isSafeInteger(parsed.error.code)) {
			return protocolFailure("An ACP JSON-RPC error shape was invalid.");
		}
		boundedString(parsed.error.message, "ACP error message", ACP_MAX_ERROR_MESSAGE_BYTES, true);
		const remote = validateRemoteMeta(parsed.error);
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.method === "session/prompt") this.#promptMayBeActiveRemotely = false;
		pending.reject(new AcpRemoteError(pending.method, parsed.error.code as number, remote));
	}

	#consumeNotification(method: string, params: unknown): void {
		if (method !== "session/update") return protocolFailure("The ACP peer sent an unsupported notification.");
		const update = this.#validateToolLifecycle(validateUpdate(params));
		try {
			this.#hooks.onUpdate?.(this.generation, update);
		} catch {
			protocolFailure("The ACP update callback failed closed.");
		}
	}

	#validateToolLifecycle(update: ParsedAcpUpdate): ValidatedAcpUpdate {
		if (update.type !== "tool") return update;
		const key = toolKey(update.sessionId, update.toolCallId);
		const observed = this.#tools.get(key);
		if (update.variant === "start") {
			if (
				observed !== undefined || this.#tools.size >= 128 || update.status === "completed" ||
				update.status === "failed"
			) return protocolFailure("The ACP peer emitted an invalid tool start lifecycle.");
			if (update.title === undefined || update.kind === undefined) {
				return protocolFailure("The ACP peer emitted a tool start without a bounded identity.");
			}
			const locations = update.locations ?? [];
			this.#tools.set(key, {
				sessionId: update.sessionId,
				toolCallId: update.toolCallId,
				title: update.title,
				kind: update.kind,
				locations,
				...(update.rawInputSignature === undefined ? {} : { rawInputSignature: update.rawInputSignature }),
				status: update.status,
			});
			return {
				type: "tool",
				variant: "start",
				sessionId: update.sessionId,
				toolCallId: update.toolCallId,
				title: update.title,
				kind: update.kind,
				status: update.status,
				locations,
			};
		}
		if (
			observed === undefined || observed.status === "completed" || observed.status === "failed" ||
			TOOL_STATUS_RANK[update.status] < TOOL_STATUS_RANK[observed.status] ||
			(update.title !== undefined && observed.title !== update.title) ||
			(update.kind !== undefined && observed.kind !== update.kind) ||
			(update.locations !== undefined && !sameStringList(observed.locations, update.locations))
		) return protocolFailure("The ACP peer emitted an unknown, changed, or replayed tool update.");
		observed.status = update.status;
		return {
			type: "tool",
			variant: "update",
			sessionId: update.sessionId,
			toolCallId: update.toolCallId,
			title: observed.title,
			kind: observed.kind,
			status: update.status,
			locations: observed.locations,
		};
	}

	async #consumeIncomingRequest(method: string, id: unknown, params: unknown): Promise<void> {
		if (!validRequestId(id)) return protocolFailure("The ACP peer sent an invalid request id.");
		const peerKey = `${typeof id}:${String(id)}`;
		if (this.#peerRequestIds.has(peerKey)) return protocolFailure("The ACP peer replayed a request id.");
		if (this.#peerRequestIds.size >= 128) return protocolFailure("The ACP peer exceeded its request-id bound.");
		this.#peerRequestIds.add(peerKey);
		if (method !== "session/request_permission") {
			await this.#writeMessage({
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: "method not found" },
			}, true);
			return protocolFailure("The ACP peer sent an unsupported request.");
		}
		if (this.#activePermission !== null) return protocolFailure("The ACP peer sent concurrent permission requests.");
		if (!isPlainRecord(params) || !isPlainRecord(params.toolCall)) {
			return protocolFailure("ACP permission params were invalid.");
		}
		const sessionId = boundedString(params.sessionId, "ACP permission sessionId", ACP_MAX_ID_BYTES);
		const toolCall = params.toolCall;
		if (toolCall.sessionUpdate !== "tool_call") {
			return protocolFailure("ACP permission toolCall discriminator was invalid.");
		}
		const toolCallId = boundedString(toolCall.toolCallId, "ACP permission toolCallId", ACP_MAX_ID_BYTES);
		const title = boundedString(toolCall.title, "ACP permission title", ACP_MAX_TITLE_BYTES);
		const kind = exactEnum(toolCall.kind, TOOL_KINDS, "ACP permission tool kind");
		if (toolCall.status !== "pending") return protocolFailure("ACP permission tool status was invalid.");
		const locations = validateLocations(toolCall.locations) ?? [];
		const permissionRawInput = rawInputSignature(toolCall.rawInput);
		const observedTool = this.#tools.get(toolKey(sessionId, toolCallId));
		if (
			observedTool === undefined || observedTool.status === "completed" || observedTool.status === "failed" ||
			observedTool.title !== title ||
			observedTool.kind !== kind ||
			!sameStringList(observedTool.locations, locations) || observedTool.rawInputSignature !== permissionRawInput
		) return protocolFailure("ACP permission did not match an active announced tool call.");
		const options = validateOptions(params.options);
		let settled = false;
		const permissionWaitMs = clientPermissionWait(this.#timing.permissionTimeoutMs);
		const request: AcpPermissionRequest = {
			requestId: id,
			sessionId,
			toolCallId,
			title,
			kind,
			locations,
			expiresAt: Date.now() + permissionWaitMs,
			resolve: async (decision) => {
				if (settled || this.#activePermission?.request !== request) {
					throw new AcpClientError("permission-settled", "That ACP permission request is no longer active.");
				}
				settled = true;
				this.#activePermission = null;
				const outcome = decision === "cancelled" ? { outcome: { outcome: "cancelled" } } : {
					outcome: {
						outcome: "selected",
						optionId: decision === "allow_once" ? options.allow : options.reject,
					},
				};
				await this.#writeMessage({ jsonrpc: "2.0", id, result: outcome }, true);
			},
		};
		const activePermission: ActivePermission = {
			request,
			abandon: () => {
				settled = true;
			},
		};
		this.#activePermission = activePermission;
		if (this.#frozen || this.#retiring) {
			try {
				await request.resolve("cancelled");
			} catch {
				if (this.#activePermission === activePermission) {
					activePermission.abandon();
					this.#activePermission = null;
				}
			}
			return;
		}
		try {
			if (this.#hooks.onPermission === undefined) {
				void request.resolve("reject_once").catch(() => this.#fatal("write-failure"));
			} else this.#hooks.onPermission(this.generation, request);
		} catch {
			return protocolFailure("The ACP permission callback failed closed.");
		}
	}

	#fatal(code: AcpFailureCode): void {
		if (this.#failed) return;
		this.#failed = true;
		this.#frozen = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AcpClientError(code, safeFailure(code).message));
		}
		this.#pending.clear();
		this.#activePermission?.abandon();
		this.#activePermission = null;
		if (!this.#failureNotified) {
			this.#failureNotified = true;
			try {
				this.#hooks.onFailure?.(this.generation, safeFailure(code));
			} catch {
				// A host callback is never allowed to escape the owned cleanup path.
			}
		}
		if (this.#cleanupPromise === null) this.#cleanupPromise = this.#retireForced();
	}

	async #retireGracefully(options: AcpRetireOptions): Promise<AcpRetireResult> {
		this.#frozen = true;
		this.#retiring = true;
		const activePermission = this.#activePermission;
		if (activePermission !== null) {
			try {
				await activePermission.request.resolve("cancelled");
			} catch {
				if (this.#activePermission === activePermission) {
					activePermission.abandon();
					this.#activePermission = null;
				}
			}
		}
		const promptPromise = this.#promptPromise;
		if (options.cancelActive && options.sessionId !== undefined) {
			try {
				await this.#notify("session/cancel", { sessionId: options.sessionId }, true);
			} catch {
				// EOF/termination remains the bounded fallback.
			}
		}
		const promptSettledLocally = promptPromise === null ||
			await settlesWithin(promptPromise, this.#timing.cancelGraceMs);
		const promptSettledBeforeClose = promptSettledLocally && !this.#promptMayBeActiveRemotely;
		if (promptSettledBeforeClose && options.supportsClose && options.sessionId !== undefined && !this.#failed) {
			try {
				await this.#request("session/close", { sessionId: options.sessionId }, this.#timing.closeTimeoutMs, true);
			} catch {
				// Close is best effort after the exact prompt has settled; EOF still follows.
			}
		}
		await this.#closeWriter();
		if (await settlesWithin(this.#lifecyclePromise, this.#timing.exitGraceMs)) {
			const remaining = await this.#retireRemainingOwnedGroup();
			this.#rejectPendingForRetirement();
			return this.#retireResult(remaining.escalated, promptSettledBeforeClose, remaining.exited);
		}
		const exited = await this.#terminateOwnedScope();
		this.#rejectPendingForRetirement();
		return this.#retireResult(true, promptSettledBeforeClose, exited);
	}

	async #retireForced(): Promise<AcpRetireResult> {
		this.#frozen = true;
		this.#retiring = true;
		await this.#closeWriter();
		if (await settlesWithin(this.#lifecyclePromise, this.#timing.exitGraceMs)) {
			const remaining = await this.#retireRemainingOwnedGroup();
			this.#rejectPendingForRetirement();
			return this.#retireResult(remaining.escalated, false, remaining.exited);
		}
		const exited = await this.#terminateOwnedScope();
		this.#rejectPendingForRetirement();
		return this.#retireResult(true, false, exited);
	}

	#rejectPendingForRetirement(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new AcpClientError("client-closed", "The owned Clio ACP process was retired."));
		}
		this.#pending.clear();
	}

	async #closeWriter(): Promise<void> {
		if (this.#writerClosed) return;
		this.#writerClosed = true;
		await this.#writeTail.catch(() => undefined);
		try {
			const closed = await boundedOutcome(this.#writer.close(), this.#timing.writeTimeoutMs);
			if (!closed.completed) await this.#writer.abort();
		} catch {
			try {
				await this.#writer.abort();
			} catch {
				// The child may already have closed its stdin pipe.
			}
		}
	}

	async #terminateOwnedScope(): Promise<boolean> {
		await this.#signal("SIGTERM");
		const leaderExited = await settlesWithin(this.#lifecyclePromise, this.#timing.termGraceMs);
		if (this.scope === "direct-child") {
			if (leaderExited) return true;
			await this.#signal("SIGKILL");
			return await settlesWithin(this.#lifecyclePromise, this.#timing.killObservationMs);
		}
		if (leaderExited && await this.#waitForOwnedGroupExit(this.#timing.termGraceMs)) return true;
		await this.#signal("SIGKILL");
		const [settled, groupExited] = await Promise.all([
			settlesWithin(this.#lifecyclePromise, this.#timing.killObservationMs),
			this.#waitForOwnedGroupExit(this.#timing.killObservationMs),
		]);
		return settled && groupExited;
	}

	async #retireRemainingOwnedGroup(): Promise<Readonly<{ exited: boolean; escalated: boolean }>> {
		if (this.scope === "direct-child") return { exited: true, escalated: false };
		const exists = await this.#ownedGroupExists();
		if (exists === false) return { exited: true, escalated: false };
		await this.#signal("SIGTERM");
		if (await this.#waitForOwnedGroupExit(this.#timing.termGraceMs)) return { exited: true, escalated: true };
		await this.#signal("SIGKILL");
		return {
			exited: await this.#waitForOwnedGroupExit(this.#timing.killObservationMs),
			escalated: true,
		};
	}

	async #waitForOwnedGroupExit(milliseconds: number): Promise<boolean> {
		const deadline = Date.now() + milliseconds;
		while (true) {
			const exists = await this.#ownedGroupExists();
			if (exists === false) return true;
			if (exists === null || Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
		}
	}

	async #ownedGroupExists(): Promise<boolean | null> {
		if (this.scope !== "posix-process-group") return false;
		try {
			const helper = new Deno.Command("kill", {
				args: ["--signal", "0", "--", `-${this.pid}`],
				stdin: "null",
				stdout: "null",
				stderr: "null",
			}).spawn();
			const completed = await boundedOutcome(helper.status, this.#timing.writeTimeoutMs);
			if (!completed.completed) {
				try {
					helper.kill("SIGKILL");
				} catch {
					// The helper may have exited at the timeout boundary.
				}
				return null;
			}
			return completed.value.success;
		} catch {
			return null;
		}
	}

	async #signal(signal: Deno.Signal): Promise<void> {
		try {
			if (this.scope === "posix-process-group") Deno.kill(-this.pid, signal);
			else this.#child.kill(signal);
			return;
		} catch (error) {
			if (error instanceof Deno.errors.NotFound) return;
			if (
				!(error instanceof Deno.errors.PermissionDenied) && !(error instanceof Deno.errors.NotCapable) ||
				this.scope !== "posix-process-group"
			) return;
		}

		// Executable-scoped --allow-run intentionally does not authorize the
		// process-wide Deno.kill API. Keep the permission narrow by invoking the
		// separately allowlisted POSIX helper with only this owned negative PGID.
		try {
			const helper = new Deno.Command("kill", {
				args: ["--signal", signal.replace(/^SIG/, ""), "--", `-${this.pid}`],
				stdin: "null",
				stdout: "null",
				stderr: "null",
			}).spawn();
			const completed = await boundedOutcome(helper.status, this.#timing.writeTimeoutMs);
			if (!completed.completed) {
				try {
					helper.kill("SIGKILL");
				} catch {
					// The helper may have exited at the timeout boundary.
				}
			}
		} catch {
			// The bounded observer below decides whether cleanup actually succeeded.
		}
	}

	#retireResult(escalated: boolean, promptSettledBeforeClose: boolean, exited = true): AcpRetireResult {
		if (!exited && !this.#failureNotified) {
			this.#failureNotified = true;
			try {
				this.#hooks.onFailure?.(this.generation, safeFailure("termination-failure"));
			} catch {
				// Cleanup evidence remains in the returned result.
			}
		}
		return {
			scope: this.scope,
			exited,
			escalated,
			promptSettledBeforeClose,
			exitCode: this.#exitStatus?.code ?? null,
			signal: this.#exitStatus?.signal ?? null,
		};
	}
}

function boundedLocalMethod(value: string): string {
	if (typeof value !== "string" || value.length === 0 || byteLength(value) > ACP_MAX_METHOD_BYTES) {
		throw new AcpClientError("invalid-method", "ACP method was invalid.");
	}
	return value;
}

function validateLaunchSpec(spec: AcpLaunchSpec): AcpLaunchSpec {
	validateExecutable(spec.command, "command");
	if (!Array.isArray(spec.args) || spec.args.length > 64) {
		throw new AcpClientError("invalid-launch", "Too many launch arguments.");
	}
	for (const [index, argument] of spec.args.entries()) validateArgument(argument, `args[${index}]`);
	if (spec.cwd !== undefined) {
		validateArgument(spec.cwd, "cwd");
		if (!isAbsolute(spec.cwd)) throw new AcpClientError("invalid-launch", "Launch cwd must be absolute.");
	}
	if (spec.terminationScope !== "posix-process-group" && spec.terminationScope !== "direct-child") {
		throw new AcpClientError("invalid-launch", "Termination scope was invalid.");
	}
	if (spec.terminationScope === "posix-process-group" && Deno.build.os === "windows") {
		throw new AcpClientError("invalid-launch", "Windows cannot own a POSIX process group.");
	}
	if (spec.env !== undefined) {
		for (const [key, value] of Object.entries(spec.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0") || byteLength(value) > 16 * 1024) {
				throw new AcpClientError("invalid-launch", "Launch environment contained an invalid entry.");
			}
		}
	}
	return spec;
}
