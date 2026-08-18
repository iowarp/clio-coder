/**
 * Versioned, JSON-only contract between the Workbench browser and its local host.
 *
 * This module intentionally has no imports and no React dependencies. Both sides
 * can use the same runtime validators without coupling Workbench to Clio's
 * internal modules.
 */

export const PROTOCOL_VERSION = 2 as const;
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024;
export const MAX_SERVER_EVENT_BYTES = 64 * 1024;

const MAX_ID_BYTES = 128;
const MAX_NAME_BYTES = 128;
const MAX_PATH_DEPTH = 64;

const encoder = new TextEncoder();

export const CLIENT_COMMAND_KINDS = [
	"project.create",
	"project.register",
	"project.select",
	"fs.refresh",
	"fs.create-file",
	"fs.create-folder",
	"fs.move",
	"fs.delete.prepare",
	"fs.delete.confirm",
	"engine.select",
	"engine.probe",
	"turn.start",
	"turn.cancel",
	"permission.resolve",
] as const;

export type ClientCommandKind = (typeof CLIENT_COMMAND_KINDS)[number];

export const ENGINE_KINDS = ["fake", "clio-acp"] as const;
export type WireEngineKind = (typeof ENGINE_KINDS)[number];

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
export type WireEnginePhase = (typeof ENGINE_PHASES)[number];

export const ENGINE_SOURCES = [
	"simulated-by-workbench",
	"reported-by-clio",
	"observed-on-acp",
	"observed-by-workbench",
	"independently-verified",
] as const;
export type WireEngineSource = (typeof ENGINE_SOURCES)[number];

export const READINESS_KEYS = [
	"runtime",
	"protocol",
	"project",
	"target",
	"authentication",
	"provider",
	"context",
] as const;
export type WireReadinessKey = (typeof READINESS_KEYS)[number];

export const READINESS_STATES = ["ready", "unavailable", "failed"] as const;
export type WireReadinessState = (typeof READINESS_STATES)[number];

export interface WireEngineReadinessFact {
	readonly key: WireReadinessKey;
	readonly label: string;
	readonly state: WireReadinessState;
	readonly detail: string;
	readonly source: WireEngineSource;
}

export interface WireEngineSnapshot {
	readonly kind: WireEngineKind;
	readonly phase: WireEnginePhase;
	readonly facts: readonly WireEngineReadinessFact[];
	readonly checkedAt?: string;
}

export const FAKE_SCENARIOS = ["complete", "failure"] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export const PERMISSION_DECISIONS = ["allow-once", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const PERMISSION_RESOLUTIONS = ["allow-once", "reject", "cancelled", "timeout", "disconnect"] as const;
export type PermissionResolution = (typeof PERMISSION_RESOLUTIONS)[number];

export type ProjectPath = readonly string[];

export interface ProjectCreatePayload {
	readonly displayName: string;
	readonly directoryName: string;
}

export interface ProjectRegisterPayload {
	readonly relativeRoot: ProjectPath;
	readonly displayName?: string;
}

export interface ProjectSelectPayload {
	readonly projectId: string;
}

export interface FsRefreshPayload {
	readonly projectId: string;
	readonly directory: ProjectPath;
}

export interface FsCreateFilePayload {
	readonly projectId: string;
	readonly parent: ProjectPath;
	readonly name: string;
}

export interface FsCreateFolderPayload {
	readonly projectId: string;
	readonly parent: ProjectPath;
	readonly name: string;
}

export interface FsMovePayload {
	readonly projectId: string;
	readonly source: ProjectPath;
	readonly destination: Readonly<{
		parent: ProjectPath;
		name: string;
	}>;
	readonly expectedNodeVersion?: string;
}

export interface FsDeletePreparePayload {
	readonly projectId: string;
	readonly target: ProjectPath;
	readonly expectedNodeVersion?: string;
}

export interface FsDeleteConfirmPayload {
	readonly projectId: string;
	readonly confirmationId: string;
}

export interface EngineSelectPayload {
	readonly projectId: string;
	readonly kind: WireEngineKind;
}

export interface EngineProbePayload {
	readonly projectId: string;
}

export interface TurnStartPayload {
	readonly projectId: string;
	readonly prompt: string;
	readonly fakeScenario?: FakeScenario;
}

export interface TurnCancelPayload {
	readonly projectId: string;
	readonly turnId: string;
}

export interface PermissionResolvePayload {
	readonly projectId: string;
	readonly turnId: string;
	readonly permissionId: string;
	readonly decision: PermissionDecision;
}

export interface ClientCommandPayloadByKind {
	readonly "project.create": ProjectCreatePayload;
	readonly "project.register": ProjectRegisterPayload;
	readonly "project.select": ProjectSelectPayload;
	readonly "fs.refresh": FsRefreshPayload;
	readonly "fs.create-file": FsCreateFilePayload;
	readonly "fs.create-folder": FsCreateFolderPayload;
	readonly "fs.move": FsMovePayload;
	readonly "fs.delete.prepare": FsDeletePreparePayload;
	readonly "fs.delete.confirm": FsDeleteConfirmPayload;
	readonly "engine.select": EngineSelectPayload;
	readonly "engine.probe": EngineProbePayload;
	readonly "turn.start": TurnStartPayload;
	readonly "turn.cancel": TurnCancelPayload;
	readonly "permission.resolve": PermissionResolvePayload;
}

export type ClientCommandOf<K extends ClientCommandKind> = Readonly<{
	protocolVersion: typeof PROTOCOL_VERSION;
	requestId: string;
	kind: K;
	payload: ClientCommandPayloadByKind[K];
}>;

export type ClientCommand = {
	[K in ClientCommandKind]: ClientCommandOf<K>;
}[ClientCommandKind];

export const SERVER_EVENT_KINDS = [
	"connection.ready",
	"project.snapshot",
	"project.created",
	"project.registered",
	"project.selected",
	"fs.changed",
	"fs.delete.challenge",
	"engine.state",
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.agent",
	"turn.tool",
	"turn.change",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.evidence",
	"turn.terminal",
	"protocol.error",
	"command.error",
] as const;

export type ServerEventKind = (typeof SERVER_EVENT_KINDS)[number];

export type ProtocolErrorCode = "unsupported-version" | "invalid-frame" | "sequence-error" | "internal";
export type CommandErrorCode = "invalid" | "conflict" | "not-found" | "not-ready" | "internal";

export type ConnectionReadyPayload = Readonly<Record<string, never>>;

export interface WireProjectPath {
	readonly segments: ProjectPath;
}

export type WireTreeNodeKind = "file" | "directory" | "symlink" | "other";

export interface WireTreeNode {
	readonly name: string;
	readonly path: WireProjectPath;
	readonly kind: WireTreeNodeKind;
	readonly operable: boolean;
	readonly size?: number;
	readonly modifiedAt?: string;
	readonly nodeVersion?: string;
	readonly children?: readonly WireTreeNode[];
}

export interface WireProjectIdentity {
	readonly kind: "local-sandbox" | "wsl" | "native";
	readonly displayPath: string;
	readonly distro?: string;
}

export interface WireProjectSummary {
	readonly id: string;
	readonly displayName: string;
	readonly identity: WireProjectIdentity;
	readonly lastOpenedAt: string;
}

export interface WireSessionSummary {
	readonly id: string;
	readonly label: string;
	readonly preview: string;
	readonly updatedAt: string;
	readonly status: "idle" | "active" | "complete" | "canceled" | "failed";
}

export interface WireTimelineItem {
	readonly id: string;
	readonly kind:
		| "request"
		| "narrative"
		| "agent"
		| "tool"
		| "change"
		| "approval"
		| "evidence"
		| "outcome"
		| "failure";
	readonly title: string;
	readonly summary: string;
	readonly detail?: string;
	readonly status: "queued" | "active" | "waiting" | "complete" | "canceled" | "failed";
	readonly timeLabel: string;
	readonly sequence?: number;
}

export interface WirePendingPermission {
	readonly permissionId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly locations: readonly WireProjectPath[];
	readonly expiresAt: string;
	readonly source: WireEngineSource;
}

export interface WireDeleteChallenge {
	readonly confirmationId: string;
	readonly target: WireProjectPath;
	readonly displayPath: string;
	readonly targetKind: "file" | "empty-directory";
	readonly expiresAt: string;
}

export interface WireEvidenceRecord {
	readonly id: string;
	readonly label: string;
	readonly detail: string;
	readonly status: "observed" | "reported" | "unavailable";
	readonly source: WireEngineSource;
}

export interface WireChangeRecord {
	readonly id: string;
	readonly path: WireProjectPath;
	readonly summary: string;
	readonly status: "planned" | "recorded" | "verified";
	readonly source: WireEngineSource;
}

export interface WireAgentRecord {
	readonly id: string;
	readonly name: string;
	readonly task: string;
	readonly status: "queued" | "active" | "complete" | "canceled" | "failed";
	readonly summary: string;
	readonly source: WireEngineSource;
}

export interface WireProjectWorkspace {
	readonly project: WireProjectSummary;
	readonly tree: readonly WireTreeNode[];
	readonly treeTruncated: boolean;
	readonly sessions: readonly WireSessionSummary[];
	readonly selectedSessionId: string | null;
	readonly timeline: readonly WireTimelineItem[];
	readonly engine: WireEngineSnapshot;
	readonly pendingPermission: WirePendingPermission | null;
	readonly deleteChallenge: WireDeleteChallenge | null;
	readonly agents: readonly WireAgentRecord[];
	readonly changes: readonly WireChangeRecord[];
	readonly evidence: readonly WireEvidenceRecord[];
	readonly engineGeneration: string | null;
	readonly activeTurnId: string | null;
	readonly lastSequence: number;
}

export interface ProjectSnapshotPayload {
	readonly tree: readonly WireTreeNode[];
	readonly treeTruncated: boolean;
}

export interface ProjectAddedPayload {
	readonly workspace: WireProjectWorkspace;
}

export interface FsDeleteChallengePayload extends WireDeleteChallenge {}

export type ProjectSelectedPayload = Readonly<Record<string, never>>;

export interface EngineStatePayload {
	readonly snapshot: WireEngineSnapshot;
}

export interface TurnStartedPayload {
	readonly promptSummary: string;
	readonly fakeScenario?: FakeScenario;
	readonly source: WireEngineSource;
}

export interface TurnTextPayload {
	readonly text: string;
	readonly source: WireEngineSource;
}

export interface TurnAgentPayload {
	readonly agentId: string;
	readonly name: string;
	readonly task: string;
	readonly status: "active" | "complete" | "canceled" | "failed";
	readonly summary: string;
	readonly source: WireEngineSource;
}

export interface TurnToolPayload {
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly status: "in_progress" | "completed" | "failed" | "canceled";
	readonly summary: string;
	readonly locations: readonly WireProjectPath[];
	readonly source: WireEngineSource;
}

export interface TurnChangePayload {
	readonly path: WireProjectPath;
	readonly summary: string;
	readonly source: WireEngineSource;
}

export interface TurnPermissionRequestedPayload {
	readonly permissionId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly locations: readonly WireProjectPath[];
	readonly expiresAt: string;
	readonly source: WireEngineSource;
}

export interface TurnPermissionResolvedPayload {
	readonly permissionId: string;
	readonly decision: PermissionResolution;
	readonly source: WireEngineSource;
}

export interface TurnEvidencePayload {
	readonly label: string;
	readonly detail: string;
	readonly status: "observed" | "reported" | "unavailable";
	readonly source: WireEngineSource;
}

export interface WireUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
}

export const TURN_OUTCOMES = ["completed", "canceled", "failed"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const TURN_STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
export type TurnStopReason = (typeof TURN_STOP_REASONS)[number];

export interface TurnTerminalPayload {
	readonly outcome: TurnOutcome;
	readonly code: string;
	readonly summary: string;
	readonly stopReason?: TurnStopReason;
	readonly usage?: WireUsage;
	readonly source: WireEngineSource;
}

export interface ProtocolErrorPayload {
	readonly code: ProtocolErrorCode;
	readonly message: string;
	readonly requestId?: string;
}

export interface CommandErrorPayload {
	readonly code: CommandErrorCode;
	readonly message: string;
	readonly requestId?: string;
}

export interface ServerEventPayloadByKind {
	readonly "connection.ready": ConnectionReadyPayload;
	readonly "project.snapshot": ProjectSnapshotPayload;
	readonly "project.created": ProjectAddedPayload;
	readonly "project.registered": ProjectAddedPayload;
	readonly "project.selected": ProjectSelectedPayload;
	readonly "fs.changed": ProjectSnapshotPayload;
	readonly "fs.delete.challenge": FsDeleteChallengePayload;
	readonly "engine.state": EngineStatePayload;
	readonly "turn.started": TurnStartedPayload;
	readonly "turn.text": TurnTextPayload;
	readonly "turn.thought": TurnTextPayload;
	readonly "turn.agent": TurnAgentPayload;
	readonly "turn.tool": TurnToolPayload;
	readonly "turn.change": TurnChangePayload;
	readonly "turn.permission.requested": TurnPermissionRequestedPayload;
	readonly "turn.permission.resolved": TurnPermissionResolvedPayload;
	readonly "turn.evidence": TurnEvidencePayload;
	readonly "turn.terminal": TurnTerminalPayload;
	readonly "protocol.error": ProtocolErrorPayload;
	readonly "command.error": CommandErrorPayload;
}

interface ServerEnvelopeBase<K extends ServerEventKind> {
	readonly protocolVersion: typeof PROTOCOL_VERSION;
	readonly workspaceInstanceId: string;
	readonly sequence: number;
	readonly eventId: string;
	readonly kind: K;
	readonly projectId?: string;
	readonly engineGeneration?: string;
	readonly sessionId?: string;
	readonly turnId?: string;
	readonly terminal: boolean;
	readonly payload: ServerEventPayloadByKind[K];
}

export type ServerEventOf<K extends ServerEventKind> = Readonly<ServerEnvelopeBase<K>>;

export type ServerEvent = {
	[K in ServerEventKind]: ServerEventOf<K>;
}[ServerEventKind];

export type ProtocolValidationErrorCode =
	| "invalid-frame"
	| "frame-too-large"
	| "invalid-payload"
	| "unsupported-version"
	| "sequence-error";

export class ProtocolValidationError extends Error {
	readonly code: ProtocolValidationErrorCode;

	constructor(code: ProtocolValidationErrorCode, message: string) {
		super(message);
		this.name = "ProtocolValidationError";
		this.code = code;
	}
}

function invalid(message: string): never {
	throw new ProtocolValidationError("invalid-payload", message);
}

function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function hasUnsafePresentationCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint === 0x7f || (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d))
		) return true;
	}
	return false;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid(`${label} must be a record`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return invalid(`${label} must be a plain record`);
	}
	return value as Record<string, unknown>;
}

function expectExactKeys(
	value: unknown,
	label: string,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const record = expectRecord(value, label);
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) invalid(`${label} has unknown field ${JSON.stringify(key)}`);
	}
	for (const key of required) {
		if (!Object.hasOwn(record, key)) invalid(`${label} is missing field ${JSON.stringify(key)}`);
	}
	return record;
}

function expectString(
	value: unknown,
	label: string,
	options: {
		readonly minBytes?: number;
		readonly maxBytes: number;
		readonly trim?: boolean;
		readonly noControls?: boolean;
	},
): string {
	if (typeof value !== "string") return invalid(`${label} must be a string`);
	if (options.trim && value.trim() !== value) return invalid(`${label} must not have surrounding whitespace`);
	if (options.noControls && hasControlCharacter(value)) {
		return invalid(`${label} contains control characters`);
	}
	const byteLength = utf8Bytes(value);
	if (byteLength < (options.minBytes ?? 0) || byteLength > options.maxBytes) {
		return invalid(`${label} has an invalid UTF-8 length`);
	}
	return value;
}

function expectId(value: unknown, label: string): string {
	const id = expectString(value, label, { minBytes: 1, maxBytes: MAX_ID_BYTES, trim: true, noControls: true });
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
		return invalid(`${label} is not a valid identifier`);
	}
	return id;
}

function expectOpaqueString(value: unknown, label: string, maximumBytes = 256): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: maximumBytes,
		trim: true,
		noControls: true,
	});
}

function expectName(value: unknown, label: string): string {
	const name = expectString(value, label, { minBytes: 1, maxBytes: MAX_NAME_BYTES, trim: true, noControls: true });
	if (name === "." || name === ".." || /[\\/]/u.test(name)) return invalid(`${label} is not a valid name`);
	return name;
}

function expectDisplayName(value: unknown, label: string): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: MAX_NAME_BYTES,
		trim: true,
		noControls: true,
	});
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") return invalid(`${label} must be a boolean`);
	return value;
}

function expectInteger(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		return invalid(`${label} must be a safe integer greater than or equal to ${minimum}`);
	}
	return value as number;
}

function expectEnum<const T extends readonly string[]>(value: unknown, label: string, choices: T): T[number] {
	if (typeof value !== "string" || !choices.includes(value as T[number])) {
		return invalid(`${label} must be one of ${choices.join(", ")}`);
	}
	return value as T[number];
}

function expectPath(value: unknown, label: string, allowRoot: boolean): ProjectPath {
	if (!Array.isArray(value)) return invalid(`${label} must be an array of path segments`);
	if ((!allowRoot && value.length === 0) || value.length > MAX_PATH_DEPTH) {
		return invalid(`${label} has an invalid path depth`);
	}
	return value.map((segment, index) => expectName(segment, `${label}[${index}]`));
}

function validateClientPayload<K extends ClientCommandKind>(kind: K, value: unknown): ClientCommandPayloadByKind[K] {
	const label = `${kind} payload`;
	switch (kind) {
		case "project.create": {
			const record = expectExactKeys(value, label, ["displayName", "directoryName"]);
			return {
				displayName: expectDisplayName(record.displayName, `${label}.displayName`),
				directoryName: expectName(record.directoryName, `${label}.directoryName`),
			} as ClientCommandPayloadByKind[K];
		}
		case "project.register": {
			const record = expectExactKeys(value, label, ["relativeRoot"], ["displayName"]);
			const displayName = Object.hasOwn(record, "displayName")
				? expectDisplayName(record.displayName, `${label}.displayName`)
				: undefined;
			return {
				relativeRoot: expectPath(record.relativeRoot, `${label}.relativeRoot`, false),
				...(displayName === undefined ? {} : { displayName }),
			} as ClientCommandPayloadByKind[K];
		}
		case "project.select": {
			const record = expectExactKeys(value, label, ["projectId"]);
			return { projectId: expectId(record.projectId, `${label}.projectId`) } as ClientCommandPayloadByKind[K];
		}
		case "fs.refresh": {
			const record = expectExactKeys(value, label, ["projectId", "directory"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				directory: expectPath(record.directory, `${label}.directory`, true),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.create-file": {
			const record = expectExactKeys(value, label, ["projectId", "parent", "name"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				parent: expectPath(record.parent, `${label}.parent`, true),
				name: expectName(record.name, `${label}.name`),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.create-folder": {
			const record = expectExactKeys(value, label, ["projectId", "parent", "name"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				parent: expectPath(record.parent, `${label}.parent`, true),
				name: expectName(record.name, `${label}.name`),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.move": {
			const record = expectExactKeys(value, label, ["projectId", "source", "destination"], ["expectedNodeVersion"]);
			const destination = expectExactKeys(record.destination, `${label}.destination`, ["parent", "name"]);
			const expectedNodeVersion = Object.hasOwn(record, "expectedNodeVersion")
				? expectOpaqueString(record.expectedNodeVersion, `${label}.expectedNodeVersion`)
				: undefined;
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				source: expectPath(record.source, `${label}.source`, false),
				destination: {
					parent: expectPath(destination.parent, `${label}.destination.parent`, true),
					name: expectName(destination.name, `${label}.destination.name`),
				},
				...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.delete.prepare": {
			const record = expectExactKeys(value, label, ["projectId", "target"], ["expectedNodeVersion"]);
			const expectedNodeVersion = Object.hasOwn(record, "expectedNodeVersion")
				? expectOpaqueString(record.expectedNodeVersion, `${label}.expectedNodeVersion`)
				: undefined;
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				target: expectPath(record.target, `${label}.target`, false),
				...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.delete.confirm": {
			const record = expectExactKeys(value, label, ["projectId", "confirmationId"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				confirmationId: expectId(record.confirmationId, `${label}.confirmationId`),
			} as ClientCommandPayloadByKind[K];
		}
		case "engine.select": {
			const record = expectExactKeys(value, label, ["projectId", "kind"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				kind: expectEnum(record.kind, `${label}.kind`, ENGINE_KINDS),
			} as ClientCommandPayloadByKind[K];
		}
		case "engine.probe": {
			const record = expectExactKeys(value, label, ["projectId"]);
			return { projectId: expectId(record.projectId, `${label}.projectId`) } as ClientCommandPayloadByKind[K];
		}
		case "turn.start": {
			const record = expectExactKeys(value, label, ["projectId", "prompt"], ["fakeScenario"]);
			const prompt = expectString(record.prompt, `${label}.prompt`, {
				minBytes: 1,
				maxBytes: 4 * 1024,
				trim: true,
			});
			if (prompt.includes("\0")) invalid(`${label}.prompt contains a null character`);
			const fakeScenario = Object.hasOwn(record, "fakeScenario")
				? expectEnum(record.fakeScenario, `${label}.fakeScenario`, FAKE_SCENARIOS)
				: undefined;
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				prompt,
				...(fakeScenario === undefined ? {} : { fakeScenario }),
			} as ClientCommandPayloadByKind[K];
		}
		case "turn.cancel": {
			const record = expectExactKeys(value, label, ["projectId", "turnId"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				turnId: expectId(record.turnId, `${label}.turnId`),
			} as ClientCommandPayloadByKind[K];
		}
		case "permission.resolve": {
			const record = expectExactKeys(value, label, ["projectId", "turnId", "permissionId", "decision"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				turnId: expectId(record.turnId, `${label}.turnId`),
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				decision: expectEnum(record.decision, `${label}.decision`, PERMISSION_DECISIONS),
			} as ClientCommandPayloadByKind[K];
		}
	}
}

export const MAX_WIRE_COLLECTION_ENTRIES = 512;
const MAX_WIRE_TREE_NODES = 512;
const MAX_SERVER_EVENTS_PER_CONNECTION = 16 * 1024;

function expectArray<T>(
	value: unknown,
	label: string,
	maximum: number,
	validate: (entry: unknown, label: string) => T,
): readonly T[] {
	if (!Array.isArray(value)) return invalid(`${label} must be an array`);
	if (value.length > maximum) return invalid(`${label} has too many entries`);
	return value.map((entry, index) => validate(entry, `${label}[${index}]`));
}

function expectPresentationText(value: unknown, label: string, maximumBytes = 4 * 1024): string {
	const text = expectString(value, label, { minBytes: 1, maxBytes: maximumBytes, trim: true });
	if (hasUnsafePresentationCharacter(text)) return invalid(`${label} contains an unsafe control character`);
	return text;
}

function expectSanitizedMessage(value: unknown, label: string): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: 4 * 1024,
		trim: true,
		noControls: true,
	});
}

function expectTimestamp(value: unknown, label: string): string {
	const timestamp = expectOpaqueString(value, label, 128);
	const parsed = new Date(timestamp);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
		return invalid(`${label} must be a canonical ISO timestamp`);
	}
	return timestamp;
}

function expectNullableId(value: unknown, label: string): string | null {
	return value === null ? null : expectId(value, label);
}

function validateWireProjectPath(value: unknown, label: string, allowRoot = true): WireProjectPath {
	const record = expectExactKeys(value, label, ["segments"]);
	return { segments: expectPath(record.segments, `${label}.segments`, allowRoot) };
}

function validateEngineSource(value: unknown, label: string): WireEngineSource {
	return expectEnum(value, label, ENGINE_SOURCES);
}

function validateEngineFact(value: unknown, label: string): WireEngineReadinessFact {
	const record = expectExactKeys(value, label, ["key", "label", "state", "detail", "source"]);
	return {
		key: expectEnum(record.key, `${label}.key`, READINESS_KEYS),
		label: expectPresentationText(record.label, `${label}.label`, 128),
		state: expectEnum(record.state, `${label}.state`, READINESS_STATES),
		detail: expectPresentationText(record.detail, `${label}.detail`, 1024),
		source: validateEngineSource(record.source, `${label}.source`),
	};
}

function validateEngineSnapshot(value: unknown, label: string): WireEngineSnapshot {
	const record = expectExactKeys(value, label, ["kind", "phase", "facts"], ["checkedAt"]);
	const facts = expectArray(record.facts, `${label}.facts`, READINESS_KEYS.length, validateEngineFact);
	if (facts.length !== READINESS_KEYS.length) invalid(`${label}.facts must contain every readiness fact exactly once`);
	const factKeys = new Set(facts.map((fact) => fact.key));
	if (factKeys.size !== READINESS_KEYS.length || READINESS_KEYS.some((key) => !factKeys.has(key))) {
		invalid(`${label}.facts must contain every readiness fact exactly once`);
	}
	const checkedAt = Object.hasOwn(record, "checkedAt")
		? expectTimestamp(record.checkedAt, `${label}.checkedAt`)
		: undefined;
	return {
		kind: expectEnum(record.kind, `${label}.kind`, ENGINE_KINDS),
		phase: expectEnum(record.phase, `${label}.phase`, ENGINE_PHASES),
		facts,
		...(checkedAt === undefined ? {} : { checkedAt }),
	};
}

function validateLocations(value: unknown, label: string): readonly WireProjectPath[] {
	return expectArray(value, label, 32, (entry, entryLabel) => validateWireProjectPath(entry, entryLabel, false));
}

interface TreeBudget {
	nodes: number;
}

function validateWireTreeNode(value: unknown, label: string, budget: TreeBudget): WireTreeNode {
	budget.nodes += 1;
	if (budget.nodes > MAX_WIRE_TREE_NODES) return invalid(`${label} exceeds the wire tree node limit`);
	const record = expectExactKeys(value, label, ["name", "path", "kind", "operable"], [
		"size",
		"modifiedAt",
		"nodeVersion",
		"children",
	]);
	const size = Object.hasOwn(record, "size") ? expectInteger(record.size, `${label}.size`) : undefined;
	const modifiedAt = Object.hasOwn(record, "modifiedAt")
		? expectTimestamp(record.modifiedAt, `${label}.modifiedAt`)
		: undefined;
	const nodeVersion = Object.hasOwn(record, "nodeVersion")
		? expectOpaqueString(record.nodeVersion, `${label}.nodeVersion`)
		: undefined;
	const children = Object.hasOwn(record, "children")
		? expectArray(
			record.children,
			`${label}.children`,
			MAX_WIRE_TREE_NODES,
			(entry, entryLabel) => validateWireTreeNode(entry, entryLabel, budget),
		)
		: undefined;
	return {
		name: expectName(record.name, `${label}.name`),
		path: validateWireProjectPath(record.path, `${label}.path`),
		kind: expectEnum(record.kind, `${label}.kind`, ["file", "directory", "symlink", "other"] as const),
		operable: expectBoolean(record.operable, `${label}.operable`),
		...(size === undefined ? {} : { size }),
		...(modifiedAt === undefined ? {} : { modifiedAt }),
		...(nodeVersion === undefined ? {} : { nodeVersion }),
		...(children === undefined ? {} : { children }),
	};
}

function validateWireTree(value: unknown, label: string): readonly WireTreeNode[] {
	const budget = { nodes: 0 };
	return expectArray(
		value,
		label,
		MAX_WIRE_TREE_NODES,
		(entry, entryLabel) => validateWireTreeNode(entry, entryLabel, budget),
	);
}

function validateWireProjectIdentity(value: unknown, label: string): WireProjectIdentity {
	const record = expectExactKeys(value, label, ["kind", "displayPath"], ["distro"]);
	const kind = expectEnum(record.kind, `${label}.kind`, ["local-sandbox", "wsl", "native"] as const);
	const distro = Object.hasOwn(record, "distro")
		? expectPresentationText(record.distro, `${label}.distro`, 256)
		: undefined;
	if (kind === "wsl" && distro === undefined) invalid(`${label}.distro is required for WSL projects`);
	if (kind !== "wsl" && distro !== undefined) invalid(`${label}.distro is only valid for WSL projects`);
	return {
		kind,
		displayPath: expectPresentationText(record.displayPath, `${label}.displayPath`),
		...(distro === undefined ? {} : { distro }),
	};
}

function validateWireProjectSummary(value: unknown, label: string): WireProjectSummary {
	const record = expectExactKeys(value, label, ["id", "displayName", "identity", "lastOpenedAt"]);
	return {
		id: expectId(record.id, `${label}.id`),
		displayName: expectDisplayName(record.displayName, `${label}.displayName`),
		identity: validateWireProjectIdentity(record.identity, `${label}.identity`),
		lastOpenedAt: expectTimestamp(record.lastOpenedAt, `${label}.lastOpenedAt`),
	};
}

function validateWireSessionSummary(value: unknown, label: string): WireSessionSummary {
	const record = expectExactKeys(value, label, ["id", "label", "preview", "updatedAt", "status"]);
	return {
		id: expectId(record.id, `${label}.id`),
		label: expectPresentationText(record.label, `${label}.label`, 512),
		preview: expectPresentationText(record.preview, `${label}.preview`),
		updatedAt: expectTimestamp(record.updatedAt, `${label}.updatedAt`),
		status: expectEnum(
			record.status,
			`${label}.status`,
			["idle", "active", "complete", "canceled", "failed"] as const,
		),
	};
}

function validateWireTimelineItem(value: unknown, label: string): WireTimelineItem {
	const record = expectExactKeys(value, label, ["id", "kind", "title", "summary", "status", "timeLabel"], [
		"detail",
		"sequence",
	]);
	const detail = Object.hasOwn(record, "detail") ? expectPresentationText(record.detail, `${label}.detail`) : undefined;
	const sequence = Object.hasOwn(record, "sequence")
		? expectInteger(record.sequence, `${label}.sequence`, 1)
		: undefined;
	return {
		id: expectId(record.id, `${label}.id`),
		kind: expectEnum(
			record.kind,
			`${label}.kind`,
			["request", "narrative", "agent", "tool", "change", "approval", "evidence", "outcome", "failure"] as const,
		),
		title: expectPresentationText(record.title, `${label}.title`, 512),
		summary: expectPresentationText(record.summary, `${label}.summary`),
		...(detail === undefined ? {} : { detail }),
		status: expectEnum(
			record.status,
			`${label}.status`,
			["queued", "active", "waiting", "complete", "canceled", "failed"] as const,
		),
		timeLabel: expectPresentationText(record.timeLabel, `${label}.timeLabel`, 128),
		...(sequence === undefined ? {} : { sequence }),
	};
}

function validateWirePendingPermission(value: unknown, label: string): WirePendingPermission {
	const record = expectExactKeys(value, label, [
		"permissionId",
		"toolCallId",
		"title",
		"kind",
		"locations",
		"expiresAt",
		"source",
	]);
	return {
		permissionId: expectId(record.permissionId, `${label}.permissionId`),
		toolCallId: expectId(record.toolCallId, `${label}.toolCallId`),
		title: expectPresentationText(record.title, `${label}.title`, 512),
		kind: expectPresentationText(record.kind, `${label}.kind`, 64),
		locations: validateLocations(record.locations, `${label}.locations`),
		expiresAt: expectTimestamp(record.expiresAt, `${label}.expiresAt`),
		source: validateEngineSource(record.source, `${label}.source`),
	};
}

function validateWireDeleteChallenge(value: unknown, label: string): WireDeleteChallenge {
	const record = expectExactKeys(value, label, ["confirmationId", "target", "displayPath", "targetKind", "expiresAt"]);
	return {
		confirmationId: expectId(record.confirmationId, `${label}.confirmationId`),
		target: validateWireProjectPath(record.target, `${label}.target`),
		displayPath: expectPresentationText(record.displayPath, `${label}.displayPath`),
		targetKind: expectEnum(record.targetKind, `${label}.targetKind`, ["file", "empty-directory"] as const),
		expiresAt: expectTimestamp(record.expiresAt, `${label}.expiresAt`),
	};
}

function validateWireEvidence(value: unknown, label: string): WireEvidenceRecord {
	const record = expectExactKeys(value, label, ["id", "label", "detail", "status", "source"]);
	return {
		id: expectId(record.id, `${label}.id`),
		label: expectPresentationText(record.label, `${label}.label`, 512),
		detail: expectPresentationText(record.detail, `${label}.detail`),
		status: expectEnum(record.status, `${label}.status`, ["observed", "reported", "unavailable"] as const),
		source: validateEngineSource(record.source, `${label}.source`),
	};
}

function validateWireChange(value: unknown, label: string): WireChangeRecord {
	const record = expectExactKeys(value, label, ["id", "path", "summary", "status", "source"]);
	return {
		id: expectId(record.id, `${label}.id`),
		path: validateWireProjectPath(record.path, `${label}.path`, false),
		summary: expectPresentationText(record.summary, `${label}.summary`),
		status: expectEnum(record.status, `${label}.status`, ["planned", "recorded", "verified"] as const),
		source: validateEngineSource(record.source, `${label}.source`),
	};
}

function validateWireAgent(value: unknown, label: string): WireAgentRecord {
	const record = expectExactKeys(value, label, ["id", "name", "task", "status", "summary", "source"]);
	return {
		id: expectId(record.id, `${label}.id`),
		name: expectPresentationText(record.name, `${label}.name`, 512),
		task: expectPresentationText(record.task, `${label}.task`),
		status: expectEnum(
			record.status,
			`${label}.status`,
			["queued", "active", "complete", "canceled", "failed"] as const,
		),
		summary: expectPresentationText(record.summary, `${label}.summary`),
		source: validateEngineSource(record.source, `${label}.source`),
	};
}

function validateWireWorkspace(value: unknown, label: string): WireProjectWorkspace {
	const record = expectExactKeys(value, label, [
		"project",
		"tree",
		"treeTruncated",
		"sessions",
		"selectedSessionId",
		"timeline",
		"engine",
		"pendingPermission",
		"deleteChallenge",
		"agents",
		"changes",
		"evidence",
		"engineGeneration",
		"activeTurnId",
		"lastSequence",
	]);
	return {
		project: validateWireProjectSummary(record.project, `${label}.project`),
		tree: validateWireTree(record.tree, `${label}.tree`),
		treeTruncated: expectBoolean(record.treeTruncated, `${label}.treeTruncated`),
		sessions: expectArray(
			record.sessions,
			`${label}.sessions`,
			MAX_WIRE_COLLECTION_ENTRIES,
			validateWireSessionSummary,
		),
		selectedSessionId: expectNullableId(record.selectedSessionId, `${label}.selectedSessionId`),
		timeline: expectArray(
			record.timeline,
			`${label}.timeline`,
			MAX_WIRE_COLLECTION_ENTRIES,
			validateWireTimelineItem,
		),
		engine: validateEngineSnapshot(record.engine, `${label}.engine`),
		pendingPermission: record.pendingPermission === null
			? null
			: validateWirePendingPermission(record.pendingPermission, `${label}.pendingPermission`),
		deleteChallenge: record.deleteChallenge === null
			? null
			: validateWireDeleteChallenge(record.deleteChallenge, `${label}.deleteChallenge`),
		agents: expectArray(record.agents, `${label}.agents`, MAX_WIRE_COLLECTION_ENTRIES, validateWireAgent),
		changes: expectArray(record.changes, `${label}.changes`, MAX_WIRE_COLLECTION_ENTRIES, validateWireChange),
		evidence: expectArray(record.evidence, `${label}.evidence`, MAX_WIRE_COLLECTION_ENTRIES, validateWireEvidence),
		engineGeneration: expectNullableId(record.engineGeneration, `${label}.engineGeneration`),
		activeTurnId: expectNullableId(record.activeTurnId, `${label}.activeTurnId`),
		lastSequence: expectInteger(record.lastSequence, `${label}.lastSequence`),
	};
}

function validateProjectSnapshotPayload(value: unknown, label: string): ProjectSnapshotPayload {
	const record = expectExactKeys(value, label, ["tree", "treeTruncated"]);
	return {
		tree: validateWireTree(record.tree, `${label}.tree`),
		treeTruncated: expectBoolean(record.treeTruncated, `${label}.treeTruncated`),
	};
}

function expectStreamText(value: unknown, label: string): string {
	const text = expectString(value, label, { minBytes: 1, maxBytes: 16 * 1024 });
	if (hasUnsafePresentationCharacter(text)) invalid(`${label} contains an unsafe control character`);
	return text;
}

function validateUsage(value: unknown, label: string): WireUsage {
	const record = expectExactKeys(value, label, ["input", "output", "cacheRead", "cacheWrite", "reasoning"]);
	return {
		input: expectInteger(record.input, `${label}.input`),
		output: expectInteger(record.output, `${label}.output`),
		cacheRead: expectInteger(record.cacheRead, `${label}.cacheRead`),
		cacheWrite: expectInteger(record.cacheWrite, `${label}.cacheWrite`),
		reasoning: expectInteger(record.reasoning, `${label}.reasoning`),
	};
}

function validateServerPayload(kind: ServerEventKind, value: unknown): ServerEventPayloadByKind[ServerEventKind] {
	const label = `${kind} payload`;
	switch (kind) {
		case "connection.ready":
			return expectExactKeys(value, label, []) as ConnectionReadyPayload;
		case "project.snapshot":
		case "fs.changed":
			return validateProjectSnapshotPayload(value, label);
		case "project.created":
		case "project.registered": {
			const record = expectExactKeys(value, label, ["workspace"]);
			return { workspace: validateWireWorkspace(record.workspace, `${label}.workspace`) };
		}
		case "project.selected":
			return expectExactKeys(value, label, []) as ProjectSelectedPayload;
		case "fs.delete.challenge":
			return validateWireDeleteChallenge(value, label);
		case "engine.state": {
			const record = expectExactKeys(value, label, ["snapshot"]);
			return { snapshot: validateEngineSnapshot(record.snapshot, `${label}.snapshot`) };
		}
		case "turn.started": {
			const record = expectExactKeys(value, label, ["promptSummary", "source"], ["fakeScenario"]);
			const fakeScenario = Object.hasOwn(record, "fakeScenario")
				? expectEnum(record.fakeScenario, `${label}.fakeScenario`, FAKE_SCENARIOS)
				: undefined;
			return {
				promptSummary: expectPresentationText(record.promptSummary, `${label}.promptSummary`, 512),
				...(fakeScenario === undefined ? {} : { fakeScenario }),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.text":
		case "turn.thought": {
			const record = expectExactKeys(value, label, ["text", "source"]);
			return {
				text: expectStreamText(record.text, `${label}.text`),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.agent": {
			const record = expectExactKeys(value, label, ["agentId", "name", "task", "status", "summary", "source"]);
			return {
				agentId: expectId(record.agentId, `${label}.agentId`),
				name: expectPresentationText(record.name, `${label}.name`, 512),
				task: expectPresentationText(record.task, `${label}.task`),
				status: expectEnum(
					record.status,
					`${label}.status`,
					["active", "complete", "canceled", "failed"] as const,
				),
				summary: expectPresentationText(record.summary, `${label}.summary`),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.tool": {
			const record = expectExactKeys(value, label, [
				"toolCallId",
				"title",
				"kind",
				"status",
				"summary",
				"locations",
				"source",
			]);
			return {
				toolCallId: expectId(record.toolCallId, `${label}.toolCallId`),
				title: expectPresentationText(record.title, `${label}.title`, 512),
				kind: expectPresentationText(record.kind, `${label}.kind`, 64),
				status: expectEnum(
					record.status,
					`${label}.status`,
					["in_progress", "completed", "failed", "canceled"] as const,
				),
				summary: expectPresentationText(record.summary, `${label}.summary`),
				locations: validateLocations(record.locations, `${label}.locations`),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.change": {
			const record = expectExactKeys(value, label, ["path", "summary", "source"]);
			return {
				path: validateWireProjectPath(record.path, `${label}.path`, false),
				summary: expectPresentationText(record.summary, `${label}.summary`),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.permission.requested": {
			const record = expectExactKeys(value, label, [
				"permissionId",
				"toolCallId",
				"title",
				"kind",
				"locations",
				"expiresAt",
				"source",
			]);
			return {
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				toolCallId: expectId(record.toolCallId, `${label}.toolCallId`),
				title: expectPresentationText(record.title, `${label}.title`, 512),
				kind: expectPresentationText(record.kind, `${label}.kind`, 64),
				locations: validateLocations(record.locations, `${label}.locations`),
				expiresAt: expectTimestamp(record.expiresAt, `${label}.expiresAt`),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.permission.resolved": {
			const record = expectExactKeys(value, label, ["permissionId", "decision", "source"]);
			return {
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				decision: expectEnum(record.decision, `${label}.decision`, PERMISSION_RESOLUTIONS),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.evidence": {
			const record = expectExactKeys(value, label, ["label", "detail", "status", "source"]);
			return {
				label: expectPresentationText(record.label, `${label}.label`, 512),
				detail: expectPresentationText(record.detail, `${label}.detail`),
				status: expectEnum(record.status, `${label}.status`, ["observed", "reported", "unavailable"] as const),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "turn.terminal": {
			const record = expectExactKeys(value, label, ["outcome", "code", "summary", "source"], [
				"stopReason",
				"usage",
			]);
			const stopReason = Object.hasOwn(record, "stopReason")
				? expectEnum(record.stopReason, `${label}.stopReason`, TURN_STOP_REASONS)
				: undefined;
			const usage = Object.hasOwn(record, "usage") ? validateUsage(record.usage, `${label}.usage`) : undefined;
			return {
				outcome: expectEnum(record.outcome, `${label}.outcome`, TURN_OUTCOMES),
				code: expectId(record.code, `${label}.code`),
				summary: expectSanitizedMessage(record.summary, `${label}.summary`),
				...(stopReason === undefined ? {} : { stopReason }),
				...(usage === undefined ? {} : { usage }),
				source: validateEngineSource(record.source, `${label}.source`),
			};
		}
		case "protocol.error": {
			const record = expectExactKeys(value, label, ["code", "message"], ["requestId"]);
			const requestId = Object.hasOwn(record, "requestId")
				? expectId(record.requestId, `${label}.requestId`)
				: undefined;
			return {
				code: expectEnum(
					record.code,
					`${label}.code`,
					["unsupported-version", "invalid-frame", "sequence-error", "internal"] as const,
				),
				message: expectSanitizedMessage(record.message, `${label}.message`),
				...(requestId === undefined ? {} : { requestId }),
			};
		}
		case "command.error": {
			const record = expectExactKeys(value, label, ["code", "message"], ["requestId"]);
			const requestId = Object.hasOwn(record, "requestId")
				? expectId(record.requestId, `${label}.requestId`)
				: undefined;
			return {
				code: expectEnum(
					record.code,
					`${label}.code`,
					["invalid", "conflict", "not-found", "not-ready", "internal"] as const,
				),
				message: expectSanitizedMessage(record.message, `${label}.message`),
				...(requestId === undefined ? {} : { requestId }),
			};
		}
	}
}

function parseJsonFrame(frame: string, maximumBytes: number, label: string): unknown {
	if (typeof frame !== "string") throw new ProtocolValidationError("invalid-frame", `${label} must be a text frame`);
	if (utf8Bytes(frame) > maximumBytes) {
		throw new ProtocolValidationError("frame-too-large", `${label} exceeds ${maximumBytes} bytes`);
	}
	try {
		return JSON.parse(frame) as unknown;
	} catch {
		throw new ProtocolValidationError("invalid-frame", `${label} is not valid JSON`);
	}
}

function encodeJsonFrame(value: unknown, maximumBytes: number, label: string): string {
	let frame: string;
	try {
		frame = JSON.stringify(value);
	} catch {
		throw new ProtocolValidationError("invalid-frame", `${label} is not JSON serializable`);
	}
	if (typeof frame !== "string") {
		throw new ProtocolValidationError("invalid-frame", `${label} is not JSON serializable`);
	}
	if (utf8Bytes(frame) > maximumBytes) {
		throw new ProtocolValidationError("frame-too-large", `${label} exceeds ${maximumBytes} bytes`);
	}
	return frame;
}

export function validateClientCommand(value: unknown): ClientCommand {
	const record = expectExactKeys(value, "client command", ["protocolVersion", "requestId", "kind", "payload"]);
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		throw new ProtocolValidationError(
			"unsupported-version",
			`client command protocolVersion must be ${PROTOCOL_VERSION}`,
		);
	}
	const kind = expectEnum(record.kind, "client command.kind", CLIENT_COMMAND_KINDS);
	return {
		protocolVersion: PROTOCOL_VERSION,
		requestId: expectId(record.requestId, "client command.requestId"),
		kind,
		payload: validateClientPayload(kind, record.payload),
	} as ClientCommand;
}

export function parseClientCommand(frame: string): ClientCommand {
	return validateClientCommand(parseJsonFrame(frame, MAX_CLIENT_FRAME_BYTES, "client frame"));
}

export function encodeClientCommand(command: ClientCommand): string {
	return encodeJsonFrame(validateClientCommand(command), MAX_CLIENT_FRAME_BYTES, "client frame");
}

const NO_CONTEXT_EVENT_KINDS = new Set<ServerEventKind>(["connection.ready", "protocol.error"]);
const PROJECT_CONTEXT_EVENT_KINDS = new Set<ServerEventKind>([
	"project.snapshot",
	"project.created",
	"project.registered",
	"project.selected",
	"fs.changed",
	"fs.delete.challenge",
	"engine.state",
]);
const TURN_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.agent",
	"turn.tool",
	"turn.change",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.evidence",
	"turn.terminal",
]);
const TERMINAL_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.terminal",
	"protocol.error",
]);

function validateContext(
	kind: ServerEventKind,
	record: Record<string, unknown>,
): Pick<ServerEnvelopeBase<ServerEventKind>, "projectId" | "engineGeneration" | "sessionId" | "turnId"> {
	const hasProject = Object.hasOwn(record, "projectId");
	const hasGeneration = Object.hasOwn(record, "engineGeneration");
	const hasSession = Object.hasOwn(record, "sessionId");
	const hasTurn = Object.hasOwn(record, "turnId");

	if (NO_CONTEXT_EVENT_KINDS.has(kind)) {
		if (hasProject || hasGeneration || hasSession || hasTurn) {
			invalid(`${kind} must not carry project, engine-generation, session, or turn IDs`);
		}
		return {};
	}
	if (PROJECT_CONTEXT_EVENT_KINDS.has(kind)) {
		if (!hasProject || hasGeneration || hasSession || hasTurn) invalid(`${kind} must carry only a projectId context`);
		return { projectId: expectId(record.projectId, "server event.projectId") };
	}
	if (TURN_EVENT_KINDS.has(kind)) {
		if (!hasProject || !hasGeneration || !hasSession || !hasTurn) {
			invalid(`${kind} must carry projectId, engineGeneration, sessionId, and turnId`);
		}
		return {
			projectId: expectId(record.projectId, "server event.projectId"),
			engineGeneration: expectId(record.engineGeneration, "server event.engineGeneration"),
			sessionId: expectId(record.sessionId, "server event.sessionId"),
			turnId: expectId(record.turnId, "server event.turnId"),
		};
	}
	// command.error may be global or scoped. Context must remain hierarchical.
	if (hasGeneration) invalid(`${kind} cannot carry an engine generation`);
	if (hasTurn && !hasSession) invalid(`${kind} cannot carry turnId without sessionId`);
	if ((hasSession || hasTurn) && !hasProject) invalid(`${kind} cannot carry session/turn IDs without projectId`);
	return {
		...(hasProject ? { projectId: expectId(record.projectId, "server event.projectId") } : {}),
		...(hasSession ? { sessionId: expectId(record.sessionId, "server event.sessionId") } : {}),
		...(hasTurn ? { turnId: expectId(record.turnId, "server event.turnId") } : {}),
	};
}

export function validateServerEvent(value: unknown): ServerEvent {
	const record = expectExactKeys(
		value,
		"server event",
		["protocolVersion", "workspaceInstanceId", "sequence", "eventId", "kind", "terminal", "payload"],
		["projectId", "engineGeneration", "sessionId", "turnId"],
	);
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		throw new ProtocolValidationError(
			"unsupported-version",
			`server event protocolVersion must be ${PROTOCOL_VERSION}`,
		);
	}
	const kind = expectEnum(record.kind, "server event.kind", SERVER_EVENT_KINDS);
	const terminal = expectBoolean(record.terminal, "server event.terminal");
	if (terminal !== TERMINAL_EVENT_KINDS.has(kind)) {
		return invalid(`${kind} has an invalid terminal flag`);
	}
	const context = validateContext(kind, record);
	const payload = validateServerPayload(kind, record.payload);
	const event = {
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: expectId(record.workspaceInstanceId, "server event.workspaceInstanceId"),
		sequence: expectInteger(record.sequence, "server event.sequence", 1),
		eventId: expectId(record.eventId, "server event.eventId"),
		kind,
		...context,
		terminal,
		payload,
	} as ServerEvent;
	return event;
}

export function parseServerEvent(frame: string): ServerEvent {
	return validateServerEvent(parseJsonFrame(frame, MAX_SERVER_EVENT_BYTES, "server event frame"));
}

export function encodeServerEvent(event: ServerEvent): string {
	return encodeJsonFrame(validateServerEvent(event), MAX_SERVER_EVENT_BYTES, "server event frame");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${
		Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")
	}}`;
}

export type SequenceDisposition = "accepted" | "duplicate";

/** Enforces one contiguous event stream. Only an exact repeat of the latest event is ignored. */
export class ServerSequenceGuard {
	#nextSequence: number;
	#workspaceInstanceId: string | undefined;
	#lastFingerprint: string | undefined;
	readonly #eventIds = new Set<string>();
	readonly #maximumEvents: number;

	constructor(nextSequence = 1, maximumEvents = MAX_SERVER_EVENTS_PER_CONNECTION) {
		this.#nextSequence = expectInteger(nextSequence, "nextSequence", 1);
		this.#maximumEvents = expectInteger(maximumEvents, "maximumEvents", 1);
	}

	get nextSequence(): number {
		return this.#nextSequence;
	}

	get lastSequence(): number | undefined {
		return this.#lastFingerprint === undefined ? undefined : this.#nextSequence - 1;
	}

	get workspaceInstanceId(): string | undefined {
		return this.#workspaceInstanceId;
	}

	observe(value: unknown): SequenceDisposition {
		const event = validateServerEvent(value);
		if (this.#workspaceInstanceId !== undefined && event.workspaceInstanceId !== this.#workspaceInstanceId) {
			throw new ProtocolValidationError("sequence-error", "server event workspace instance changed mid-stream");
		}

		const fingerprint = canonicalJson(event);
		if (event.sequence === this.#nextSequence - 1 && this.#lastFingerprint !== undefined) {
			if (fingerprint === this.#lastFingerprint) return "duplicate";
			throw new ProtocolValidationError("sequence-error", `conflicting server event at sequence ${event.sequence}`);
		}
		if (event.sequence < this.#nextSequence) {
			throw new ProtocolValidationError("sequence-error", `server event sequence regressed to ${event.sequence}`);
		}
		if (event.sequence > this.#nextSequence) {
			throw new ProtocolValidationError(
				"sequence-error",
				`server event sequence gap: expected ${this.#nextSequence}, received ${event.sequence}`,
			);
		}
		if (this.#eventIds.has(event.eventId)) {
			throw new ProtocolValidationError("sequence-error", `server eventId ${event.eventId} was reused`);
		}
		if (this.#eventIds.size >= this.#maximumEvents) {
			throw new ProtocolValidationError(
				"sequence-error",
				`server event stream exceeds the ${this.#maximumEvents}-event connection limit`,
			);
		}

		this.#workspaceInstanceId = event.workspaceInstanceId;
		this.#lastFingerprint = fingerprint;
		this.#eventIds.add(event.eventId);
		this.#nextSequence += 1;
		return "accepted";
	}

	accept(value: unknown): SequenceDisposition {
		return this.observe(value);
	}

	reset(nextSequence = 1): void {
		this.#nextSequence = expectInteger(nextSequence, "nextSequence", 1);
		this.#workspaceInstanceId = undefined;
		this.#lastFingerprint = undefined;
		this.#eventIds.clear();
	}
}

export type LocalTransportState = "connecting" | "open" | "closing" | "closed";
export type DisconnectCause = "client-close" | "remote-close" | "network-error" | "protocol-error";

export interface LocalTransportDisconnect {
	readonly cause: DisconnectCause;
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
}

export interface LocalTransport {
	readonly state: LocalTransportState;
	send(command: ClientCommand): void;
	onEvent(listener: (event: ServerEvent) => void): () => void;
	onDisconnect(listener: (disconnect: LocalTransportDisconnect) => void): () => void;
	close(code?: number, reason?: string): void;
}

export interface WebSocketLocalTransportOptions {
	readonly protocols?: string | readonly string[];
	readonly expectedSequence?: number;
	readonly webSocketFactory?: (url: string, protocols?: string | string[]) => WebSocket;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (
		normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]" || normalized === "::1"
	) {
		return true;
	}
	const octets = normalized.split(".");
	return octets.length === 4 && octets[0] === "127" &&
		octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

/** Rejects remote endpoints so a local control surface cannot silently exfiltrate project data. */
export function assertLocalWebSocketUrl(value: string | URL): string {
	let url: URL;
	try {
		url = value instanceof URL ? new URL(value.href) : new URL(value);
	} catch {
		throw new TypeError("LocalTransport URL must be absolute");
	}
	if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !isLoopbackHostname(url.hostname)) {
		throw new TypeError("LocalTransport URL must use ws/wss on a loopback host");
	}
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		throw new TypeError("LocalTransport URL must not contain credentials or a fragment");
	}
	return url.href;
}

/** Browser WebSocket adapter with validation, ordering, duplicate suppression, and one-shot disconnect signaling. */
export class WebSocketLocalTransport implements LocalTransport {
	readonly #socket: WebSocket;
	readonly #sequenceGuard: ServerSequenceGuard;
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	readonly #disconnectListeners = new Set<(disconnect: LocalTransportDisconnect) => void>();
	#disconnect: LocalTransportDisconnect | undefined;
	#clientClosing = false;
	#sawNetworkError = false;

	constructor(endpoint: string | URL, options: WebSocketLocalTransportOptions = {}) {
		const url = assertLocalWebSocketUrl(endpoint);
		let protocols: string | string[] | undefined;
		if (typeof options.protocols === "string") protocols = options.protocols;
		else if (options.protocols !== undefined) protocols = [...options.protocols];
		const factory = options.webSocketFactory ??
			((socketUrl: string, socketProtocols?: string | string[]) =>
				socketProtocols === undefined ? new WebSocket(socketUrl) : new WebSocket(socketUrl, socketProtocols));
		this.#socket = factory(url, protocols);
		this.#sequenceGuard = new ServerSequenceGuard(options.expectedSequence ?? 1);

		this.#socket.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (typeof event.data !== "string") {
				this.#failProtocol("Server sent a non-text WebSocket frame");
				return;
			}
			try {
				const serverEvent = parseServerEvent(event.data);
				if (this.#sequenceGuard.observe(serverEvent) === "duplicate") return;
				for (const listener of this.#eventListeners) this.#notifyEventListener(listener, serverEvent);
			} catch (error) {
				this.#failProtocol(error instanceof Error ? error.message : "Invalid server event");
			}
		});
		this.#socket.addEventListener("error", () => {
			this.#sawNetworkError = true;
		});
		this.#socket.addEventListener("close", (event: CloseEvent) => {
			this.#signalDisconnect({
				cause: this.#clientClosing ? "client-close" : this.#sawNetworkError ? "network-error" : "remote-close",
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
			});
		});
	}

	get state(): LocalTransportState {
		switch (this.#socket.readyState) {
			case WebSocket.CONNECTING:
				return "connecting";
			case WebSocket.OPEN:
				return "open";
			case WebSocket.CLOSING:
				return "closing";
			default:
				return "closed";
		}
	}

	send(command: ClientCommand): void {
		if (this.#socket.readyState !== WebSocket.OPEN) throw new Error(`LocalTransport is ${this.state}`);
		this.#socket.send(encodeClientCommand(command));
	}

	onEvent(listener: (event: ServerEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onDisconnect(listener: (disconnect: LocalTransportDisconnect) => void): () => void {
		if (this.#disconnect !== undefined) {
			listener(this.#disconnect);
			return () => undefined;
		}
		this.#disconnectListeners.add(listener);
		return () => this.#disconnectListeners.delete(listener);
	}

	close(code = 1000, reason = "Client closed the connection"): void {
		this.#clientClosing = true;
		if (this.#socket.readyState === WebSocket.CLOSED) {
			this.#signalDisconnect({ cause: "client-close", code, reason, wasClean: true });
			return;
		}
		this.#socket.close(code, reason);
	}

	#notifyEventListener(listener: (event: ServerEvent) => void, event: ServerEvent): void {
		try {
			listener(event);
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}

	#failProtocol(reason: string): void {
		const disconnect = { cause: "protocol-error", code: 1002, reason, wasClean: false } as const;
		this.#signalDisconnect(disconnect);
		if (this.#socket.readyState === WebSocket.CONNECTING || this.#socket.readyState === WebSocket.OPEN) {
			this.#socket.close(1002, "Invalid Workbench protocol event");
		}
	}

	#signalDisconnect(disconnect: LocalTransportDisconnect): void {
		if (this.#disconnect !== undefined) return;
		this.#disconnect = disconnect;
		for (const listener of this.#disconnectListeners) {
			try {
				listener(disconnect);
			} catch (error) {
				queueMicrotask(() => {
					throw error;
				});
			}
		}
		this.#disconnectListeners.clear();
	}
}
