/**
 * Versioned, JSON-only contract between the Workbench browser and its local host.
 *
 * This module intentionally has no imports and no React dependencies. Both sides
 * use the same runtime validators. Only validated, bounded DTOs cross this
 * boundary: no native paths outside the project, no wire identifiers, no raw
 * ACP frames.
 */

export const PROTOCOL_VERSION = 3 as const;
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024;
export const MAX_SERVER_EVENT_BYTES = 256 * 1024;

const MAX_ID_BYTES = 128;
const MAX_NAME_BYTES = 128;
const MAX_PATH_DEPTH = 64;
export const MAX_NATIVE_PATH_BYTES = 4 * 1024;

const encoder = new TextEncoder();

export const CLIENT_COMMAND_KINDS = [
	"project.browse",
	"project.open",
	"project.select",
	"project.forget",
	"fs.refresh",
	"fs.create-file",
	"fs.create-folder",
	"fs.move",
	"fs.delete.prepare",
	"fs.delete.confirm",
	"session.new",
	"session.load",
	"session.close",
	"session.list",
	"session.label",
	"session.delete",
	"turn.start",
	"turn.cancel",
	"permission.resolve",
	"settings.get",
	"settings.patch",
	"config.inspect",
	"catalog.inspect",
	"targets.list",
	"targets.probe",
	"autonomy.set",
] as const;

export type ClientCommandKind = (typeof CLIENT_COMMAND_KINDS)[number];

export const CLIO_PHASES = [
	"starting",
	"unbound",
	"idle",
	"running",
	"awaiting-approval",
	"cancelling",
	"failed",
	"closed",
] as const;
export type WireClioPhase = (typeof CLIO_PHASES)[number];

export const EVENT_SOURCES = [
	"reported-by-clio",
	"observed-on-acp",
	"observed-by-workbench",
	"replayed-from-clio",
] as const;
export type WireEventSource = (typeof EVENT_SOURCES)[number];

export const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;
export type WireAutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WireThinkingLevel = (typeof THINKING_LEVELS)[number];

export const PERMISSION_DECISIONS = ["allow-once", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const PERMISSION_RESOLUTIONS = [
	"allow-once",
	"reject",
	"cancelled",
	"unanswered",
	"disconnect",
] as const;
export type PermissionResolution = (typeof PERMISSION_RESOLUTIONS)[number];

/** `open`: hosted by the live process. `closed`: Clio recorded an end. `unknown`: unended and not hosted here. */
export const SESSION_STATES = ["open", "closed", "unknown"] as const;
export type WireSessionState = (typeof SESSION_STATES)[number];

export type ProjectPath = readonly string[];

export interface ProjectBrowsePayload {
	readonly path?: string;
}

export interface ProjectOpenPayload {
	readonly path: string;
}

export interface ProjectSelectPayload {
	readonly projectId: string;
}

export interface ProjectForgetPayload {
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

export interface SessionNewPayload {
	readonly projectId: string;
}

export interface SessionLoadPayload {
	readonly projectId: string;
	readonly sessionId: string;
}

export interface SessionClosePayload {
	readonly projectId: string;
}

export interface SessionListPayload {
	readonly projectId: string;
}

export interface SessionLabelPayload {
	readonly projectId: string;
	readonly sessionId: string;
	readonly label: string;
}

export interface SessionDeletePayload {
	readonly projectId: string;
	readonly sessionId: string;
}

export interface TurnStartPayload {
	readonly projectId: string;
	readonly prompt: string;
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

export interface SettingsGetPayload {
	readonly projectId: string;
}

export type WireSettingsValue = string | null;

export type WireSettingsPatch = Readonly<
	Partial<{
		"orchestrator.target": string | null;
		"orchestrator.model": string | null;
		"orchestrator.thinkingLevel": WireThinkingLevel;
		autonomy: WireAutonomyLevel;
	}>
>;

export interface SettingsPatchPayload {
	readonly projectId: string;
	readonly patch: WireSettingsPatch;
}

export interface ConfigInspectPayload {
	readonly projectId: string;
}

export interface CatalogInspectPayload {
	readonly projectId: string;
}

export interface TargetsListPayload {
	readonly projectId: string;
}

export interface TargetsProbePayload {
	readonly projectId: string;
	readonly targetId: string;
}

export interface AutonomySetPayload {
	readonly projectId: string;
	readonly level: WireAutonomyLevel;
}

export interface ClientCommandPayloadByKind {
	readonly "project.browse": ProjectBrowsePayload;
	readonly "project.open": ProjectOpenPayload;
	readonly "project.select": ProjectSelectPayload;
	readonly "project.forget": ProjectForgetPayload;
	readonly "fs.refresh": FsRefreshPayload;
	readonly "fs.create-file": FsCreateFilePayload;
	readonly "fs.create-folder": FsCreateFolderPayload;
	readonly "fs.move": FsMovePayload;
	readonly "fs.delete.prepare": FsDeletePreparePayload;
	readonly "fs.delete.confirm": FsDeleteConfirmPayload;
	readonly "session.new": SessionNewPayload;
	readonly "session.load": SessionLoadPayload;
	readonly "session.close": SessionClosePayload;
	readonly "session.list": SessionListPayload;
	readonly "session.label": SessionLabelPayload;
	readonly "session.delete": SessionDeletePayload;
	readonly "turn.start": TurnStartPayload;
	readonly "turn.cancel": TurnCancelPayload;
	readonly "permission.resolve": PermissionResolvePayload;
	readonly "settings.get": SettingsGetPayload;
	readonly "settings.patch": SettingsPatchPayload;
	readonly "config.inspect": ConfigInspectPayload;
	readonly "catalog.inspect": CatalogInspectPayload;
	readonly "targets.list": TargetsListPayload;
	readonly "targets.probe": TargetsProbePayload;
	readonly "autonomy.set": AutonomySetPayload;
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
	"project.browse.listing",
	"project.opened",
	"project.forgotten",
	"project.snapshot",
	"fs.changed",
	"fs.delete.challenge",
	"clio.state",
	"session.list",
	"settings.state",
	"config.state",
	"catalog.state",
	"targets.state",
	"targets.probed",
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.tool",
	"turn.loop",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.terminal",
	"protocol.error",
	"command.error",
] as const;

export type ServerEventKind = (typeof SERVER_EVENT_KINDS)[number];

export type ProtocolErrorCode = "unsupported-version" | "invalid-frame" | "sequence-error" | "internal";
export const COMMAND_ERROR_CODES = [
	"invalid",
	"conflict",
	"not-found",
	"not-ready",
	"refused",
	"unsupported",
	"internal",
] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

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

/**
 * The one place a native path crosses to the renderer: the project's own root,
 * which the user typed or picked. Paths of anything else stay project-relative.
 */
export interface WireProjectSummary {
	readonly id: string;
	readonly displayName: string;
	readonly rootPath: string;
	readonly lastOpenedAt: string;
	readonly available: boolean;
}

export interface WireSessionSummary {
	readonly id: string;
	readonly label: string | null;
	readonly preview: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly turns: number;
	readonly target: string | null;
	readonly model: string | null;
	readonly state: WireSessionState;
	readonly hosted: boolean;
}

export interface WireBoundSession {
	readonly id: string;
	readonly target: string | null;
	readonly model: string | null;
	readonly autonomy: WireAutonomyLevel;
	readonly autonomySource: "settings" | "session";
	readonly resumed: boolean;
	readonly replayedTurns: number;
	readonly replayTruncated: boolean;
	readonly createdAt: string;
}

export interface WireClioCapabilities {
	readonly load: boolean;
	readonly list: boolean;
	readonly label: boolean;
	readonly delete: boolean;
	readonly autonomy: boolean;
	readonly settings: boolean;
	readonly targets: boolean;
	readonly loopBlocked: boolean;
}

export interface WireClioAgent {
	readonly name: string;
	readonly version: string;
}

export interface WireClioFailure {
	readonly code: string;
	readonly summary: string;
}

export interface WireClioSnapshot {
	readonly phase: WireClioPhase;
	readonly agent: WireClioAgent | null;
	readonly capabilities: WireClioCapabilities | null;
	readonly session: WireBoundSession | null;
	readonly lastFailure: WireClioFailure | null;
	readonly checkedAt: string;
}

export interface WireTimelineItem {
	readonly id: string;
	readonly kind:
		| "request"
		| "narrative"
		| "thought"
		| "tool"
		| "loop"
		| "approval"
		| "outcome"
		| "failure";
	readonly title: string;
	readonly summary: string;
	readonly detail?: string;
	readonly status: "queued" | "active" | "waiting" | "complete" | "canceled" | "failed" | "replayed";
	readonly turnId: string;
	readonly origin: "live" | "replay";
	readonly startedAt: string | null;
	readonly endedAt?: string;
	readonly sequence?: number;
	/** Exact terminal usage fields reported by Clio; present only on live outcome/failure cards. */
	readonly usage?: WireUsage;
	readonly source: WireEventSource;
}

export interface WirePendingPermission {
	readonly permissionId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly locations: readonly WireProjectPath[];
	readonly requestedAt: string;
	readonly escalateAt: string;
	readonly expiresAt: string;
	readonly source: WireEventSource;
}

export interface WireDeleteChallenge {
	readonly confirmationId: string;
	readonly target: WireProjectPath;
	readonly displayPath: string;
	readonly targetKind: "file" | "empty-directory";
	readonly expiresAt: string;
}

export interface WireActiveTurn {
	readonly turnId: string;
	readonly startedAt: string;
	readonly toolCalls: number;
	readonly lastToolTitle: string | null;
	readonly repeatedShapes: number;
}

export interface WireSettingsState {
	readonly settings: Readonly<Record<string, WireSettingsValue>>;
	readonly editable: readonly string[];
	readonly options: Readonly<Record<string, readonly string[]>>;
	readonly checkedAt: string;
}

export const CONFIG_SETTING_SOURCES = ["built-in", "user", "project", "project.local", "cli"] as const;
export type WireConfigSettingSource = (typeof CONFIG_SETTING_SOURCES)[number];

export const CONFIG_VALUE_KINDS = ["exact", "configured", "collection", "unset"] as const;
export type WireConfigValueKind = (typeof CONFIG_VALUE_KINDS)[number];

export const CUSTOMIZATION_CATEGORIES = [
	"settings",
	"clio-md",
	"rule",
	"operator-profile",
	"hook",
	"extension",
	"skill-root",
	"prompt-root",
	"agents",
	"safety",
	"memory",
] as const;
export type WireCustomizationCategory = (typeof CUSTOMIZATION_CATEGORIES)[number];

export const CUSTOMIZATION_TRUST = ["trusted", "untrusted", "n/a"] as const;
export type WireCustomizationTrust = (typeof CUSTOMIZATION_TRUST)[number];
export const CUSTOMIZATION_PRECEDENCE = ["winner", "loser", "single", "layer"] as const;
export type WireCustomizationPrecedence = (typeof CUSTOMIZATION_PRECEDENCE)[number];
export const CUSTOMIZATION_RELOAD_CLASSES = ["hot", "next-turn", "restart", "n/a"] as const;
export type WireCustomizationReloadClass = (typeof CUSTOMIZATION_RELOAD_CLASSES)[number];

export const MAX_WIRE_CONFIG_SETTINGS = 192;
export const MAX_WIRE_CUSTOMIZATION_ENTRIES = 256;
export const MAX_WIRE_CUSTOMIZATION_FACTS = 8;
export const MAX_WIRE_CONFIG_ISSUE_GROUPS = 16;

/** A value summary projected by the host; raw setting values never cross the boundary. */
export interface WireConfigSetting {
	readonly key: string;
	readonly source: WireConfigSettingSource;
	readonly value: string;
	readonly valueKind: WireConfigValueKind;
}

/** A host-allowlisted detail, never a generic copy of the CLI entry's `detail`. */
export interface WireCustomizationFact {
	readonly label: string;
	readonly value: string;
}

export interface WireCustomizationEntry {
	readonly category: WireCustomizationCategory;
	readonly id: string;
	readonly scope: string;
	/** Present only when the source is inside the open project; always project-relative. */
	readonly sourcePath?: WireProjectPath;
	readonly hash?: string;
	readonly trust?: WireCustomizationTrust;
	readonly precedence?: WireCustomizationPrecedence;
	readonly reloadClass: WireCustomizationReloadClass;
	readonly contextCostTokens?: number;
	readonly facts: readonly WireCustomizationFact[];
}

/** Raw CLI diagnostics stay host-side; the renderer receives counts by bounded surface only. */
export interface WireConfigIssueCount {
	readonly surface: string;
	readonly count: number;
}

export interface WireConfigInspection {
	readonly inspectedAt: string;
	readonly settings: readonly WireConfigSetting[];
	readonly settingsTruncated: boolean;
	readonly entries: readonly WireCustomizationEntry[];
	readonly entriesTruncated: boolean;
	readonly issueCounts: readonly WireConfigIssueCount[];
	readonly issuesTruncated: boolean;
}

export const CATALOG_AVAILABILITY = ["available", "failed"] as const;
export type WireCatalogAvailability = (typeof CATALOG_AVAILABILITY)[number];
export const CATALOG_AGENT_SOURCES = ["builtin", "extension", "user", "project", "custom"] as const;
export type WireCatalogAgentSource = (typeof CATALOG_AGENT_SOURCES)[number];
export const CATALOG_AGENT_AUDIENCES = ["base", "shadow", "custom", "internal"] as const;
export type WireCatalogAgentAudience = (typeof CATALOG_AGENT_AUDIENCES)[number];
export const CATALOG_AGENT_CATEGORIES = [
	"explore",
	"plan",
	"research",
	"implement",
	"quality",
	"science",
	"evolution",
	"operations",
	"internal",
] as const;
export type WireCatalogAgentCategory = (typeof CATALOG_AGENT_CATEGORIES)[number];
export const CATALOG_AGENT_CAPABILITIES = [
	"read-only",
	"artifact-write",
	"workspace-edit",
	"verification",
	"orchestration",
	"internal",
] as const;
export type WireCatalogAgentCapability = (typeof CATALOG_AGENT_CAPABILITIES)[number];
export const CATALOG_AGENT_LATENCIES = ["fast", "balanced", "deep"] as const;
export type WireCatalogAgentLatency = (typeof CATALOG_AGENT_LATENCIES)[number];
export const CATALOG_CONTEXT_TIERS = ["none", "bounded"] as const;
export type WireCatalogContextTier = (typeof CATALOG_CONTEXT_TIERS)[number];
export const CATALOG_RESOURCE_SCOPES = ["package", "user", "project", "cli"] as const;
export type WireCatalogResourceScope = (typeof CATALOG_RESOURCE_SCOPES)[number];
export const CATALOG_SKILL_SOURCES = [
	"clio",
	"agents",
	"claude",
	"codex",
	"copilot",
	"opencode",
	"extension",
	"path",
	"cli",
] as const;
export type WireCatalogSkillSource = (typeof CATALOG_SKILL_SOURCES)[number];
export const CATALOG_LIBRARY_KINDS = ["skill", "agent", "prompt", "fleet"] as const;
export type WireCatalogLibraryKind = (typeof CATALOG_LIBRARY_KINDS)[number];
export const CATALOG_LIBRARY_ORIGINS = ["catalog", "index"] as const;
export type WireCatalogLibraryOrigin = (typeof CATALOG_LIBRARY_ORIGINS)[number];
export const CATALOG_AUDIT_STATES = ["pass", "warn", "fail", "unknown", "not-reported"] as const;
export type WireCatalogAuditState = (typeof CATALOG_AUDIT_STATES)[number];

export const MAX_WIRE_CATALOG_AGENTS = 64;
export const MAX_WIRE_CATALOG_SKILLS = 64;
export const MAX_WIRE_CATALOG_LIBRARY_ENTRIES = 64;
export const MAX_WIRE_CATALOG_LABELS = 32;

export interface WireCatalogAgentBudget {
	readonly toolCalls: number;
	readonly readReserve: number;
	readonly synthesis: boolean;
	readonly maximumToolCalls: number | null;
	readonly maximumReadReserve: number | null;
}

export interface WireCatalogAgent {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: number;
	readonly source: WireCatalogAgentSource;
	readonly audience: WireCatalogAgentAudience;
	readonly category: WireCatalogAgentCategory;
	readonly capability: WireCatalogAgentCapability;
	readonly latency: WireCatalogAgentLatency;
	readonly contextTier: WireCatalogContextTier;
	readonly tags: readonly string[];
	readonly skills: readonly string[];
	readonly tools: readonly string[];
	readonly resultKind: string;
	readonly budget: WireCatalogAgentBudget;
}

export interface WireCatalogSkill {
	readonly name: string;
	readonly description: string;
	readonly scope: WireCatalogResourceScope;
	readonly source: WireCatalogSkillSource;
	readonly trusted: boolean;
	readonly precedence: number;
	readonly modelInvocable: boolean;
	readonly issueCount: number;
}

export interface WireCatalogLibraryEntry {
	readonly kind: WireCatalogLibraryKind;
	readonly name: string;
	readonly description: string;
	readonly version: string | null;
	readonly category: string | null;
	readonly origin: WireCatalogLibraryOrigin;
	readonly audit: WireCatalogAuditState;
}

export interface WireCatalogAgentCollection {
	readonly availability: WireCatalogAvailability;
	readonly items: readonly WireCatalogAgent[];
	readonly truncated: boolean;
	readonly issueCount: number;
}

export interface WireCatalogSkillCollection {
	readonly availability: WireCatalogAvailability;
	readonly items: readonly WireCatalogSkill[];
	readonly truncated: boolean;
	readonly issueCount: number;
}

export interface WireCatalogLibraryCollection {
	readonly availability: WireCatalogAvailability;
	readonly items: readonly WireCatalogLibraryEntry[];
	readonly truncated: boolean;
	readonly issueCount: number;
}

export interface WireCatalogInspection {
	readonly inspectedAt: string;
	readonly agents: WireCatalogAgentCollection;
	readonly skills: WireCatalogSkillCollection;
	readonly library: WireCatalogLibraryCollection;
	/** Clio currently offers no typed verifier listing; Workbench never scrapes its table. */
	readonly verifiers: Readonly<{ availability: "typed-interface-required" }>;
}

export interface WireTarget {
	readonly id: string;
	readonly runtime: string;
	readonly models: readonly string[];
	readonly isOrchestrator: boolean;
	readonly health: WireTargetHealth | null;
}

export interface WireTargetHealth {
	readonly healthy: boolean;
	readonly latencyMs: number | null;
	readonly reason: string | null;
	readonly probedAt: string;
}

export interface WireProjectWorkspace {
	readonly project: WireProjectSummary;
	readonly tree: readonly WireTreeNode[];
	readonly treeTruncated: boolean;
	readonly sessions: readonly WireSessionSummary[];
	readonly sessionsTruncated: boolean;
	readonly clio: WireClioSnapshot;
	readonly timeline: readonly WireTimelineItem[];
	readonly timelineTruncated: boolean;
	readonly activeTurn: WireActiveTurn | null;
	readonly pendingPermission: WirePendingPermission | null;
	readonly deleteChallenge: WireDeleteChallenge | null;
	readonly settings: WireSettingsState | null;
	readonly configInspection: WireConfigInspection | null;
	readonly catalogInspection: WireCatalogInspection | null;
	readonly targets: readonly WireTarget[] | null;
	readonly targetsTruncated: boolean;
	readonly processGeneration: string | null;
	readonly lastSequence: number;
}

export interface WireBrowseEntry {
	readonly name: string;
	readonly hidden: boolean;
	readonly guarded: boolean;
}

export interface ProjectBrowseListingPayload {
	readonly path: string;
	readonly parent: string | null;
	readonly entries: readonly WireBrowseEntry[];
	readonly truncated: boolean;
	readonly openable: boolean;
	readonly reason: string | null;
}

export interface ProjectSnapshotPayload {
	readonly tree: readonly WireTreeNode[];
	readonly treeTruncated: boolean;
}

export interface ProjectOpenedPayload {
	readonly workspace: WireProjectWorkspace;
}

export type ProjectForgottenPayload = Readonly<Record<string, never>>;

export interface FsDeleteChallengePayload extends WireDeleteChallenge {}

export interface ClioStatePayload {
	readonly snapshot: WireClioSnapshot;
}

export interface SessionListPayload_ {
	readonly sessions: readonly WireSessionSummary[];
	readonly truncated: boolean;
}

export interface SettingsStatePayload {
	readonly settings: WireSettingsState;
}

export interface ConfigStatePayload {
	readonly inspection: WireConfigInspection;
}

export interface CatalogStatePayload {
	readonly inspection: WireCatalogInspection;
}

export interface TargetsStatePayload {
	readonly targets: readonly WireTarget[];
	/** True when Clio's own byte budget dropped a target or model from the list. */
	readonly truncated: boolean;
}

export interface TargetsProbedPayload {
	readonly targetId: string;
	readonly health: WireTargetHealth;
}

export interface TurnStartedPayload {
	readonly promptSummary: string;
	readonly origin: "live" | "replay";
	readonly startedAt: string | null;
	readonly source: WireEventSource;
}

export interface TurnTextPayload {
	readonly text: string;
	readonly source: WireEventSource;
}

export interface TurnToolPayload {
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly status: "in_progress" | "completed" | "failed" | "canceled";
	readonly summary: string;
	readonly locations: readonly WireProjectPath[];
	readonly source: WireEventSource;
}

export const LOOP_DISPOSITIONS = ["block", "lockout", "stop"] as const;
export type WireLoopDisposition = (typeof LOOP_DISPOSITIONS)[number];

export interface TurnLoopPayload {
	readonly toolCallId: null;
	readonly tool: string;
	readonly repeatCount: number;
	readonly blocksThisTurn: number;
	readonly budget: number;
	readonly disposition: WireLoopDisposition;
	readonly interrupted: boolean;
	readonly shape: null;
	readonly source: WireEventSource;
}

export interface TurnPermissionRequestedPayload extends WirePendingPermission {}

export interface TurnPermissionResolvedPayload {
	readonly permissionId: string;
	readonly decision: PermissionResolution;
	readonly source: WireEventSource;
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
	readonly source: WireEventSource;
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
	readonly "project.browse.listing": ProjectBrowseListingPayload;
	readonly "project.opened": ProjectOpenedPayload;
	readonly "project.forgotten": ProjectForgottenPayload;
	readonly "project.snapshot": ProjectSnapshotPayload;
	readonly "fs.changed": ProjectSnapshotPayload;
	readonly "fs.delete.challenge": FsDeleteChallengePayload;
	readonly "clio.state": ClioStatePayload;
	readonly "session.list": SessionListPayload_;
	readonly "settings.state": SettingsStatePayload;
	readonly "config.state": ConfigStatePayload;
	readonly "catalog.state": CatalogStatePayload;
	readonly "targets.state": TargetsStatePayload;
	readonly "targets.probed": TargetsProbedPayload;
	readonly "turn.started": TurnStartedPayload;
	readonly "turn.text": TurnTextPayload;
	readonly "turn.thought": TurnTextPayload;
	readonly "turn.tool": TurnToolPayload;
	readonly "turn.loop": TurnLoopPayload;
	readonly "turn.permission.requested": TurnPermissionRequestedPayload;
	readonly "turn.permission.resolved": TurnPermissionResolvedPayload;
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
	readonly processGeneration?: string;
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

function expectEntryName(value: unknown, label: string): string {
	// Real directory listings contain names with surrounding whitespace; the
	// picker shows them but never trims them.
	const name = expectString(value, label, { minBytes: 1, maxBytes: 255, noControls: true });
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

/** An absolute native path the user typed, pasted, or picked. Never a project-relative segment list. */
export function expectNativePath(value: unknown, label: string): string {
	const path = expectString(value, label, {
		minBytes: 1,
		maxBytes: MAX_NATIVE_PATH_BYTES,
		trim: true,
		noControls: true,
	});
	if (path.includes("\0")) return invalid(`${label} contains a null byte`);
	if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) return invalid(`${label} must be absolute`);
	return path;
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

const MAX_SETTINGS_KEYS = 32;
const MAX_SETTINGS_KEY_BYTES = 64;
const MAX_SETTINGS_VALUE_BYTES = 256;

function expectSettingsKey(value: string, label: string): string {
	const key = expectString(value, label, {
		minBytes: 1,
		maxBytes: MAX_SETTINGS_KEY_BYTES,
		trim: true,
		noControls: true,
	});
	if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/u.test(key)) return invalid(`${label} is not a valid settings key`);
	return key;
}

function expectSettingsValue(value: unknown, label: string): WireSettingsValue {
	if (value === null) return null;
	return expectString(value, label, { minBytes: 0, maxBytes: MAX_SETTINGS_VALUE_BYTES, trim: true, noControls: true });
}

function expectSettingsRecord(value: unknown, label: string): Readonly<Record<string, WireSettingsValue>> {
	const record = expectRecord(value, label);
	const keys = Object.keys(record);
	if (keys.length > MAX_SETTINGS_KEYS) return invalid(`${label} has too many keys`);
	const result: Record<string, WireSettingsValue> = {};
	for (const key of keys) {
		result[expectSettingsKey(key, `${label} key`)] = expectSettingsValue(record[key], `${label}.${key}`);
	}
	return result;
}

function expectSettingsPatch(value: unknown, label: string): WireSettingsPatch {
	const record = expectRecord(value, label);
	const keys = Object.keys(record);
	if (keys.length === 0) return invalid(`${label} must not be empty`);
	const result: {
		"orchestrator.target"?: string | null;
		"orchestrator.model"?: string | null;
		"orchestrator.thinkingLevel"?: WireThinkingLevel;
		autonomy?: WireAutonomyLevel;
	} = {};
	for (const key of keys) {
		switch (key) {
			case "orchestrator.target":
			case "orchestrator.model":
				result[key] = record[key] === null ? null : expectString(record[key], `${label}.${key}`, {
					minBytes: 1,
					maxBytes: key === "orchestrator.target" ? 128 : 256,
					trim: true,
					noControls: true,
				});
				break;
			case "orchestrator.thinkingLevel":
				result[key] = expectEnum(record[key], `${label}.${key}`, THINKING_LEVELS);
				break;
			case "autonomy":
				result[key] = expectEnum(record[key], `${label}.${key}`, AUTONOMY_LEVELS);
				break;
			default:
				return invalid(`${label} contains an unsupported setting`);
		}
	}
	return result;
}

function validateClientPayload<K extends ClientCommandKind>(kind: K, value: unknown): ClientCommandPayloadByKind[K] {
	const label = `${kind} payload`;
	switch (kind) {
		case "project.browse": {
			const record = expectExactKeys(value, label, [], ["path"]);
			const path = Object.hasOwn(record, "path") ? expectNativePath(record.path, `${label}.path`) : undefined;
			return { ...(path === undefined ? {} : { path }) } as ClientCommandPayloadByKind[K];
		}
		case "project.open": {
			const record = expectExactKeys(value, label, ["path"]);
			return { path: expectNativePath(record.path, `${label}.path`) } as ClientCommandPayloadByKind[K];
		}
		case "project.select":
		case "project.forget":
		case "session.new":
		case "session.close":
		case "session.list":
		case "settings.get":
		case "config.inspect":
		case "catalog.inspect":
		case "targets.list": {
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
		case "fs.create-file":
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
		case "session.load":
		case "session.delete": {
			const record = expectExactKeys(value, label, ["projectId", "sessionId"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				sessionId: expectId(record.sessionId, `${label}.sessionId`),
			} as ClientCommandPayloadByKind[K];
		}
		case "session.label": {
			const record = expectExactKeys(value, label, ["projectId", "sessionId", "label"]);
			const labelText = expectString(record.label, `${label}.label`, {
				minBytes: 0,
				maxBytes: 256,
				trim: true,
				noControls: true,
			});
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				sessionId: expectId(record.sessionId, `${label}.sessionId`),
				label: labelText,
			} as ClientCommandPayloadByKind[K];
		}
		case "turn.start": {
			const record = expectExactKeys(value, label, ["projectId", "prompt"]);
			const prompt = expectString(record.prompt, `${label}.prompt`, {
				minBytes: 1,
				maxBytes: 8 * 1024,
				trim: true,
			});
			if (prompt.includes("\0")) invalid(`${label}.prompt contains a null character`);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				prompt,
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
		case "settings.patch": {
			const record = expectExactKeys(value, label, ["projectId", "patch"]);
			const patch = expectSettingsPatch(record.patch, `${label}.patch`);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				patch,
			} as ClientCommandPayloadByKind[K];
		}
		case "targets.probe": {
			const record = expectExactKeys(value, label, ["projectId", "targetId"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				targetId: expectOpaqueString(record.targetId, `${label}.targetId`, 128),
			} as ClientCommandPayloadByKind[K];
		}
		case "autonomy.set": {
			const record = expectExactKeys(value, label, ["projectId", "level"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				level: expectEnum(record.level, `${label}.level`, AUTONOMY_LEVELS),
			} as ClientCommandPayloadByKind[K];
		}
	}
}

export const MAX_WIRE_COLLECTION_ENTRIES = 512;
export const MAX_WIRE_TIMELINE_ENTRIES = 1_024;
export const MAX_WIRE_BROWSE_ENTRIES = 512;
const MAX_WIRE_TREE_NODES = 512;
const MAX_SERVER_EVENTS_PER_CONNECTION = 64 * 1024;

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

function expectNullablePresentationText(value: unknown, label: string, maximumBytes = 4 * 1024): string | null {
	return value === null ? null : expectPresentationText(value, label, maximumBytes);
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

function validateEventSource(value: unknown, label: string): WireEventSource {
	return expectEnum(value, label, EVENT_SOURCES);
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

function validateWireProjectSummary(value: unknown, label: string): WireProjectSummary {
	const record = expectExactKeys(value, label, ["id", "displayName", "rootPath", "lastOpenedAt", "available"]);
	return {
		id: expectId(record.id, `${label}.id`),
		displayName: expectDisplayName(record.displayName, `${label}.displayName`),
		rootPath: expectNativePath(record.rootPath, `${label}.rootPath`),
		lastOpenedAt: expectTimestamp(record.lastOpenedAt, `${label}.lastOpenedAt`),
		available: expectBoolean(record.available, `${label}.available`),
	};
}

function validateWireSessionSummary(value: unknown, label: string): WireSessionSummary {
	const record = expectExactKeys(value, label, [
		"id",
		"label",
		"preview",
		"createdAt",
		"updatedAt",
		"turns",
		"target",
		"model",
		"state",
		"hosted",
	]);
	return {
		id: expectId(record.id, `${label}.id`),
		label: expectNullablePresentationText(record.label, `${label}.label`, 256),
		preview: expectString(record.preview, `${label}.preview`, { minBytes: 0, maxBytes: 512, noControls: true }),
		createdAt: expectTimestamp(record.createdAt, `${label}.createdAt`),
		updatedAt: expectTimestamp(record.updatedAt, `${label}.updatedAt`),
		turns: expectInteger(record.turns, `${label}.turns`),
		target: expectNullablePresentationText(record.target, `${label}.target`, 128),
		model: expectNullablePresentationText(record.model, `${label}.model`, 256),
		state: expectEnum(record.state, `${label}.state`, SESSION_STATES),
		hosted: expectBoolean(record.hosted, `${label}.hosted`),
	};
}

function validateBoundSession(value: unknown, label: string): WireBoundSession {
	const record = expectExactKeys(value, label, [
		"id",
		"target",
		"model",
		"autonomy",
		"autonomySource",
		"resumed",
		"replayedTurns",
		"replayTruncated",
		"createdAt",
	]);
	return {
		id: expectId(record.id, `${label}.id`),
		target: expectNullablePresentationText(record.target, `${label}.target`, 128),
		model: expectNullablePresentationText(record.model, `${label}.model`, 256),
		autonomy: expectEnum(record.autonomy, `${label}.autonomy`, AUTONOMY_LEVELS),
		autonomySource: expectEnum(record.autonomySource, `${label}.autonomySource`, ["settings", "session"] as const),
		resumed: expectBoolean(record.resumed, `${label}.resumed`),
		replayedTurns: expectInteger(record.replayedTurns, `${label}.replayedTurns`),
		replayTruncated: expectBoolean(record.replayTruncated, `${label}.replayTruncated`),
		createdAt: expectTimestamp(record.createdAt, `${label}.createdAt`),
	};
}

const CAPABILITY_KEYS = ["load", "list", "label", "delete", "autonomy", "settings", "targets", "loopBlocked"] as const;

function validateCapabilities(value: unknown, label: string): WireClioCapabilities {
	const record = expectExactKeys(value, label, CAPABILITY_KEYS);
	const result: Record<string, boolean> = {};
	for (const key of CAPABILITY_KEYS) result[key] = expectBoolean(record[key], `${label}.${key}`);
	return result as unknown as WireClioCapabilities;
}

function validateClioSnapshot(value: unknown, label: string): WireClioSnapshot {
	const record = expectExactKeys(value, label, [
		"phase",
		"agent",
		"capabilities",
		"session",
		"lastFailure",
		"checkedAt",
	]);
	let agent: WireClioAgent | null = null;
	if (record.agent !== null) {
		const agentRecord = expectExactKeys(record.agent, `${label}.agent`, ["name", "version"]);
		agent = {
			name: expectPresentationText(agentRecord.name, `${label}.agent.name`, 128),
			version: expectPresentationText(agentRecord.version, `${label}.agent.version`, 128),
		};
	}
	let lastFailure: WireClioFailure | null = null;
	if (record.lastFailure !== null) {
		const failure = expectExactKeys(record.lastFailure, `${label}.lastFailure`, ["code", "summary"]);
		lastFailure = {
			code: expectId(failure.code, `${label}.lastFailure.code`),
			summary: expectSanitizedMessage(failure.summary, `${label}.lastFailure.summary`),
		};
	}
	return {
		phase: expectEnum(record.phase, `${label}.phase`, CLIO_PHASES),
		agent,
		capabilities: record.capabilities === null
			? null
			: validateCapabilities(record.capabilities, `${label}.capabilities`),
		session: record.session === null ? null : validateBoundSession(record.session, `${label}.session`),
		lastFailure,
		checkedAt: expectTimestamp(record.checkedAt, `${label}.checkedAt`),
	};
}

function validateWireTimelineItem(value: unknown, label: string): WireTimelineItem {
	const record = expectExactKeys(
		value,
		label,
		["id", "kind", "title", "summary", "status", "turnId", "origin", "startedAt", "source"],
		["detail", "sequence", "endedAt", "usage"],
	);
	const detail = Object.hasOwn(record, "detail") ? expectPresentationText(record.detail, `${label}.detail`) : undefined;
	const sequence = Object.hasOwn(record, "sequence")
		? expectInteger(record.sequence, `${label}.sequence`, 1)
		: undefined;
	const endedAt = Object.hasOwn(record, "endedAt") ? expectTimestamp(record.endedAt, `${label}.endedAt`) : undefined;
	const usage = Object.hasOwn(record, "usage") ? validateUsage(record.usage, `${label}.usage`) : undefined;
	const kind = expectEnum(
		record.kind,
		`${label}.kind`,
		["request", "narrative", "thought", "tool", "loop", "approval", "outcome", "failure"] as const,
	);
	const status = expectEnum(
		record.status,
		`${label}.status`,
		["queued", "active", "waiting", "complete", "canceled", "failed", "replayed"] as const,
	);
	const origin = expectEnum(record.origin, `${label}.origin`, ["live", "replay"] as const);
	const startedAt = record.startedAt === null ? null : expectTimestamp(record.startedAt, `${label}.startedAt`);
	const source = validateEventSource(record.source, `${label}.source`);
	if (usage !== undefined && kind !== "outcome" && kind !== "failure") {
		invalid(`${label}.usage is valid only for a terminal outcome or failure`);
	}
	if (origin === "replay") {
		if (startedAt !== null) invalid(`${label}.startedAt must be null for replay history`);
		if (endedAt !== undefined) invalid(`${label}.endedAt must be omitted for replay history`);
		if (source !== "replayed-from-clio") invalid(`${label}.source must identify replay history`);
		if (kind === "outcome" || kind === "failure") invalid(`${label}.kind cannot claim a replay outcome`);
		if (status !== "replayed" && !(kind === "tool" && ["complete", "canceled", "failed"].includes(status))) {
			invalid(`${label}.status must stay neutral unless a replayed tool supplied its terminal status`);
		}
	} else {
		if (startedAt === null) invalid(`${label}.startedAt must identify when a live item began`);
		if (source === "replayed-from-clio") invalid(`${label}.source cannot identify live activity as replay history`);
		if (status === "replayed") invalid(`${label}.status cannot identify live activity as replay history`);
	}
	return {
		id: expectId(record.id, `${label}.id`),
		kind,
		title: expectPresentationText(record.title, `${label}.title`, 512),
		summary: expectString(record.summary, `${label}.summary`, { minBytes: 0, maxBytes: 64 * 1024 + 64 }),
		...(detail === undefined ? {} : { detail }),
		status,
		turnId: expectId(record.turnId, `${label}.turnId`),
		origin,
		startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		...(sequence === undefined ? {} : { sequence }),
		...(usage === undefined ? {} : { usage }),
		source,
	};
}

function validateWirePendingPermission(value: unknown, label: string): WirePendingPermission {
	const record = expectExactKeys(value, label, [
		"permissionId",
		"toolCallId",
		"title",
		"kind",
		"locations",
		"requestedAt",
		"escalateAt",
		"expiresAt",
		"source",
	]);
	return {
		permissionId: expectId(record.permissionId, `${label}.permissionId`),
		toolCallId: expectId(record.toolCallId, `${label}.toolCallId`),
		title: expectPresentationText(record.title, `${label}.title`, 512),
		kind: expectPresentationText(record.kind, `${label}.kind`, 64),
		locations: validateLocations(record.locations, `${label}.locations`),
		requestedAt: expectTimestamp(record.requestedAt, `${label}.requestedAt`),
		escalateAt: expectTimestamp(record.escalateAt, `${label}.escalateAt`),
		expiresAt: expectTimestamp(record.expiresAt, `${label}.expiresAt`),
		source: validateEventSource(record.source, `${label}.source`),
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

function validateActiveTurn(value: unknown, label: string): WireActiveTurn {
	const record = expectExactKeys(value, label, ["turnId", "startedAt", "toolCalls", "lastToolTitle", "repeatedShapes"]);
	return {
		turnId: expectId(record.turnId, `${label}.turnId`),
		startedAt: expectTimestamp(record.startedAt, `${label}.startedAt`),
		toolCalls: expectInteger(record.toolCalls, `${label}.toolCalls`),
		lastToolTitle: expectNullablePresentationText(record.lastToolTitle, `${label}.lastToolTitle`, 512),
		repeatedShapes: expectInteger(record.repeatedShapes, `${label}.repeatedShapes`),
	};
}

function validateSettingsState(value: unknown, label: string): WireSettingsState {
	const record = expectExactKeys(value, label, ["settings", "editable", "options", "checkedAt"]);
	const settings = expectSettingsRecord(record.settings, `${label}.settings`);
	const editable = expectArray(
		record.editable,
		`${label}.editable`,
		MAX_SETTINGS_KEYS,
		(entry, entryLabel) => expectSettingsKey(entry as string, entryLabel),
	);
	const optionsRecord = expectRecord(record.options, `${label}.options`);
	const options: Record<string, readonly string[]> = {};
	const optionKeys = Object.keys(optionsRecord);
	if (optionKeys.length > MAX_SETTINGS_KEYS) invalid(`${label}.options has too many keys`);
	for (const key of optionKeys) {
		options[expectSettingsKey(key, `${label}.options key`)] = expectArray(
			optionsRecord[key],
			`${label}.options.${key}`,
			256,
			(entry, entryLabel) => expectPresentationText(entry, entryLabel, MAX_SETTINGS_VALUE_BYTES),
		);
	}
	return { settings, editable, options, checkedAt: expectTimestamp(record.checkedAt, `${label}.checkedAt`) };
}

function expectConfigText(value: unknown, label: string, maximumBytes: number): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: maximumBytes,
		trim: true,
		noControls: true,
	});
}

function validateConfigSetting(value: unknown, label: string): WireConfigSetting {
	const record = expectExactKeys(value, label, ["key", "source", "value", "valueKind"]);
	return {
		key: expectConfigText(record.key, `${label}.key`, 256),
		source: expectEnum(record.source, `${label}.source`, CONFIG_SETTING_SOURCES),
		value: expectConfigText(record.value, `${label}.value`, 256),
		valueKind: expectEnum(record.valueKind, `${label}.valueKind`, CONFIG_VALUE_KINDS),
	};
}

function validateCustomizationFact(value: unknown, label: string): WireCustomizationFact {
	const record = expectExactKeys(value, label, ["label", "value"]);
	return {
		label: expectConfigText(record.label, `${label}.label`, 64),
		value: expectConfigText(record.value, `${label}.value`, 256),
	};
}

function validateCustomizationEntry(value: unknown, label: string): WireCustomizationEntry {
	const record = expectExactKeys(
		value,
		label,
		["category", "id", "scope", "reloadClass", "facts"],
		["sourcePath", "hash", "trust", "precedence", "contextCostTokens"],
	);
	const sourcePath = Object.hasOwn(record, "sourcePath")
		? validateWireProjectPath(record.sourcePath, `${label}.sourcePath`)
		: undefined;
	let hash: string | undefined;
	if (Object.hasOwn(record, "hash")) {
		hash = expectConfigText(record.hash, `${label}.hash`, 128);
		if (!/^[A-Fa-f0-9]{4,128}$/u.test(hash)) invalid(`${label}.hash must be hexadecimal`);
	}
	const trust = Object.hasOwn(record, "trust")
		? expectEnum(record.trust, `${label}.trust`, CUSTOMIZATION_TRUST)
		: undefined;
	const precedence = Object.hasOwn(record, "precedence")
		? expectEnum(record.precedence, `${label}.precedence`, CUSTOMIZATION_PRECEDENCE)
		: undefined;
	const contextCostTokens = Object.hasOwn(record, "contextCostTokens")
		? expectInteger(record.contextCostTokens, `${label}.contextCostTokens`)
		: undefined;
	return {
		category: expectEnum(record.category, `${label}.category`, CUSTOMIZATION_CATEGORIES),
		id: expectConfigText(record.id, `${label}.id`, 256),
		scope: expectConfigText(record.scope, `${label}.scope`, 128),
		...(sourcePath === undefined ? {} : { sourcePath }),
		...(hash === undefined ? {} : { hash }),
		...(trust === undefined ? {} : { trust }),
		...(precedence === undefined ? {} : { precedence }),
		reloadClass: expectEnum(record.reloadClass, `${label}.reloadClass`, CUSTOMIZATION_RELOAD_CLASSES),
		...(contextCostTokens === undefined ? {} : { contextCostTokens }),
		facts: expectArray(
			record.facts,
			`${label}.facts`,
			MAX_WIRE_CUSTOMIZATION_FACTS,
			validateCustomizationFact,
		),
	};
}

function validateConfigIssueCount(value: unknown, label: string): WireConfigIssueCount {
	const record = expectExactKeys(value, label, ["surface", "count"]);
	return {
		surface: expectConfigText(record.surface, `${label}.surface`, 64),
		count: expectInteger(record.count, `${label}.count`, 1),
	};
}

function validateConfigInspection(value: unknown, label: string): WireConfigInspection {
	const record = expectExactKeys(value, label, [
		"inspectedAt",
		"settings",
		"settingsTruncated",
		"entries",
		"entriesTruncated",
		"issueCounts",
		"issuesTruncated",
	]);
	return {
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		settings: expectArray(
			record.settings,
			`${label}.settings`,
			MAX_WIRE_CONFIG_SETTINGS,
			validateConfigSetting,
		),
		settingsTruncated: expectBoolean(record.settingsTruncated, `${label}.settingsTruncated`),
		entries: expectArray(
			record.entries,
			`${label}.entries`,
			MAX_WIRE_CUSTOMIZATION_ENTRIES,
			validateCustomizationEntry,
		),
		entriesTruncated: expectBoolean(record.entriesTruncated, `${label}.entriesTruncated`),
		issueCounts: expectArray(
			record.issueCounts,
			`${label}.issueCounts`,
			MAX_WIRE_CONFIG_ISSUE_GROUPS,
			validateConfigIssueCount,
		),
		issuesTruncated: expectBoolean(record.issuesTruncated, `${label}.issuesTruncated`),
	};
}

function expectCatalogCount(value: unknown, label: string): number {
	const count = expectInteger(value, label);
	if (count > 1_000_000) invalid(`${label} exceeds the catalog numeric bound`);
	return count;
}

function validateCatalogLabels(value: unknown, label: string): readonly string[] {
	return expectArray(
		value,
		label,
		MAX_WIRE_CATALOG_LABELS,
		(entry, entryLabel) => expectPresentationText(entry, entryLabel, 64),
	);
}

function validateCatalogAgentBudget(value: unknown, label: string): WireCatalogAgentBudget {
	const record = expectExactKeys(value, label, [
		"toolCalls",
		"readReserve",
		"synthesis",
		"maximumToolCalls",
		"maximumReadReserve",
	]);
	return {
		toolCalls: expectCatalogCount(record.toolCalls, `${label}.toolCalls`),
		readReserve: expectCatalogCount(record.readReserve, `${label}.readReserve`),
		synthesis: expectBoolean(record.synthesis, `${label}.synthesis`),
		maximumToolCalls: record.maximumToolCalls === null
			? null
			: expectCatalogCount(record.maximumToolCalls, `${label}.maximumToolCalls`),
		maximumReadReserve: record.maximumReadReserve === null
			? null
			: expectCatalogCount(record.maximumReadReserve, `${label}.maximumReadReserve`),
	};
}

function validateCatalogAgent(value: unknown, label: string): WireCatalogAgent {
	const record = expectExactKeys(value, label, [
		"id",
		"name",
		"description",
		"version",
		"source",
		"audience",
		"category",
		"capability",
		"latency",
		"contextTier",
		"tags",
		"skills",
		"tools",
		"resultKind",
		"budget",
	]);
	return {
		id: expectPresentationText(record.id, `${label}.id`, 128),
		name: expectPresentationText(record.name, `${label}.name`, 128),
		description: expectPresentationText(record.description, `${label}.description`, 512),
		version: expectCatalogCount(record.version, `${label}.version`),
		source: expectEnum(record.source, `${label}.source`, CATALOG_AGENT_SOURCES),
		audience: expectEnum(record.audience, `${label}.audience`, CATALOG_AGENT_AUDIENCES),
		category: expectEnum(record.category, `${label}.category`, CATALOG_AGENT_CATEGORIES),
		capability: expectEnum(record.capability, `${label}.capability`, CATALOG_AGENT_CAPABILITIES),
		latency: expectEnum(record.latency, `${label}.latency`, CATALOG_AGENT_LATENCIES),
		contextTier: expectEnum(record.contextTier, `${label}.contextTier`, CATALOG_CONTEXT_TIERS),
		tags: validateCatalogLabels(record.tags, `${label}.tags`),
		skills: validateCatalogLabels(record.skills, `${label}.skills`),
		tools: validateCatalogLabels(record.tools, `${label}.tools`),
		resultKind: expectPresentationText(record.resultKind, `${label}.resultKind`, 128),
		budget: validateCatalogAgentBudget(record.budget, `${label}.budget`),
	};
}

function validateCatalogSkill(value: unknown, label: string): WireCatalogSkill {
	const record = expectExactKeys(value, label, [
		"name",
		"description",
		"scope",
		"source",
		"trusted",
		"precedence",
		"modelInvocable",
		"issueCount",
	]);
	return {
		name: expectPresentationText(record.name, `${label}.name`, 128),
		description: expectPresentationText(record.description, `${label}.description`, 512),
		scope: expectEnum(record.scope, `${label}.scope`, CATALOG_RESOURCE_SCOPES),
		source: expectEnum(record.source, `${label}.source`, CATALOG_SKILL_SOURCES),
		trusted: expectBoolean(record.trusted, `${label}.trusted`),
		precedence: expectCatalogCount(record.precedence, `${label}.precedence`),
		modelInvocable: expectBoolean(record.modelInvocable, `${label}.modelInvocable`),
		issueCount: expectCatalogCount(record.issueCount, `${label}.issueCount`),
	};
}

function validateCatalogLibraryEntry(value: unknown, label: string): WireCatalogLibraryEntry {
	const record = expectExactKeys(value, label, [
		"kind",
		"name",
		"description",
		"version",
		"category",
		"origin",
		"audit",
	]);
	return {
		kind: expectEnum(record.kind, `${label}.kind`, CATALOG_LIBRARY_KINDS),
		name: expectPresentationText(record.name, `${label}.name`, 128),
		description: expectPresentationText(record.description, `${label}.description`, 512),
		version: expectNullablePresentationText(record.version, `${label}.version`, 64),
		category: expectNullablePresentationText(record.category, `${label}.category`, 64),
		origin: expectEnum(record.origin, `${label}.origin`, CATALOG_LIBRARY_ORIGINS),
		audit: expectEnum(record.audit, `${label}.audit`, CATALOG_AUDIT_STATES),
	};
}

function validateCatalogCollection<T>(
	value: unknown,
	label: string,
	maximum: number,
	validateItem: (entry: unknown, label: string) => T,
): { availability: WireCatalogAvailability; items: readonly T[]; truncated: boolean; issueCount: number } {
	const record = expectExactKeys(value, label, ["availability", "items", "truncated", "issueCount"]);
	const availability = expectEnum(record.availability, `${label}.availability`, CATALOG_AVAILABILITY);
	const items = expectArray(record.items, `${label}.items`, maximum, validateItem);
	if (availability === "failed" && items.length > 0) invalid(`${label} cannot carry items when its adapter failed`);
	return {
		availability,
		items,
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
		issueCount: expectCatalogCount(record.issueCount, `${label}.issueCount`),
	};
}

function validateCatalogInspection(value: unknown, label: string): WireCatalogInspection {
	const record = expectExactKeys(value, label, ["inspectedAt", "agents", "skills", "library", "verifiers"]);
	const verifiers = expectExactKeys(record.verifiers, `${label}.verifiers`, ["availability"]);
	if (verifiers.availability !== "typed-interface-required") {
		invalid(`${label}.verifiers.availability must be typed-interface-required`);
	}
	return {
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		agents: validateCatalogCollection(
			record.agents,
			`${label}.agents`,
			MAX_WIRE_CATALOG_AGENTS,
			validateCatalogAgent,
		),
		skills: validateCatalogCollection(
			record.skills,
			`${label}.skills`,
			MAX_WIRE_CATALOG_SKILLS,
			validateCatalogSkill,
		),
		library: validateCatalogCollection(
			record.library,
			`${label}.library`,
			MAX_WIRE_CATALOG_LIBRARY_ENTRIES,
			validateCatalogLibraryEntry,
		),
		verifiers: { availability: "typed-interface-required" },
	};
}

function validateTargetHealth(value: unknown, label: string): WireTargetHealth {
	const record = expectExactKeys(value, label, ["healthy", "latencyMs", "reason", "probedAt"]);
	return {
		healthy: expectBoolean(record.healthy, `${label}.healthy`),
		latencyMs: record.latencyMs === null ? null : expectInteger(record.latencyMs, `${label}.latencyMs`),
		reason: expectNullablePresentationText(record.reason, `${label}.reason`, 128),
		probedAt: expectTimestamp(record.probedAt, `${label}.probedAt`),
	};
}

function validateTarget(value: unknown, label: string): WireTarget {
	const record = expectExactKeys(value, label, ["id", "runtime", "models", "isOrchestrator", "health"]);
	return {
		id: expectPresentationText(record.id, `${label}.id`, 128),
		runtime: expectPresentationText(record.runtime, `${label}.runtime`, 64),
		models: expectArray(
			record.models,
			`${label}.models`,
			64,
			(entry, entryLabel) => expectPresentationText(entry, entryLabel, 256),
		),
		isOrchestrator: expectBoolean(record.isOrchestrator, `${label}.isOrchestrator`),
		health: record.health === null ? null : validateTargetHealth(record.health, `${label}.health`),
	};
}

function validateTargets(value: unknown, label: string): readonly WireTarget[] {
	return expectArray(value, label, 64, validateTarget);
}

function validateWireWorkspace(value: unknown, label: string): WireProjectWorkspace {
	const record = expectExactKeys(value, label, [
		"project",
		"tree",
		"treeTruncated",
		"sessions",
		"sessionsTruncated",
		"clio",
		"timeline",
		"timelineTruncated",
		"activeTurn",
		"pendingPermission",
		"deleteChallenge",
		"settings",
		"configInspection",
		"catalogInspection",
		"targets",
		"targetsTruncated",
		"processGeneration",
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
		sessionsTruncated: expectBoolean(record.sessionsTruncated, `${label}.sessionsTruncated`),
		clio: validateClioSnapshot(record.clio, `${label}.clio`),
		timeline: expectArray(record.timeline, `${label}.timeline`, MAX_WIRE_TIMELINE_ENTRIES, validateWireTimelineItem),
		timelineTruncated: expectBoolean(record.timelineTruncated, `${label}.timelineTruncated`),
		activeTurn: record.activeTurn === null ? null : validateActiveTurn(record.activeTurn, `${label}.activeTurn`),
		pendingPermission: record.pendingPermission === null
			? null
			: validateWirePendingPermission(record.pendingPermission, `${label}.pendingPermission`),
		deleteChallenge: record.deleteChallenge === null
			? null
			: validateWireDeleteChallenge(record.deleteChallenge, `${label}.deleteChallenge`),
		settings: record.settings === null ? null : validateSettingsState(record.settings, `${label}.settings`),
		configInspection: record.configInspection === null
			? null
			: validateConfigInspection(record.configInspection, `${label}.configInspection`),
		catalogInspection: record.catalogInspection === null
			? null
			: validateCatalogInspection(record.catalogInspection, `${label}.catalogInspection`),
		targets: record.targets === null ? null : validateTargets(record.targets, `${label}.targets`),
		targetsTruncated: expectBoolean(record.targetsTruncated, `${label}.targetsTruncated`),
		processGeneration: expectNullableId(record.processGeneration, `${label}.processGeneration`),
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

function validateBrowseListing(value: unknown, label: string): ProjectBrowseListingPayload {
	const record = expectExactKeys(value, label, ["path", "parent", "entries", "truncated", "openable", "reason"]);
	return {
		path: expectNativePath(record.path, `${label}.path`),
		parent: record.parent === null ? null : expectNativePath(record.parent, `${label}.parent`),
		entries: expectArray(record.entries, `${label}.entries`, MAX_WIRE_BROWSE_ENTRIES, (entry, entryLabel) => {
			const entryRecord = expectExactKeys(entry, entryLabel, ["name", "hidden", "guarded"]);
			return {
				name: expectEntryName(entryRecord.name, `${entryLabel}.name`),
				hidden: expectBoolean(entryRecord.hidden, `${entryLabel}.hidden`),
				guarded: expectBoolean(entryRecord.guarded, `${entryLabel}.guarded`),
			};
		}),
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
		openable: expectBoolean(record.openable, `${label}.openable`),
		reason: expectNullablePresentationText(record.reason, `${label}.reason`, 512),
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
		case "project.forgotten":
			return expectExactKeys(value, label, []) as ConnectionReadyPayload;
		case "project.browse.listing":
			return validateBrowseListing(value, label);
		case "project.snapshot":
		case "fs.changed":
			return validateProjectSnapshotPayload(value, label);
		case "project.opened": {
			const record = expectExactKeys(value, label, ["workspace"]);
			return { workspace: validateWireWorkspace(record.workspace, `${label}.workspace`) };
		}
		case "fs.delete.challenge":
			return validateWireDeleteChallenge(value, label);
		case "clio.state": {
			const record = expectExactKeys(value, label, ["snapshot"]);
			return { snapshot: validateClioSnapshot(record.snapshot, `${label}.snapshot`) };
		}
		case "session.list": {
			const record = expectExactKeys(value, label, ["sessions", "truncated"]);
			return {
				sessions: expectArray(
					record.sessions,
					`${label}.sessions`,
					MAX_WIRE_COLLECTION_ENTRIES,
					validateWireSessionSummary,
				),
				truncated: expectBoolean(record.truncated, `${label}.truncated`),
			};
		}
		case "settings.state": {
			const record = expectExactKeys(value, label, ["settings"]);
			return { settings: validateSettingsState(record.settings, `${label}.settings`) };
		}
		case "config.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return { inspection: validateConfigInspection(record.inspection, `${label}.inspection`) };
		}
		case "catalog.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return { inspection: validateCatalogInspection(record.inspection, `${label}.inspection`) };
		}
		case "targets.state": {
			const record = expectExactKeys(value, label, ["targets", "truncated"]);
			return {
				targets: validateTargets(record.targets, `${label}.targets`),
				truncated: expectBoolean(record.truncated, `${label}.truncated`),
			};
		}
		case "targets.probed": {
			const record = expectExactKeys(value, label, ["targetId", "health"]);
			return {
				targetId: expectPresentationText(record.targetId, `${label}.targetId`, 128),
				health: validateTargetHealth(record.health, `${label}.health`),
			};
		}
		case "turn.started": {
			const record = expectExactKeys(value, label, ["promptSummary", "origin", "startedAt", "source"]);
			const origin = expectEnum(record.origin, `${label}.origin`, ["live", "replay"] as const);
			const startedAt = record.startedAt === null ? null : expectTimestamp(record.startedAt, `${label}.startedAt`);
			const source = validateEventSource(record.source, `${label}.source`);
			if (origin === "replay") {
				if (startedAt !== null) invalid(`${label}.startedAt must be null for replay history`);
				if (source !== "replayed-from-clio") invalid(`${label}.source must identify replay history`);
			} else {
				if (startedAt === null) invalid(`${label}.startedAt must identify when a live turn began`);
				if (source === "replayed-from-clio") invalid(`${label}.source cannot identify a live turn as replay history`);
			}
			return {
				promptSummary: expectPresentationText(record.promptSummary, `${label}.promptSummary`, 8 * 1024),
				origin,
				startedAt,
				source,
			};
		}
		case "turn.text":
		case "turn.thought": {
			const record = expectExactKeys(value, label, ["text", "source"]);
			return {
				text: expectStreamText(record.text, `${label}.text`),
				source: validateEventSource(record.source, `${label}.source`),
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
				source: validateEventSource(record.source, `${label}.source`),
			};
		}
		case "turn.loop": {
			const record = expectExactKeys(value, label, [
				"toolCallId",
				"tool",
				"repeatCount",
				"blocksThisTurn",
				"budget",
				"disposition",
				"interrupted",
				"shape",
				"source",
			]);
			if (record.toolCallId !== null) invalid(`${label}.toolCallId must be null for event version 1`);
			if (record.shape !== null) invalid(`${label}.shape must be null for event version 1`);
			return {
				toolCallId: null,
				tool: expectPresentationText(record.tool, `${label}.tool`, 64),
				repeatCount: expectInteger(record.repeatCount, `${label}.repeatCount`),
				blocksThisTurn: expectInteger(record.blocksThisTurn, `${label}.blocksThisTurn`),
				budget: expectInteger(record.budget, `${label}.budget`),
				disposition: expectEnum(record.disposition, `${label}.disposition`, LOOP_DISPOSITIONS),
				interrupted: expectBoolean(record.interrupted, `${label}.interrupted`),
				shape: null,
				source: validateEventSource(record.source, `${label}.source`),
			};
		}
		case "turn.permission.requested":
			return validateWirePendingPermission(value, label);
		case "turn.permission.resolved": {
			const record = expectExactKeys(value, label, ["permissionId", "decision", "source"]);
			return {
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				decision: expectEnum(record.decision, `${label}.decision`, PERMISSION_RESOLUTIONS),
				source: validateEventSource(record.source, `${label}.source`),
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
				source: validateEventSource(record.source, `${label}.source`),
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
				code: expectEnum(record.code, `${label}.code`, COMMAND_ERROR_CODES),
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

const NO_CONTEXT_EVENT_KINDS = new Set<ServerEventKind>([
	"connection.ready",
	"protocol.error",
	"project.browse.listing",
]);
const PROJECT_CONTEXT_EVENT_KINDS = new Set<ServerEventKind>([
	"project.opened",
	"project.forgotten",
	"project.snapshot",
	"fs.changed",
	"fs.delete.challenge",
	"clio.state",
	"session.list",
	"settings.state",
	"config.state",
	"catalog.state",
	"targets.state",
	"targets.probed",
]);
const TURN_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.started",
	"turn.text",
	"turn.thought",
	"turn.tool",
	"turn.loop",
	"turn.permission.requested",
	"turn.permission.resolved",
	"turn.terminal",
]);
const TERMINAL_EVENT_KINDS = new Set<ServerEventKind>([
	"turn.terminal",
	"protocol.error",
]);

export function isTurnEventKind(kind: ServerEventKind): boolean {
	return TURN_EVENT_KINDS.has(kind);
}

function validateContext(
	kind: ServerEventKind,
	record: Record<string, unknown>,
): Pick<ServerEnvelopeBase<ServerEventKind>, "projectId" | "processGeneration" | "sessionId" | "turnId"> {
	const hasProject = Object.hasOwn(record, "projectId");
	const hasGeneration = Object.hasOwn(record, "processGeneration");
	const hasSession = Object.hasOwn(record, "sessionId");
	const hasTurn = Object.hasOwn(record, "turnId");

	if (NO_CONTEXT_EVENT_KINDS.has(kind)) {
		if (hasProject || hasGeneration || hasSession || hasTurn) {
			invalid(`${kind} must not carry project, process-generation, session, or turn IDs`);
		}
		return {};
	}
	if (PROJECT_CONTEXT_EVENT_KINDS.has(kind)) {
		if (!hasProject || hasGeneration || hasSession || hasTurn) invalid(`${kind} must carry only a projectId context`);
		return { projectId: expectId(record.projectId, "server event.projectId") };
	}
	if (TURN_EVENT_KINDS.has(kind)) {
		if (!hasProject || !hasGeneration || !hasSession || !hasTurn) {
			invalid(`${kind} must carry projectId, processGeneration, sessionId, and turnId`);
		}
		return {
			projectId: expectId(record.projectId, "server event.projectId"),
			processGeneration: expectId(record.processGeneration, "server event.processGeneration"),
			sessionId: expectId(record.sessionId, "server event.sessionId"),
			turnId: expectId(record.turnId, "server event.turnId"),
		};
	}
	// command.error may be global or scoped. Context must remain hierarchical.
	if (hasGeneration) invalid(`${kind} cannot carry a process generation`);
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
		["projectId", "processGeneration", "sessionId", "turnId"],
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
