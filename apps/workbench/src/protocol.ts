/**
 * Versioned, JSON-only contract between the Clio Coder GUI and its local host.
 *
 * This module intentionally has no imports and no React dependencies. Both sides
 * use the same runtime validators. Only validated, bounded DTOs cross this
 * boundary: no native paths outside the project, no wire identifiers, no raw
 * ACP frames.
 */

export const PROTOCOL_VERSION = 4 as const;
export const PRODUCT_NAME = "Clio Coder" as const;
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
	"usage.inspect",
	"routing.inspect",
	"dispatch.inspect",
	"fleet.inspect",
	"toolchain.inspect",
	"trace.inspect",
	"evidence.inspect",
	"evidence.read",
	"fleet.verify",
	"recovery.inspect",
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

export const AUTONOMY_LEVELS = [
	"read-only",
	"suggest",
	"auto-edit",
	"full-auto",
] as const;
export type WireAutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
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

/** `open`: hosted by the live process. `closed`: Clio Coder recorded an end. `unknown`: unended and not hosted here. */
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

export interface UsageInspectPayload {
	readonly projectId: string;
}

export interface RoutingInspectPayload {
	readonly projectId: string;
}

export type DispatchInspectPayload = Readonly<Record<string, never>>;

export type FleetInspectPayload = Readonly<Record<string, never>>;

export type ToolchainInspectPayload = Readonly<Record<string, never>>;

export type TraceInspectPayload = Readonly<Record<string, never>>;

export type EvidenceInspectPayload = Readonly<Record<string, never>>;

/**
 * The only command shape that names a durable artifact.
 *
 * The id must be one the host served in its current evidence window; the host
 * enforces that, and this validation only ensures the frame carries an
 * identifier rather than a path, a flag, or a traversal.
 */
export interface EvidenceReadPayload {
	readonly evidenceId: string;
}

/** The second and last command that names a durable artifact. Same rule. */
export interface FleetVerifyPayload {
	readonly runId: string;
}

export type RecoveryInspectPayload = Readonly<Record<string, never>>;

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
	readonly "usage.inspect": UsageInspectPayload;
	readonly "routing.inspect": RoutingInspectPayload;
	readonly "dispatch.inspect": DispatchInspectPayload;
	readonly "fleet.inspect": FleetInspectPayload;
	readonly "toolchain.inspect": ToolchainInspectPayload;
	readonly "trace.inspect": TraceInspectPayload;
	readonly "evidence.inspect": EvidenceInspectPayload;
	readonly "evidence.read": EvidenceReadPayload;
	readonly "fleet.verify": FleetVerifyPayload;
	readonly "recovery.inspect": RecoveryInspectPayload;
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
	"usage.state",
	"routing.state",
	"dispatch.state",
	"fleet.inspection.state",
	"toolchain.state",
	"trace.state",
	"evidence.state",
	"evidence.detail.state",
	"fleet.verification.state",
	"recovery.state",
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
	"fleet.activity",
	"protocol.error",
	"command.error",
] as const;

export type ServerEventKind = (typeof SERVER_EVENT_KINDS)[number];

export type ProtocolErrorCode =
	| "unsupported-version"
	| "invalid-frame"
	| "sequence-error"
	| "internal";
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
	/** Clio Coder advertised the dispatch lifecycle on its opt-in event stream. */
	readonly dispatchEvents: boolean;
	/** Clio Coder advertised per-frame agent attribution on its session updates. */
	readonly agentAttribution: boolean;
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
	readonly status:
		| "queued"
		| "active"
		| "waiting"
		| "complete"
		| "canceled"
		| "failed"
		| "replayed";
	readonly turnId: string;
	readonly origin: "live" | "replay";
	readonly startedAt: string | null;
	readonly endedAt?: string;
	readonly sequence?: number;
	/** Exact terminal usage fields reported by Clio Coder; present only on live outcome/failure cards. */
	readonly usage?: WireUsage;
	/** Who produced this card, when Clio Coder reported an identity for it. */
	readonly agents?: readonly WireAgentAttribution[];
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

export const CONFIG_SETTING_SOURCES = [
	"built-in",
	"user",
	"project",
	"project.local",
	"cli",
] as const;
export type WireConfigSettingSource = (typeof CONFIG_SETTING_SOURCES)[number];

export const CONFIG_VALUE_KINDS = [
	"exact",
	"configured",
	"collection",
	"unset",
] as const;
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
export const CUSTOMIZATION_PRECEDENCE = [
	"winner",
	"loser",
	"single",
	"layer",
] as const;
export type WireCustomizationPrecedence = (typeof CUSTOMIZATION_PRECEDENCE)[number];
export const CUSTOMIZATION_RELOAD_CLASSES = [
	"hot",
	"next-turn",
	"restart",
	"n/a",
] as const;
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
export const CATALOG_AGENT_SOURCES = [
	"builtin",
	"extension",
	"user",
	"project",
	"custom",
] as const;
export type WireCatalogAgentSource = (typeof CATALOG_AGENT_SOURCES)[number];
export const CATALOG_AGENT_AUDIENCES = [
	"base",
	"shadow",
	"custom",
	"internal",
] as const;
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
export const CATALOG_RESOURCE_SCOPES = [
	"package",
	"user",
	"project",
	"cli",
] as const;
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
export const CATALOG_LIBRARY_KINDS = [
	"skill",
	"agent",
	"prompt",
	"fleet",
] as const;
export type WireCatalogLibraryKind = (typeof CATALOG_LIBRARY_KINDS)[number];
export const CATALOG_LIBRARY_ORIGINS = ["catalog", "index"] as const;
export type WireCatalogLibraryOrigin = (typeof CATALOG_LIBRARY_ORIGINS)[number];
export const CATALOG_AUDIT_STATES = [
	"pass",
	"warn",
	"fail",
	"unknown",
	"not-reported",
] as const;
export type WireCatalogAuditState = (typeof CATALOG_AUDIT_STATES)[number];
export const CATALOG_EXTENSION_SCOPES = ["user", "project"] as const;
export type WireCatalogExtensionScope = (typeof CATALOG_EXTENSION_SCOPES)[number];
export const CATALOG_EXTENSION_RESOURCE_KINDS = [
	"skills",
	"prompts",
	"agents",
	"fleets",
	"themes",
] as const;
export type WireCatalogExtensionResourceKind = (typeof CATALOG_EXTENSION_RESOURCE_KINDS)[number];

export const MAX_WIRE_CATALOG_AGENTS = 64;
export const MAX_WIRE_CATALOG_SKILLS = 64;
export const MAX_WIRE_CATALOG_LIBRARY_ENTRIES = 64;
export const MAX_WIRE_CATALOG_EXTENSIONS = 64;
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

export interface WireCatalogExtension {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly scope: WireCatalogExtensionScope;
	readonly enabled: boolean;
	readonly effective: boolean;
	readonly overriddenBy: WireCatalogExtensionScope | null;
	/** Resource kinds only. Their native roots never cross the protocol. */
	readonly resources: readonly WireCatalogExtensionResourceKind[];
	readonly issueCount: number;
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

export interface WireCatalogExtensionCollection {
	readonly availability: WireCatalogAvailability;
	readonly items: readonly WireCatalogExtension[];
	readonly truncated: boolean;
	readonly issueCount: number;
}

export interface WireCatalogInspection {
	readonly inspectedAt: string;
	readonly agents: WireCatalogAgentCollection;
	readonly skills: WireCatalogSkillCollection;
	readonly library: WireCatalogLibraryCollection;
	readonly extensions: WireCatalogExtensionCollection;
	/** Clio Coder currently offers no typed verifier listing; the GUI never scrapes its table. */
	readonly verifiers: Readonly<{ availability: "typed-interface-required" }>;
}

export const USAGE_STORE_STATES = ["available", "missing"] as const;
export type WireUsageStoreState = (typeof USAGE_STORE_STATES)[number];
export const USAGE_OPPORTUNITY_KINDS = [
	"workflow-distiller",
	"recipe",
] as const;
export type WireUsageOpportunityKind = (typeof USAGE_OPPORTUNITY_KINDS)[number];
export const MAX_WIRE_USAGE_MODELS = 32;
export const MAX_WIRE_USAGE_TOOLS = 16;
export const MAX_WIRE_USAGE_SKILLS = 64;
export const MAX_WIRE_USAGE_RECIPES = 64;

/** Exact aggregate fields reported by Clio Coder's project-filtered usage reader. */
export interface WireHistoricalUsageTotals {
	readonly apiCalls: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly totalTokens: number;
	readonly costUsd: number;
	readonly turns: number | null;
	readonly sideQuestions: number;
	readonly handoffs: number;
}

export interface WireUsageModel {
	readonly provider: string;
	readonly model: string;
	readonly apiCalls: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
	readonly totalTokens: number;
	readonly costUsd: number;
}

export interface WireUsageTool {
	readonly name: string;
	readonly calls: number;
	readonly successful: number;
	readonly errors: number;
	readonly blocked: number;
}

export interface WireUsageSkill {
	readonly name: string;
	readonly activations: number;
	readonly observedInWindow: boolean;
}

export interface WireUsageRecipe {
	readonly agentId: string;
	readonly runs: number;
}

export interface WireUsageOpportunityCount {
	readonly kind: WireUsageOpportunityKind;
	readonly count: number;
}

export interface WireUsageInspection {
	readonly inspectedAt: string;
	readonly schema: "experimental";
	readonly windowDays: 30;
	readonly windowFrom: string;
	readonly windowTo: string;
	readonly stores: Readonly<{
		sessions: WireUsageStoreState;
		dispatchReceipts: WireUsageStoreState;
	}>;
	readonly sessionCount: number | null;
	readonly dispatchRunCount: number | null;
	readonly totals: WireHistoricalUsageTotals | null;
	readonly models: readonly WireUsageModel[];
	readonly modelsTruncated: boolean;
	readonly tools: readonly WireUsageTool[];
	readonly toolsTruncated: boolean;
	readonly skills: readonly WireUsageSkill[];
	readonly skillsTruncated: boolean;
	readonly recipes: readonly WireUsageRecipe[];
	readonly recipesTruncated: boolean;
	readonly opportunities: readonly WireUsageOpportunityCount[];
}

export const ROUTING_AVAILABILITY = ["available", "failed"] as const;
export type WireRoutingAvailability = (typeof ROUTING_AVAILABILITY)[number];
export const ROUTING_MODEL_CAPABILITIES = [
	"chat",
	"tools",
	"reasoning",
	"vision",
	"embeddings",
	"rerank",
	"fim",
] as const;
export type WireRoutingModelCapability = (typeof ROUTING_MODEL_CAPABILITIES)[number];
export const ROUTING_MODEL_RESIDENCIES = [
	"loaded",
	"loading",
	"unloaded",
	"unknown",
	"not-reported",
] as const;
export type WireRoutingModelResidency = (typeof ROUTING_MODEL_RESIDENCIES)[number];
export const MAX_WIRE_ROUTING_MODELS = 256;
export const MAX_WIRE_ROUTING_PROFILES = 64;
export const MAX_WIRE_ROUTING_BINDINGS = 128;

/** Offline model facts projected from Clio Coder's own catalog and cached discovery. */
export interface WireRoutingModel {
	readonly targetId: string;
	readonly runtimeId: string;
	readonly modelId: string;
	readonly capabilities: readonly WireRoutingModelCapability[];
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly residency: WireRoutingModelResidency;
}

export interface WireRoutingProfile {
	readonly name: string;
	readonly target: string | null;
	readonly runtime: string | null;
	readonly model: string | null;
	readonly thinkingLevel: WireThinkingLevel;
}

export interface WireRoutingBinding {
	readonly agentId: string;
	readonly profile: string;
	readonly target: string | null;
	readonly model: string | null;
	readonly resolved: boolean;
}

export interface WireRoutingModelCollection {
	readonly availability: WireRoutingAvailability;
	readonly items: readonly WireRoutingModel[];
	readonly truncated: boolean;
	/** Clio Coder's explicit `(no models)` rows, normalized without presenting the sentinel as a model id. */
	readonly emptyTargetCount: number;
}

export interface WireRoutingProfileCollection {
	readonly availability: WireRoutingAvailability;
	readonly items: readonly WireRoutingProfile[];
	readonly truncated: boolean;
}

export interface WireRoutingBindingCollection {
	readonly availability: WireRoutingAvailability;
	readonly items: readonly WireRoutingBinding[];
	readonly truncated: boolean;
}

export interface WireRoutingInspection {
	readonly inspectedAt: string;
	readonly models: WireRoutingModelCollection;
	readonly profiles: WireRoutingProfileCollection;
	readonly bindings: WireRoutingBindingCollection;
}

export const DISPATCH_ADMISSION_STATES = ["open", "draining"] as const;
export type WireDispatchAdmissionState = (typeof DISPATCH_ADMISSION_STATES)[number];

/** Bounded aggregate of Clio Coder's durable, installation-wide dispatch ledger. */
export interface WireDispatchInspection {
	readonly scope: "installation";
	/** When the GUI completed its bounded projection. */
	readonly inspectedAt: string;
	/** When Clio Coder read the durable ledger. */
	readonly generatedAt: string;
	readonly admission: Readonly<{
		state: WireDispatchAdmissionState;
		expiresAt: string | null;
	}>;
	readonly running: Readonly<{
		total: number;
		alive: number;
		stale: number;
		dead: number;
		unreported: number;
	}>;
	readonly retryingCount: number;
	readonly totals: Readonly<{
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsd: number;
		runtimeSeconds: number;
	}>;
}

export const FLEET_JOURNAL_STATES = ["available", "missing"] as const;
export type WireFleetJournalState = (typeof FLEET_JOURNAL_STATES)[number];
export const FLEET_EVIDENCE_STATES = [
	"pending",
	"verified",
	"failed",
	"unavailable",
] as const;
export type WireFleetEvidenceState = (typeof FLEET_EVIDENCE_STATES)[number];
export const MAX_WIRE_FLEET_INSPECTION_RUNS = 8;
export const MAX_WIRE_FLEET_INSPECTION_EVENTS = 32;
export const MAX_WIRE_FLEET_INSPECTION_ROOTS = 4;
export const MAX_WIRE_FLEET_INSPECTION_STEPS = 24;

export interface WireFleetInspectionEvent {
	readonly at: string;
	readonly label: string;
	readonly detail: string | null;
}

export interface WireFleetInspectionRun {
	readonly runId: string;
	readonly agentId: string;
	readonly model: string;
	readonly target: string;
	readonly node: string;
	readonly phase: string;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly task: string | null;
	readonly journal: WireFleetJournalState;
	readonly events: readonly WireFleetInspectionEvent[];
	readonly eventsTruncated: boolean;
	readonly evidence: Readonly<{
		state: WireFleetEvidenceState;
		summary: string;
	}>;
	readonly outcome: string | null;
	readonly outcomeDetail: string | null;
	readonly terminal: boolean;
}

export interface WireFleetInspectionStep {
	readonly stepId: string;
	/** The run the step terminated on, or null when the step never ran. */
	readonly runId: string | null;
	readonly agentId: string | null;
	readonly outcome: string;
	readonly detail: string | null;
}

/**
 * One fleet root's planned step index.
 *
 * A root owns no ledger row, receipt, or journal, so this is deliberately not a
 * transcript and carries no evidence of its own. Its `steps[].runId` points at
 * the run window in the same inspection, which is what lets the GUI say which
 * fleet a recent run belongs to instead of listing runs with no lineage.
 */
export interface WireFleetInspectionRoot {
	readonly rootId: string;
	readonly fleet: string;
	readonly startedAt: string;
	readonly elapsedMs: number;
	readonly running: boolean;
	readonly resumedFrom: string | null;
	readonly plannedSteps: number;
	readonly recordedSteps: number;
	readonly steps: readonly WireFleetInspectionStep[];
	readonly stepsTruncated: boolean;
}

/** Bounded newest-first run window selected by Clio Coder, never by browser argv. */
export interface WireFleetInspection {
	readonly scope: "installation";
	readonly inspectedAt: string;
	readonly generatedAt: string;
	readonly runs: readonly WireFleetInspectionRun[];
	readonly truncated: boolean;
	readonly roots: readonly WireFleetInspectionRoot[];
	readonly rootsTruncated: boolean;
}

export const EVIDENCE_SOURCE_KINDS = ["run", "session", "eval"] as const;
export type WireEvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];
export const EVIDENCE_TRUST_VERDICTS = [
	"reviewed",
	"grounded",
	"unverified",
	"compromised",
	"unknown",
] as const;
export type WireEvidenceTrustVerdict = (typeof EVIDENCE_TRUST_VERDICTS)[number];
export const MAX_WIRE_EVIDENCE_ARTIFACTS = 12;
export const MAX_WIRE_EVIDENCE_IDS = 8;

/**
 * One durable evidence bundle, as shape and trust rather than content.
 *
 * The underlying overview also carries the task text the operator typed, the
 * working directories its runs executed in, and the file names inside the
 * bundle. None of that crosses. `runIds` does, because it is what lets the GUI
 * say which of the runs it already lists a bundle was built from.
 */
export interface WireEvidenceArtifact {
	readonly evidenceId: string;
	readonly sourceKind: WireEvidenceSourceKind;
	readonly generatedAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly runIds: readonly string[];
	readonly runIdsTruncated: boolean;
	readonly agentIds: readonly string[];
	readonly statuses: readonly string[];
	readonly tags: readonly string[];
	readonly totals: Readonly<{
		runs: number;
		receipts: number;
		toolCalls: number;
		toolErrors: number;
		blockedToolCalls: number;
		protectedArtifacts: number;
		tokens: number;
		costUsd: number;
		wallTimeMs: number;
	}>;
	/** Secret-shaped values the builder replaced across the bundle's exports. */
	readonly redactionCount: number;
	readonly trust: Readonly<{
		verdict: WireEvidenceTrustVerdict;
		runsCovered: number;
		/** True when the bundle predates the canonical trust projection. */
		historical: boolean;
	}>;
}

/** Bounded newest-first evidence window selected by Clio Coder, never by browser argv. */
export interface WireEvidenceInspection {
	readonly scope: "installation";
	readonly inspectedAt: string;
	readonly generatedAt: string;
	readonly artifacts: readonly WireEvidenceArtifact[];
	readonly truncated: boolean;
}

export const EVIDENCE_AXES = [
	"artifactIntegrity",
	"validationGrounding",
	"independentReview",
	"contextProvenance",
	"autonomyEnforcement",
	"completionEvidence",
] as const;
export type WireEvidenceAxis = (typeof EVIDENCE_AXES)[number];

/** Each axis owns its own closed state set; a state legal on one is not legal on all. */
export const EVIDENCE_AXIS_STATES = {
	artifactIntegrity: ["verified", "failed", "absent", "unknown", "not_applicable"],
	validationGrounding: ["validated", "failed", "ungrounded", "absent", "unknown", "not_applicable"],
	independentReview: ["passed", "failed", "inconclusive", "not_independent", "absent", "unknown", "not_applicable"],
	contextProvenance: ["recorded", "invalid", "absent", "unknown", "not_applicable"],
	autonomyEnforcement: ["enforced", "approximated", "bypassed", "absent", "unknown", "not_applicable"],
	completionEvidence: ["evidenced", "incomplete", "limited", "absent", "unknown", "not_applicable"],
} as const satisfies Record<WireEvidenceAxis, ReadonlyArray<string>>;

export const MAX_WIRE_EVIDENCE_DETAIL_RUNS = 16;

export interface WireEvidenceDetailRun {
	readonly runId: string;
	readonly verdict: WireEvidenceTrustVerdict;
	/** Always all six axes, so an unrecorded axis is stated rather than missing. */
	readonly axes: Readonly<Record<WireEvidenceAxis, string>>;
}

/**
 * One bundle's trust record, read by an id the host itself served.
 *
 * Every value is drawn from a closed vocabulary the harness owns, which is what
 * lets this answer the question the inventory raises without carrying any of
 * the prose, paths, or file names the inventory deliberately dropped.
 */
export interface WireEvidenceDetail {
	readonly evidenceId: string;
	readonly sourceKind: WireEvidenceSourceKind;
	readonly inspectedAt: string;
	readonly generatedAt: string;
	/** False when the bundle predates the canonical trust projection. */
	readonly canonical: boolean;
	readonly runs: readonly WireEvidenceDetailRun[];
	readonly runsTruncated: boolean;
}

export const FLEET_VERIFY_STATES = ["pending", "verified", "failed", "unavailable"] as const;
export type WireFleetVerifyState = (typeof FLEET_VERIFY_STATES)[number];

/**
 * Why a receipt did not authenticate, classified rather than quoted.
 *
 * The harness builds some of these by interpolating a thrown message or a field
 * name, so the reason arrives as a member of this set and never as prose.
 */
export const FLEET_VERIFY_REASONS = [
	"integrity-mismatch",
	"ledger-mismatch",
	"integrity-invalid",
	"execution-role-invalid",
	"routing-intent-invalid",
	"route-decision-invalid",
	"receipt-unreadable",
	"envelope-unavailable",
	"unclassified",
] as const;
export type WireFleetVerifyReason = (typeof FLEET_VERIFY_REASONS)[number];

/**
 * One receipt re-authenticated on demand.
 *
 * `fleet.inspection.state` reports trust as of the snapshot. This reports it as
 * of `verifiedAt`, which is the only way to learn that a receipt trusted when
 * the window was read no longer verifies against the bytes on disk.
 */
export interface WireFleetVerification {
	readonly runId: string;
	readonly verifiedAt: string;
	readonly state: WireFleetVerifyState;
	readonly reason: WireFleetVerifyReason | null;
	readonly axes: Readonly<Record<WireEvidenceAxis, string>>;
}

export const MAX_WIRE_TRACE_RUNS = 8;
export const MAX_WIRE_TRACE_PHASES = 16;

export interface WireTracePhase {
	readonly name: string;
	readonly kind: string;
	readonly owner: string;
	readonly status: string;
	readonly attempt: number;
	readonly retries: number;
	/** Whether the phase recorded an error, without the error text itself. */
	readonly failed: boolean;
	readonly elapsedMs: number | null;
	readonly totalTokens: number | null;
	readonly totalCostUsd: number | null;
}

export interface WireTraceRun {
	readonly runId: string;
	readonly agent: string;
	readonly target: string;
	readonly model: string;
	readonly runtime: string;
	readonly node: string | null;
	readonly status: string;
	readonly startedAt: string;
	readonly elapsedMs: number | null;
	readonly totalTokens: number | null;
	readonly totalCostUsd: number | null;
	readonly phases: readonly WireTracePhase[];
	readonly phasesTruncated: boolean;
}

/**
 * Where a durable run's wall time and tokens went, from the trace database.
 *
 * Deliberately accounting only. The trace store also holds the request text an
 * operator typed, per-phase descriptions, and error prose that can quote a
 * path, a URL, or a model reply; none of it crosses. `available` is false on an
 * installation whose trace database was never written, which is a different
 * fact from a database that holds no runs.
 */
export interface WireTraceInspection {
	readonly scope: "installation";
	readonly inspectedAt: string;
	readonly generatedAt: string;
	readonly available: boolean;
	readonly runs: readonly WireTraceRun[];
	readonly truncated: boolean;
}

export const TOOLCHAIN_SOURCES = ["path", "vendored", "none"] as const;
export type WireToolchainSource = (typeof TOOLCHAIN_SOURCES)[number];
export const MAX_WIRE_TOOLCHAIN_ITEMS = 32;

export interface WireToolchainItem {
	readonly id: string;
	readonly pinnedVersion: string;
	readonly license: string;
	readonly platform: string | null;
	readonly supported: boolean;
	readonly installed: boolean;
	readonly source: WireToolchainSource;
	readonly foundVersion: string | null;
	readonly minimumVersion: string;
	readonly pathCandidate:
		| Readonly<{
			version: string | null;
			satisfiesMinimum: boolean;
		}>
		| null;
}

/** Path-free inventory of Clio Coder's pinned optional external programs. */
export interface WireToolchainInspection {
	readonly scope: "installation";
	readonly inspectedAt: string;
	readonly tools: readonly WireToolchainItem[];
	readonly truncated: boolean;
}

export const RECOVERY_SECTION_IDS = [
	"runtime",
	"storage",
	"configuration",
	"history",
	"models",
	"interoperability",
	"toolchain",
	"panes",
	"fleet",
	"other",
] as const;
export type WireRecoverySectionId = (typeof RECOVERY_SECTION_IDS)[number];

export const RECOVERY_CHECK_LEVELS = ["ok", "warn", "error"] as const;
export type WireRecoveryCheckLevel = (typeof RECOVERY_CHECK_LEVELS)[number];
export const MAX_WIRE_RECOVERY_CHECKS = 128;

/**
 * One diagnostic check's identity and verdict, without its detail.
 *
 * A doctor finding's detail is free prose that routinely quotes native paths,
 * endpoint URLs, socket paths, model ids, and session ids, so no detail crosses
 * this boundary. The name does, because a name is either a fixed check label or
 * that label plus the subject it ran against, which is what turns "one models
 * check failed" into something an operator can act on. A name that does not
 * hold to that safe shape arrives as null rather than failing the whole sweep.
 */
export interface WireRecoveryCheck {
	readonly name: string | null;
	readonly section: WireRecoverySectionId;
	readonly level: WireRecoveryCheckLevel;
}

/**
 * The safe shape for a diagnostic check name.
 *
 * Structural rather than a fixed vocabulary, so a harness that adds a check or
 * renames one does not break the sweep. At most five space-separated tokens of
 * word characters, dots, plus, and dashes: enough for `Clio Coder version`,
 * `settings.yaml`, `model blade-gateway`, and `external tool herdr`, and not
 * enough for any of the slashes, colons, quotes, or parentheses that every
 * native path, URL, and prose detail in a doctor report contains.
 */
const RECOVERY_CHECK_NAME = /^[A-Za-z0-9][\w.+-]{0,63}(?: [A-Za-z0-9][\w.+-]{0,63}){0,4}$/u;

/** True when a doctor check name may cross to the browser intact. */
export function isSafeRecoveryCheckName(value: string): boolean {
	return value.length <= 96 && RECOVERY_CHECK_NAME.test(value);
}

export interface WireRecoveryCounts {
	readonly checks: number;
	readonly passed: number;
	readonly warnings: number;
	readonly failures: number;
}

export interface WireRecoverySection extends WireRecoveryCounts {
	readonly id: WireRecoverySectionId;
}

/** Redacted aggregate of the fixed Clio Coder `doctor` and `paths` reports. */
export interface WireRecoveryInspection {
	readonly scope: "installation";
	/** Whether project-aware checks used the selected project's trusted root. */
	readonly projectContext: boolean;
	readonly inspectedAt: string;
	readonly healthy: boolean;
	/** Exact fixed path categories resolved; the native values never cross the host. */
	readonly pathsResolved: number;
	readonly versions: Readonly<{
		clioCoder: string | null;
		node: string | null;
		platform: string | null;
	}>;
	readonly summary: WireRecoveryCounts;
	readonly sections: readonly WireRecoverySection[];
	readonly checks: readonly WireRecoveryCheck[];
	readonly checksTruncated: boolean;
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
	readonly usageInspection: WireUsageInspection | null;
	readonly routingInspection: WireRoutingInspection | null;
	readonly targets: readonly WireTarget[] | null;
	readonly targetsTruncated: boolean;
	/** Dispatch runs the host has observed on this session, oldest first. */
	readonly fleet: readonly WireFleetRun[];
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

export interface UsageStatePayload {
	readonly inspection: WireUsageInspection;
}

export interface RoutingStatePayload {
	readonly inspection: WireRoutingInspection;
}

export interface DispatchStatePayload {
	readonly inspection: WireDispatchInspection;
}

export interface FleetInspectionStatePayload {
	readonly inspection: WireFleetInspection;
}

export interface ToolchainStatePayload {
	readonly inspection: WireToolchainInspection;
}

export interface TraceStatePayload {
	readonly inspection: WireTraceInspection;
}

export interface EvidenceStatePayload {
	readonly inspection: WireEvidenceInspection;
}

export interface EvidenceDetailStatePayload {
	readonly detail: WireEvidenceDetail;
}

export interface FleetVerificationStatePayload {
	readonly verification: WireFleetVerification;
}

export interface RecoveryStatePayload {
	readonly inspection: WireRecoveryInspection;
}

export interface TargetsStatePayload {
	readonly targets: readonly WireTarget[];
	/** True when Clio Coder's own byte budget dropped a target or model from the list. */
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

/**
 * Where a frame's identity came from. `orchestrator` is the main Clio Coder
 * agent that owns the session; `worker` is a delegated agent Clio Coder
 * reported starting under a specific tool call. Nothing here is inferred from
 * tool titles or timing: an unattributed frame carries an empty list.
 */
export const AGENT_ROLES = ["orchestrator", "worker"] as const;
export type WireAgentRole = (typeof AGENT_ROLES)[number];

export interface WireAgentAttribution {
	readonly role: WireAgentRole;
	readonly agentId: string;
	/** Dispatch run this agent is executing; null for the orchestrator. */
	readonly runId: string | null;
	/** Fleet node the run was placed on; null renders as the local node. */
	readonly node: string | null;
}

/** Orchestrator plus the per-tool-call worker cap Clio Coder enforces. */
export const MAX_WIRE_AGENT_ATTRIBUTIONS = 17;

export interface TurnTextPayload {
	readonly text: string;
	/** Who produced this text, most general first. Empty when identity did not cross. */
	readonly agents: readonly WireAgentAttribution[];
	readonly source: WireEventSource;
}

export interface TurnToolPayload {
	readonly toolCallId: string;
	readonly title: string;
	readonly kind: string;
	readonly status: "in_progress" | "completed" | "failed" | "canceled";
	readonly summary: string;
	readonly locations: readonly WireProjectPath[];
	/** Who ran this call, most general first. Empty when identity did not cross. */
	readonly agents: readonly WireAgentAttribution[];
	readonly source: WireEventSource;
}

/**
 * Presentation state of one dispatch run. `progress` is not a phase of its own:
 * it is a running run that has reported activity, kept distinct so a strip can
 * show that a run is doing work rather than merely admitted.
 */
export const FLEET_RUN_STATES = [
	"queued",
	"running",
	"progress",
	"done",
	"failed",
] as const;
export type WireFleetRunState = (typeof FLEET_RUN_STATES)[number];

/**
 * One dispatch run as the GUI may draw it. Every field on it is reported by
 * Clio Coder over its opt-in event stream; nothing is derived or inferred.
 * `taskPreview` is Clio Coder's own sanitized, byte-bounded prefix of the
 * dispatched task, never the exact task.
 */
export interface WireFleetRun {
	readonly runId: string;
	readonly agentId: string;
	readonly state: WireFleetRunState;
	readonly taskPreview: string | null;
	readonly node: string | null;
	readonly attempt: number | null;
	readonly progressCount: number;
	/** True once Clio Coder capped this run's forwarded progress stream. */
	readonly progressTruncated: boolean;
	readonly outcome: string | null;
	readonly durationMs: number | null;
	readonly tokenCount: number | null;
	readonly updatedAt: string;
}

/** Runs the GUI keeps on the strip before the oldest settled one is dropped. */
export const MAX_WIRE_FLEET_RUNS = 64;

export interface FleetActivityPayload {
	readonly run: WireFleetRun;
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

export const TURN_STOP_REASONS = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
] as const;
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
	readonly "usage.state": UsageStatePayload;
	readonly "routing.state": RoutingStatePayload;
	readonly "dispatch.state": DispatchStatePayload;
	readonly "fleet.inspection.state": FleetInspectionStatePayload;
	readonly "toolchain.state": ToolchainStatePayload;
	readonly "trace.state": TraceStatePayload;
	readonly "evidence.state": EvidenceStatePayload;
	readonly "evidence.detail.state": EvidenceDetailStatePayload;
	readonly "fleet.verification.state": FleetVerificationStatePayload;
	readonly "recovery.state": RecoveryStatePayload;
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
	readonly "fleet.activity": FleetActivityPayload;
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

export type ServerEventOf<K extends ServerEventKind> = Readonly<
	ServerEnvelopeBase<K>
>;

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
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return true;
		}
	}
	return false;
}

function hasUnsafePresentationCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint === 0x7f ||
				(codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a &&
					codePoint !== 0x0d))
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
		if (!allowed.has(key)) {
			invalid(`${label} has unknown field ${JSON.stringify(key)}`);
		}
	}
	for (const key of required) {
		if (!Object.hasOwn(record, key)) {
			invalid(`${label} is missing field ${JSON.stringify(key)}`);
		}
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
	if (options.trim && value.trim() !== value) {
		return invalid(`${label} must not have surrounding whitespace`);
	}
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
	const id = expectString(value, label, {
		minBytes: 1,
		maxBytes: MAX_ID_BYTES,
		trim: true,
		noControls: true,
	});
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
		return invalid(`${label} is not a valid identifier`);
	}
	return id;
}

function expectOpaqueString(
	value: unknown,
	label: string,
	maximumBytes = 256,
): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: maximumBytes,
		trim: true,
		noControls: true,
	});
}

function expectName(value: unknown, label: string): string {
	const name = expectString(value, label, {
		minBytes: 1,
		maxBytes: MAX_NAME_BYTES,
		trim: true,
		noControls: true,
	});
	if (name === "." || name === ".." || /[\\/]/u.test(name)) {
		return invalid(`${label} is not a valid name`);
	}
	return name;
}

function expectEntryName(value: unknown, label: string): string {
	// Real directory listings contain names with surrounding whitespace; the
	// picker shows them but never trims them.
	const name = expectString(value, label, {
		minBytes: 1,
		maxBytes: 255,
		noControls: true,
	});
	if (name === "." || name === ".." || /[\\/]/u.test(name)) {
		return invalid(`${label} is not a valid name`);
	}
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
	if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path)) {
		return invalid(`${label} must be absolute`);
	}
	return path;
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") return invalid(`${label} must be a boolean`);
	return value;
}

function expectInteger(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		return invalid(
			`${label} must be a safe integer greater than or equal to ${minimum}`,
		);
	}
	return value as number;
}

function expectEnum<const T extends readonly string[]>(
	value: unknown,
	label: string,
	choices: T,
): T[number] {
	if (typeof value !== "string" || !choices.includes(value as T[number])) {
		return invalid(`${label} must be one of ${choices.join(", ")}`);
	}
	return value as T[number];
}

function expectPath(
	value: unknown,
	label: string,
	allowRoot: boolean,
): ProjectPath {
	if (!Array.isArray(value)) {
		return invalid(`${label} must be an array of path segments`);
	}
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
	if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/u.test(key)) {
		return invalid(`${label} is not a valid settings key`);
	}
	return key;
}

function expectSettingsValue(value: unknown, label: string): WireSettingsValue {
	if (value === null) return null;
	return expectString(value, label, {
		minBytes: 0,
		maxBytes: MAX_SETTINGS_VALUE_BYTES,
		trim: true,
		noControls: true,
	});
}

function expectSettingsRecord(
	value: unknown,
	label: string,
): Readonly<Record<string, WireSettingsValue>> {
	const record = expectRecord(value, label);
	const keys = Object.keys(record);
	if (keys.length > MAX_SETTINGS_KEYS) {
		return invalid(`${label} has too many keys`);
	}
	const result: Record<string, WireSettingsValue> = {};
	for (const key of keys) {
		result[expectSettingsKey(key, `${label} key`)] = expectSettingsValue(
			record[key],
			`${label}.${key}`,
		);
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
				result[key] = expectEnum(
					record[key],
					`${label}.${key}`,
					THINKING_LEVELS,
				);
				break;
			case "autonomy":
				result[key] = expectEnum(
					record[key],
					`${label}.${key}`,
					AUTONOMY_LEVELS,
				);
				break;
			default:
				return invalid(`${label} contains an unsupported setting`);
		}
	}
	return result;
}

function validateClientPayload<K extends ClientCommandKind>(
	kind: K,
	value: unknown,
): ClientCommandPayloadByKind[K] {
	const label = `${kind} payload`;
	switch (kind) {
		case "dispatch.inspect":
		case "fleet.inspect":
		case "toolchain.inspect":
		case "trace.inspect":
		case "evidence.inspect":
		case "recovery.inspect":
			return expectExactKeys(value, label, []) as ClientCommandPayloadByKind[K];
		case "evidence.read": {
			const record = expectExactKeys(value, label, ["evidenceId"]);
			return {
				evidenceId: expectArtifactId(record.evidenceId, `${label}.evidenceId`),
			} as ClientCommandPayloadByKind[K];
		}
		case "fleet.verify": {
			const record = expectExactKeys(value, label, ["runId"]);
			return {
				runId: expectArtifactId(record.runId, `${label}.runId`),
			} as ClientCommandPayloadByKind[K];
		}
		case "project.browse": {
			const record = expectExactKeys(value, label, [], ["path"]);
			const path = Object.hasOwn(record, "path") ? expectNativePath(record.path, `${label}.path`) : undefined;
			return {
				...(path === undefined ? {} : { path }),
			} as ClientCommandPayloadByKind[K];
		}
		case "project.open": {
			const record = expectExactKeys(value, label, ["path"]);
			return {
				path: expectNativePath(record.path, `${label}.path`),
			} as ClientCommandPayloadByKind[K];
		}
		case "project.select":
		case "project.forget":
		case "session.new":
		case "session.close":
		case "session.list":
		case "settings.get":
		case "config.inspect":
		case "catalog.inspect":
		case "usage.inspect":
		case "routing.inspect":
		case "targets.list": {
			const record = expectExactKeys(value, label, ["projectId"]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
			} as ClientCommandPayloadByKind[K];
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
			const record = expectExactKeys(value, label, [
				"projectId",
				"parent",
				"name",
			]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				parent: expectPath(record.parent, `${label}.parent`, true),
				name: expectName(record.name, `${label}.name`),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.move": {
			const record = expectExactKeys(value, label, [
				"projectId",
				"source",
				"destination",
			], ["expectedNodeVersion"]);
			const destination = expectExactKeys(
				record.destination,
				`${label}.destination`,
				["parent", "name"],
			);
			const expectedNodeVersion = Object.hasOwn(record, "expectedNodeVersion")
				? expectOpaqueString(
					record.expectedNodeVersion,
					`${label}.expectedNodeVersion`,
				)
				: undefined;
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				source: expectPath(record.source, `${label}.source`, false),
				destination: {
					parent: expectPath(
						destination.parent,
						`${label}.destination.parent`,
						true,
					),
					name: expectName(destination.name, `${label}.destination.name`),
				},
				...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.delete.prepare": {
			const record = expectExactKeys(value, label, ["projectId", "target"], [
				"expectedNodeVersion",
			]);
			const expectedNodeVersion = Object.hasOwn(record, "expectedNodeVersion")
				? expectOpaqueString(
					record.expectedNodeVersion,
					`${label}.expectedNodeVersion`,
				)
				: undefined;
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				target: expectPath(record.target, `${label}.target`, false),
				...(expectedNodeVersion === undefined ? {} : { expectedNodeVersion }),
			} as ClientCommandPayloadByKind[K];
		}
		case "fs.delete.confirm": {
			const record = expectExactKeys(value, label, [
				"projectId",
				"confirmationId",
			]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				confirmationId: expectId(
					record.confirmationId,
					`${label}.confirmationId`,
				),
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
			const record = expectExactKeys(value, label, [
				"projectId",
				"sessionId",
				"label",
			]);
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
			if (prompt.includes("\0")) {
				invalid(`${label}.prompt contains a null character`);
			}
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
			const record = expectExactKeys(value, label, [
				"projectId",
				"turnId",
				"permissionId",
				"decision",
			]);
			return {
				projectId: expectId(record.projectId, `${label}.projectId`),
				turnId: expectId(record.turnId, `${label}.turnId`),
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				decision: expectEnum(
					record.decision,
					`${label}.decision`,
					PERMISSION_DECISIONS,
				),
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

function expectPresentationText(
	value: unknown,
	label: string,
	maximumBytes = 4 * 1024,
): string {
	const text = expectString(value, label, {
		minBytes: 1,
		maxBytes: maximumBytes,
		trim: true,
	});
	if (hasUnsafePresentationCharacter(text)) {
		return invalid(`${label} contains an unsafe control character`);
	}
	return text;
}

function expectNullablePresentationText(
	value: unknown,
	label: string,
	maximumBytes = 4 * 1024,
): string | null {
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

/**
 * An identifier a frame may use to name a durable artifact.
 *
 * Deliberately the same shape the host allowlist enforces: no separator, no
 * traversal, no leading dash a command could read as a flag. Membership in the
 * host's served window is the real check; this is the one that makes a
 * malformed reference a protocol error rather than something the host has to
 * reason about.
 */
function expectArtifactId(value: unknown, label: string): string {
	const id = expectOpaqueString(value, label, 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id.includes("..")) {
		return invalid(`${label} must be an artifact identifier`);
	}
	return id;
}

function expectNullableTimestamp(value: unknown, label: string): string | null {
	return value === null ? null : expectTimestamp(value, label);
}

function expectNullableId(value: unknown, label: string): string | null {
	return value === null ? null : expectId(value, label);
}

function validateWireProjectPath(
	value: unknown,
	label: string,
	allowRoot = true,
): WireProjectPath {
	const record = expectExactKeys(value, label, ["segments"]);
	return {
		segments: expectPath(record.segments, `${label}.segments`, allowRoot),
	};
}

function validateEventSource(value: unknown, label: string): WireEventSource {
	return expectEnum(value, label, EVENT_SOURCES);
}

function validateLocations(
	value: unknown,
	label: string,
): readonly WireProjectPath[] {
	return expectArray(
		value,
		label,
		32,
		(entry, entryLabel) => validateWireProjectPath(entry, entryLabel, false),
	);
}

interface TreeBudget {
	nodes: number;
}

function validateWireTreeNode(
	value: unknown,
	label: string,
	budget: TreeBudget,
): WireTreeNode {
	budget.nodes += 1;
	if (budget.nodes > MAX_WIRE_TREE_NODES) {
		return invalid(`${label} exceeds the wire tree node limit`);
	}
	const record = expectExactKeys(value, label, [
		"name",
		"path",
		"kind",
		"operable",
	], [
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
		kind: expectEnum(
			record.kind,
			`${label}.kind`,
			["file", "directory", "symlink", "other"] as const,
		),
		operable: expectBoolean(record.operable, `${label}.operable`),
		...(size === undefined ? {} : { size }),
		...(modifiedAt === undefined ? {} : { modifiedAt }),
		...(nodeVersion === undefined ? {} : { nodeVersion }),
		...(children === undefined ? {} : { children }),
	};
}

function validateWireTree(
	value: unknown,
	label: string,
): readonly WireTreeNode[] {
	const budget = { nodes: 0 };
	return expectArray(
		value,
		label,
		MAX_WIRE_TREE_NODES,
		(entry, entryLabel) => validateWireTreeNode(entry, entryLabel, budget),
	);
}

function validateWireProjectSummary(
	value: unknown,
	label: string,
): WireProjectSummary {
	const record = expectExactKeys(value, label, [
		"id",
		"displayName",
		"rootPath",
		"lastOpenedAt",
		"available",
	]);
	return {
		id: expectId(record.id, `${label}.id`),
		displayName: expectDisplayName(record.displayName, `${label}.displayName`),
		rootPath: expectNativePath(record.rootPath, `${label}.rootPath`),
		lastOpenedAt: expectTimestamp(record.lastOpenedAt, `${label}.lastOpenedAt`),
		available: expectBoolean(record.available, `${label}.available`),
	};
}

function validateWireSessionSummary(
	value: unknown,
	label: string,
): WireSessionSummary {
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
		preview: expectString(record.preview, `${label}.preview`, {
			minBytes: 0,
			maxBytes: 512,
			noControls: true,
		}),
		createdAt: expectTimestamp(record.createdAt, `${label}.createdAt`),
		updatedAt: expectTimestamp(record.updatedAt, `${label}.updatedAt`),
		turns: expectInteger(record.turns, `${label}.turns`),
		target: expectNullablePresentationText(
			record.target,
			`${label}.target`,
			128,
		),
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
		target: expectNullablePresentationText(
			record.target,
			`${label}.target`,
			128,
		),
		model: expectNullablePresentationText(record.model, `${label}.model`, 256),
		autonomy: expectEnum(record.autonomy, `${label}.autonomy`, AUTONOMY_LEVELS),
		autonomySource: expectEnum(
			record.autonomySource,
			`${label}.autonomySource`,
			["settings", "session"] as const,
		),
		resumed: expectBoolean(record.resumed, `${label}.resumed`),
		replayedTurns: expectInteger(
			record.replayedTurns,
			`${label}.replayedTurns`,
		),
		replayTruncated: expectBoolean(
			record.replayTruncated,
			`${label}.replayTruncated`,
		),
		createdAt: expectTimestamp(record.createdAt, `${label}.createdAt`),
	};
}

const CAPABILITY_KEYS = [
	"load",
	"list",
	"label",
	"delete",
	"autonomy",
	"settings",
	"targets",
	"loopBlocked",
	"dispatchEvents",
	"agentAttribution",
] as const;

function validateCapabilities(
	value: unknown,
	label: string,
): WireClioCapabilities {
	const record = expectExactKeys(value, label, CAPABILITY_KEYS);
	const result: Record<string, boolean> = {};
	for (const key of CAPABILITY_KEYS) {
		result[key] = expectBoolean(record[key], `${label}.${key}`);
	}
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
		const agentRecord = expectExactKeys(record.agent, `${label}.agent`, [
			"name",
			"version",
		]);
		agent = {
			name: expectPresentationText(
				agentRecord.name,
				`${label}.agent.name`,
				128,
			),
			version: expectPresentationText(
				agentRecord.version,
				`${label}.agent.version`,
				128,
			),
		};
	}
	let lastFailure: WireClioFailure | null = null;
	if (record.lastFailure !== null) {
		const failure = expectExactKeys(
			record.lastFailure,
			`${label}.lastFailure`,
			["code", "summary"],
		);
		lastFailure = {
			code: expectId(failure.code, `${label}.lastFailure.code`),
			summary: expectSanitizedMessage(
				failure.summary,
				`${label}.lastFailure.summary`,
			),
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

/**
 * Agent attribution as it crosses the boundary. The list is ordered from the
 * most general identity to the most specific, so a renderer that wants one
 * label takes the last entry and one that wants provenance reads the whole
 * chain. An empty list means Clio Coder reported no identity, which the GUI
 * renders as the product rather than as a guess.
 */
function validateAgentAttributions(
	value: unknown,
	label: string,
): readonly WireAgentAttribution[] {
	return expectArray(
		value,
		label,
		MAX_WIRE_AGENT_ATTRIBUTIONS,
		(entry, entryLabel) => {
			const record = expectExactKeys(entry, entryLabel, [
				"role",
				"agentId",
				"runId",
				"node",
			]);
			const role = expectEnum(record.role, `${entryLabel}.role`, AGENT_ROLES);
			const runId = record.runId === null ? null : expectPresentationText(record.runId, `${entryLabel}.runId`, 128);
			if (role === "orchestrator" && runId !== null) {
				invalid(`${entryLabel}.runId must be null for the orchestrator`);
			}
			return {
				role,
				agentId: expectPresentationText(
					record.agentId,
					`${entryLabel}.agentId`,
					128,
				),
				runId,
				node: record.node === null ? null : expectPresentationText(record.node, `${entryLabel}.node`, 128),
			};
		},
	);
}

function validateFleetRun(value: unknown, label: string): WireFleetRun {
	const record = expectExactKeys(value, label, [
		"runId",
		"agentId",
		"state",
		"taskPreview",
		"node",
		"attempt",
		"progressCount",
		"progressTruncated",
		"outcome",
		"durationMs",
		"tokenCount",
		"updatedAt",
	]);
	const state = expectEnum(record.state, `${label}.state`, FLEET_RUN_STATES);
	const outcome = record.outcome === null ? null : expectPresentationText(record.outcome, `${label}.outcome`, 64);
	if (outcome !== null && state !== "done" && state !== "failed") {
		invalid(`${label}.outcome is valid only on a settled run`);
	}
	return {
		runId: expectPresentationText(record.runId, `${label}.runId`, 128),
		agentId: expectPresentationText(record.agentId, `${label}.agentId`, 128),
		state,
		taskPreview: record.taskPreview === null
			? null
			: expectPresentationText(record.taskPreview, `${label}.taskPreview`, 512),
		node: record.node === null ? null : expectPresentationText(record.node, `${label}.node`, 128),
		attempt: record.attempt === null ? null : expectInteger(record.attempt, `${label}.attempt`, 0),
		progressCount: expectInteger(
			record.progressCount,
			`${label}.progressCount`,
			0,
		),
		progressTruncated: expectBoolean(
			record.progressTruncated,
			`${label}.progressTruncated`,
		),
		outcome,
		durationMs: record.durationMs === null ? null : expectInteger(record.durationMs, `${label}.durationMs`, 0),
		tokenCount: record.tokenCount === null ? null : expectInteger(record.tokenCount, `${label}.tokenCount`, 0),
		updatedAt: expectTimestamp(record.updatedAt, `${label}.updatedAt`),
	};
}

function validateWireTimelineItem(
	value: unknown,
	label: string,
): WireTimelineItem {
	const record = expectExactKeys(
		value,
		label,
		[
			"id",
			"kind",
			"title",
			"summary",
			"status",
			"turnId",
			"origin",
			"startedAt",
			"source",
		],
		["detail", "sequence", "endedAt", "usage", "agents"],
	);
	const agents = Object.hasOwn(record, "agents")
		? validateAgentAttributions(record.agents, `${label}.agents`)
		: undefined;
	const detail = Object.hasOwn(record, "detail") ? expectPresentationText(record.detail, `${label}.detail`) : undefined;
	const sequence = Object.hasOwn(record, "sequence")
		? expectInteger(record.sequence, `${label}.sequence`, 1)
		: undefined;
	const endedAt = Object.hasOwn(record, "endedAt") ? expectTimestamp(record.endedAt, `${label}.endedAt`) : undefined;
	const usage = Object.hasOwn(record, "usage") ? validateUsage(record.usage, `${label}.usage`) : undefined;
	const kind = expectEnum(
		record.kind,
		`${label}.kind`,
		[
			"request",
			"narrative",
			"thought",
			"tool",
			"loop",
			"approval",
			"outcome",
			"failure",
		] as const,
	);
	const status = expectEnum(
		record.status,
		`${label}.status`,
		[
			"queued",
			"active",
			"waiting",
			"complete",
			"canceled",
			"failed",
			"replayed",
		] as const,
	);
	const origin = expectEnum(
		record.origin,
		`${label}.origin`,
		["live", "replay"] as const,
	);
	const startedAt = record.startedAt === null ? null : expectTimestamp(record.startedAt, `${label}.startedAt`);
	const source = validateEventSource(record.source, `${label}.source`);
	if (usage !== undefined && kind !== "outcome" && kind !== "failure") {
		invalid(`${label}.usage is valid only for a terminal outcome or failure`);
	}
	if (origin === "replay") {
		if (startedAt !== null) {
			invalid(`${label}.startedAt must be null for replay history`);
		}
		if (endedAt !== undefined) {
			invalid(`${label}.endedAt must be omitted for replay history`);
		}
		if (source !== "replayed-from-clio") {
			invalid(`${label}.source must identify replay history`);
		}
		if (kind === "outcome" || kind === "failure") {
			invalid(`${label}.kind cannot claim a replay outcome`);
		}
		if (
			status !== "replayed" &&
			!(kind === "tool" && ["complete", "canceled", "failed"].includes(status))
		) {
			invalid(
				`${label}.status must stay neutral unless a replayed tool supplied its terminal status`,
			);
		}
	} else {
		if (startedAt === null) {
			invalid(`${label}.startedAt must identify when a live item began`);
		}
		if (source === "replayed-from-clio") {
			invalid(
				`${label}.source cannot identify live activity as replay history`,
			);
		}
		if (status === "replayed") {
			invalid(
				`${label}.status cannot identify live activity as replay history`,
			);
		}
	}
	return {
		id: expectId(record.id, `${label}.id`),
		kind,
		title: expectPresentationText(record.title, `${label}.title`, 512),
		summary: expectString(record.summary, `${label}.summary`, {
			minBytes: 0,
			maxBytes: 64 * 1024 + 64,
		}),
		...(detail === undefined ? {} : { detail }),
		status,
		turnId: expectId(record.turnId, `${label}.turnId`),
		origin,
		startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		...(sequence === undefined ? {} : { sequence }),
		...(usage === undefined ? {} : { usage }),
		...(agents === undefined ? {} : { agents }),
		source,
	};
}

function validateWirePendingPermission(
	value: unknown,
	label: string,
): WirePendingPermission {
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

function validateWireDeleteChallenge(
	value: unknown,
	label: string,
): WireDeleteChallenge {
	const record = expectExactKeys(value, label, [
		"confirmationId",
		"target",
		"displayPath",
		"targetKind",
		"expiresAt",
	]);
	return {
		confirmationId: expectId(record.confirmationId, `${label}.confirmationId`),
		target: validateWireProjectPath(record.target, `${label}.target`),
		displayPath: expectPresentationText(
			record.displayPath,
			`${label}.displayPath`,
		),
		targetKind: expectEnum(
			record.targetKind,
			`${label}.targetKind`,
			["file", "empty-directory"] as const,
		),
		expiresAt: expectTimestamp(record.expiresAt, `${label}.expiresAt`),
	};
}

function validateActiveTurn(value: unknown, label: string): WireActiveTurn {
	const record = expectExactKeys(value, label, [
		"turnId",
		"startedAt",
		"toolCalls",
		"lastToolTitle",
		"repeatedShapes",
	]);
	return {
		turnId: expectId(record.turnId, `${label}.turnId`),
		startedAt: expectTimestamp(record.startedAt, `${label}.startedAt`),
		toolCalls: expectInteger(record.toolCalls, `${label}.toolCalls`),
		lastToolTitle: expectNullablePresentationText(
			record.lastToolTitle,
			`${label}.lastToolTitle`,
			512,
		),
		repeatedShapes: expectInteger(
			record.repeatedShapes,
			`${label}.repeatedShapes`,
		),
	};
}

function validateSettingsState(
	value: unknown,
	label: string,
): WireSettingsState {
	const record = expectExactKeys(value, label, [
		"settings",
		"editable",
		"options",
		"checkedAt",
	]);
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
	if (optionKeys.length > MAX_SETTINGS_KEYS) {
		invalid(`${label}.options has too many keys`);
	}
	for (const key of optionKeys) {
		options[expectSettingsKey(key, `${label}.options key`)] = expectArray(
			optionsRecord[key],
			`${label}.options.${key}`,
			256,
			(entry, entryLabel) => expectPresentationText(entry, entryLabel, MAX_SETTINGS_VALUE_BYTES),
		);
	}
	return {
		settings,
		editable,
		options,
		checkedAt: expectTimestamp(record.checkedAt, `${label}.checkedAt`),
	};
}

function expectConfigText(
	value: unknown,
	label: string,
	maximumBytes: number,
): string {
	return expectString(value, label, {
		minBytes: 1,
		maxBytes: maximumBytes,
		trim: true,
		noControls: true,
	});
}

function validateConfigSetting(
	value: unknown,
	label: string,
): WireConfigSetting {
	const record = expectExactKeys(value, label, [
		"key",
		"source",
		"value",
		"valueKind",
	]);
	return {
		key: expectConfigText(record.key, `${label}.key`, 256),
		source: expectEnum(
			record.source,
			`${label}.source`,
			CONFIG_SETTING_SOURCES,
		),
		value: expectConfigText(record.value, `${label}.value`, 256),
		valueKind: expectEnum(
			record.valueKind,
			`${label}.valueKind`,
			CONFIG_VALUE_KINDS,
		),
	};
}

function validateCustomizationFact(
	value: unknown,
	label: string,
): WireCustomizationFact {
	const record = expectExactKeys(value, label, ["label", "value"]);
	return {
		label: expectConfigText(record.label, `${label}.label`, 64),
		value: expectConfigText(record.value, `${label}.value`, 256),
	};
}

function validateCustomizationEntry(
	value: unknown,
	label: string,
): WireCustomizationEntry {
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
		if (!/^[A-Fa-f0-9]{4,128}$/u.test(hash)) {
			invalid(`${label}.hash must be hexadecimal`);
		}
	}
	const trust = Object.hasOwn(record, "trust")
		? expectEnum(record.trust, `${label}.trust`, CUSTOMIZATION_TRUST)
		: undefined;
	const precedence = Object.hasOwn(record, "precedence")
		? expectEnum(
			record.precedence,
			`${label}.precedence`,
			CUSTOMIZATION_PRECEDENCE,
		)
		: undefined;
	const contextCostTokens = Object.hasOwn(record, "contextCostTokens")
		? expectInteger(record.contextCostTokens, `${label}.contextCostTokens`)
		: undefined;
	return {
		category: expectEnum(
			record.category,
			`${label}.category`,
			CUSTOMIZATION_CATEGORIES,
		),
		id: expectConfigText(record.id, `${label}.id`, 256),
		scope: expectConfigText(record.scope, `${label}.scope`, 128),
		...(sourcePath === undefined ? {} : { sourcePath }),
		...(hash === undefined ? {} : { hash }),
		...(trust === undefined ? {} : { trust }),
		...(precedence === undefined ? {} : { precedence }),
		reloadClass: expectEnum(
			record.reloadClass,
			`${label}.reloadClass`,
			CUSTOMIZATION_RELOAD_CLASSES,
		),
		...(contextCostTokens === undefined ? {} : { contextCostTokens }),
		facts: expectArray(
			record.facts,
			`${label}.facts`,
			MAX_WIRE_CUSTOMIZATION_FACTS,
			validateCustomizationFact,
		),
	};
}

function validateConfigIssueCount(
	value: unknown,
	label: string,
): WireConfigIssueCount {
	const record = expectExactKeys(value, label, ["surface", "count"]);
	return {
		surface: expectConfigText(record.surface, `${label}.surface`, 64),
		count: expectInteger(record.count, `${label}.count`, 1),
	};
}

function validateConfigInspection(
	value: unknown,
	label: string,
): WireConfigInspection {
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
		settingsTruncated: expectBoolean(
			record.settingsTruncated,
			`${label}.settingsTruncated`,
		),
		entries: expectArray(
			record.entries,
			`${label}.entries`,
			MAX_WIRE_CUSTOMIZATION_ENTRIES,
			validateCustomizationEntry,
		),
		entriesTruncated: expectBoolean(
			record.entriesTruncated,
			`${label}.entriesTruncated`,
		),
		issueCounts: expectArray(
			record.issueCounts,
			`${label}.issueCounts`,
			MAX_WIRE_CONFIG_ISSUE_GROUPS,
			validateConfigIssueCount,
		),
		issuesTruncated: expectBoolean(
			record.issuesTruncated,
			`${label}.issuesTruncated`,
		),
	};
}

function expectCatalogCount(value: unknown, label: string): number {
	const count = expectInteger(value, label);
	if (count > 1_000_000) invalid(`${label} exceeds the catalog numeric bound`);
	return count;
}

function validateCatalogLabels(
	value: unknown,
	label: string,
): readonly string[] {
	return expectArray(
		value,
		label,
		MAX_WIRE_CATALOG_LABELS,
		(entry, entryLabel) => expectPresentationText(entry, entryLabel, 64),
	);
}

function validateCatalogAgentBudget(
	value: unknown,
	label: string,
): WireCatalogAgentBudget {
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
		maximumToolCalls: record.maximumToolCalls === null ? null : expectCatalogCount(
			record.maximumToolCalls,
			`${label}.maximumToolCalls`,
		),
		maximumReadReserve: record.maximumReadReserve === null ? null : expectCatalogCount(
			record.maximumReadReserve,
			`${label}.maximumReadReserve`,
		),
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
		description: expectPresentationText(
			record.description,
			`${label}.description`,
			512,
		),
		version: expectCatalogCount(record.version, `${label}.version`),
		source: expectEnum(record.source, `${label}.source`, CATALOG_AGENT_SOURCES),
		audience: expectEnum(
			record.audience,
			`${label}.audience`,
			CATALOG_AGENT_AUDIENCES,
		),
		category: expectEnum(
			record.category,
			`${label}.category`,
			CATALOG_AGENT_CATEGORIES,
		),
		capability: expectEnum(
			record.capability,
			`${label}.capability`,
			CATALOG_AGENT_CAPABILITIES,
		),
		latency: expectEnum(
			record.latency,
			`${label}.latency`,
			CATALOG_AGENT_LATENCIES,
		),
		contextTier: expectEnum(
			record.contextTier,
			`${label}.contextTier`,
			CATALOG_CONTEXT_TIERS,
		),
		tags: validateCatalogLabels(record.tags, `${label}.tags`),
		skills: validateCatalogLabels(record.skills, `${label}.skills`),
		tools: validateCatalogLabels(record.tools, `${label}.tools`),
		resultKind: expectPresentationText(
			record.resultKind,
			`${label}.resultKind`,
			128,
		),
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
		description: expectPresentationText(
			record.description,
			`${label}.description`,
			512,
		),
		scope: expectEnum(record.scope, `${label}.scope`, CATALOG_RESOURCE_SCOPES),
		source: expectEnum(record.source, `${label}.source`, CATALOG_SKILL_SOURCES),
		trusted: expectBoolean(record.trusted, `${label}.trusted`),
		precedence: expectCatalogCount(record.precedence, `${label}.precedence`),
		modelInvocable: expectBoolean(
			record.modelInvocable,
			`${label}.modelInvocable`,
		),
		issueCount: expectCatalogCount(record.issueCount, `${label}.issueCount`),
	};
}

function validateCatalogLibraryEntry(
	value: unknown,
	label: string,
): WireCatalogLibraryEntry {
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
		description: expectPresentationText(
			record.description,
			`${label}.description`,
			512,
		),
		version: expectNullablePresentationText(
			record.version,
			`${label}.version`,
			64,
		),
		category: expectNullablePresentationText(
			record.category,
			`${label}.category`,
			64,
		),
		origin: expectEnum(
			record.origin,
			`${label}.origin`,
			CATALOG_LIBRARY_ORIGINS,
		),
		audit: expectEnum(record.audit, `${label}.audit`, CATALOG_AUDIT_STATES),
	};
}

function validateCatalogExtension(
	value: unknown,
	label: string,
): WireCatalogExtension {
	const record = expectExactKeys(value, label, [
		"id",
		"name",
		"version",
		"description",
		"scope",
		"enabled",
		"effective",
		"overriddenBy",
		"resources",
		"issueCount",
	]);
	const scope = expectEnum(
		record.scope,
		`${label}.scope`,
		CATALOG_EXTENSION_SCOPES,
	);
	const enabled = expectBoolean(record.enabled, `${label}.enabled`);
	const effective = expectBoolean(record.effective, `${label}.effective`);
	const overriddenBy = record.overriddenBy === null ? null : expectEnum(
		record.overriddenBy,
		`${label}.overriddenBy`,
		CATALOG_EXTENSION_SCOPES,
	);
	if (!effective) {
		if (scope !== "user" || overriddenBy !== "project") {
			invalid(
				`${label} shadowing must describe a user extension overridden by project scope`,
			);
		}
	} else if (overriddenBy !== null) {
		invalid(`${label} can name an overriding scope only when ineffective`);
	}
	const resources = expectArray(
		record.resources,
		`${label}.resources`,
		CATALOG_EXTENSION_RESOURCE_KINDS.length,
		(entry, entryLabel) => expectEnum(entry, entryLabel, CATALOG_EXTENSION_RESOURCE_KINDS),
	);
	if (new Set(resources).size !== resources.length) {
		invalid(`${label}.resources contains duplicate kinds`);
	}
	return {
		id: expectPresentationText(record.id, `${label}.id`, 128),
		name: expectPresentationText(record.name, `${label}.name`, 128),
		version: expectPresentationText(record.version, `${label}.version`, 64),
		description: expectPresentationText(
			record.description,
			`${label}.description`,
			512,
		),
		scope,
		enabled,
		effective,
		overriddenBy,
		resources,
		issueCount: expectCatalogCount(record.issueCount, `${label}.issueCount`),
	};
}

function validateCatalogCollection<T>(
	value: unknown,
	label: string,
	maximum: number,
	validateItem: (entry: unknown, label: string) => T,
): {
	availability: WireCatalogAvailability;
	items: readonly T[];
	truncated: boolean;
	issueCount: number;
} {
	const record = expectExactKeys(value, label, [
		"availability",
		"items",
		"truncated",
		"issueCount",
	]);
	const availability = expectEnum(
		record.availability,
		`${label}.availability`,
		CATALOG_AVAILABILITY,
	);
	const items = expectArray(
		record.items,
		`${label}.items`,
		maximum,
		validateItem,
	);
	if (availability === "failed" && items.length > 0) {
		invalid(`${label} cannot carry items when its adapter failed`);
	}
	return {
		availability,
		items,
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
		issueCount: expectCatalogCount(record.issueCount, `${label}.issueCount`),
	};
}

function validateCatalogInspection(
	value: unknown,
	label: string,
): WireCatalogInspection {
	const record = expectExactKeys(value, label, [
		"inspectedAt",
		"agents",
		"skills",
		"library",
		"extensions",
		"verifiers",
	]);
	const verifiers = expectExactKeys(record.verifiers, `${label}.verifiers`, [
		"availability",
	]);
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
		extensions: validateCatalogCollection(
			record.extensions,
			`${label}.extensions`,
			MAX_WIRE_CATALOG_EXTENSIONS,
			validateCatalogExtension,
		),
		verifiers: { availability: "typed-interface-required" },
	};
}

function expectUsageCost(value: unknown, label: string): number {
	if (
		typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
		value > 1_000_000_000
	) {
		return invalid(
			`${label} must be a finite non-negative cost within the usage bound`,
		);
	}
	return value;
}

function expectUsageCount(value: unknown, label: string): number {
	if (
		!Number.isSafeInteger(value) || (value as number) < 0 ||
		(value as number) > 1_000_000_000_000_000
	) {
		return invalid(
			`${label} must be a non-negative safe integer within the usage bound`,
		);
	}
	return value as number;
}

function validateHistoricalUsageTotals(
	value: unknown,
	label: string,
): WireHistoricalUsageTotals {
	const record = expectExactKeys(value, label, [
		"apiCalls",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"reasoning",
		"totalTokens",
		"costUsd",
		"turns",
		"sideQuestions",
		"handoffs",
	]);
	return {
		apiCalls: expectUsageCount(record.apiCalls, `${label}.apiCalls`),
		input: expectUsageCount(record.input, `${label}.input`),
		output: expectUsageCount(record.output, `${label}.output`),
		cacheRead: expectUsageCount(record.cacheRead, `${label}.cacheRead`),
		cacheWrite: expectUsageCount(record.cacheWrite, `${label}.cacheWrite`),
		reasoning: expectUsageCount(record.reasoning, `${label}.reasoning`),
		totalTokens: expectUsageCount(record.totalTokens, `${label}.totalTokens`),
		costUsd: expectUsageCost(record.costUsd, `${label}.costUsd`),
		turns: record.turns === null ? null : expectUsageCount(record.turns, `${label}.turns`),
		sideQuestions: expectUsageCount(
			record.sideQuestions,
			`${label}.sideQuestions`,
		),
		handoffs: expectUsageCount(record.handoffs, `${label}.handoffs`),
	};
}

function validateUsageModel(value: unknown, label: string): WireUsageModel {
	const record = expectExactKeys(value, label, [
		"provider",
		"model",
		"apiCalls",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"reasoning",
		"totalTokens",
		"costUsd",
	]);
	return {
		provider: expectPresentationText(record.provider, `${label}.provider`, 128),
		model: expectPresentationText(record.model, `${label}.model`, 256),
		apiCalls: expectUsageCount(record.apiCalls, `${label}.apiCalls`),
		input: expectUsageCount(record.input, `${label}.input`),
		output: expectUsageCount(record.output, `${label}.output`),
		cacheRead: expectUsageCount(record.cacheRead, `${label}.cacheRead`),
		cacheWrite: expectUsageCount(record.cacheWrite, `${label}.cacheWrite`),
		reasoning: expectUsageCount(record.reasoning, `${label}.reasoning`),
		totalTokens: expectUsageCount(record.totalTokens, `${label}.totalTokens`),
		costUsd: expectUsageCost(record.costUsd, `${label}.costUsd`),
	};
}

function validateUsageTool(value: unknown, label: string): WireUsageTool {
	const record = expectExactKeys(value, label, [
		"name",
		"calls",
		"successful",
		"errors",
		"blocked",
	]);
	return {
		name: expectPresentationText(record.name, `${label}.name`, 128),
		calls: expectUsageCount(record.calls, `${label}.calls`),
		successful: expectUsageCount(record.successful, `${label}.successful`),
		errors: expectUsageCount(record.errors, `${label}.errors`),
		blocked: expectUsageCount(record.blocked, `${label}.blocked`),
	};
}

function validateUsageSkill(value: unknown, label: string): WireUsageSkill {
	const record = expectExactKeys(value, label, [
		"name",
		"activations",
		"observedInWindow",
	]);
	const activations = expectUsageCount(
		record.activations,
		`${label}.activations`,
	);
	const observedInWindow = expectBoolean(
		record.observedInWindow,
		`${label}.observedInWindow`,
	);
	if (observedInWindow !== (activations > 0)) {
		invalid(`${label} observation state contradicts its activation count`);
	}
	return {
		name: expectPresentationText(record.name, `${label}.name`, 128),
		activations,
		observedInWindow,
	};
}

function validateUsageRecipe(value: unknown, label: string): WireUsageRecipe {
	const record = expectExactKeys(value, label, ["agentId", "runs"]);
	return {
		agentId: expectPresentationText(record.agentId, `${label}.agentId`, 128),
		runs: expectUsageCount(record.runs, `${label}.runs`),
	};
}

function validateUsageOpportunity(
	value: unknown,
	label: string,
): WireUsageOpportunityCount {
	const record = expectExactKeys(value, label, ["kind", "count"]);
	return {
		kind: expectEnum(record.kind, `${label}.kind`, USAGE_OPPORTUNITY_KINDS),
		count: expectUsageCount(record.count, `${label}.count`),
	};
}

function uniqueUsageRows<T>(
	items: readonly T[],
	label: string,
	key: (item: T) => string,
): readonly T[] {
	if (new Set(items.map(key)).size !== items.length) {
		invalid(`${label} contains duplicate rows`);
	}
	return items;
}

function validateUsageInspection(
	value: unknown,
	label: string,
): WireUsageInspection {
	const record = expectExactKeys(value, label, [
		"inspectedAt",
		"schema",
		"windowDays",
		"windowFrom",
		"windowTo",
		"stores",
		"sessionCount",
		"dispatchRunCount",
		"totals",
		"models",
		"modelsTruncated",
		"tools",
		"toolsTruncated",
		"skills",
		"skillsTruncated",
		"recipes",
		"recipesTruncated",
		"opportunities",
	]);
	if (record.schema !== "experimental") {
		invalid(`${label}.schema must be experimental`);
	}
	if (record.windowDays !== 30) invalid(`${label}.windowDays must be 30`);
	const windowFrom = expectTimestamp(record.windowFrom, `${label}.windowFrom`);
	const windowTo = expectTimestamp(record.windowTo, `${label}.windowTo`);
	if (Date.parse(windowFrom) > Date.parse(windowTo)) {
		invalid(`${label} window is reversed`);
	}
	const storesRecord = expectExactKeys(record.stores, `${label}.stores`, [
		"sessions",
		"dispatchReceipts",
	]);
	const stores = {
		sessions: expectEnum(
			storesRecord.sessions,
			`${label}.stores.sessions`,
			USAGE_STORE_STATES,
		),
		dispatchReceipts: expectEnum(
			storesRecord.dispatchReceipts,
			`${label}.stores.dispatchReceipts`,
			USAGE_STORE_STATES,
		),
	};
	const sessionCount = record.sessionCount === null
		? null
		: expectUsageCount(record.sessionCount, `${label}.sessionCount`);
	const dispatchRunCount = record.dispatchRunCount === null
		? null
		: expectUsageCount(record.dispatchRunCount, `${label}.dispatchRunCount`);
	if ((stores.sessions === "missing") !== (sessionCount === null)) {
		invalid(`${label}.sessionCount contradicts the session store state`);
	}
	if ((stores.dispatchReceipts === "missing") !== (dispatchRunCount === null)) {
		invalid(`${label}.dispatchRunCount contradicts the receipt store state`);
	}
	const models = uniqueUsageRows(
		expectArray(
			record.models,
			`${label}.models`,
			MAX_WIRE_USAGE_MODELS,
			validateUsageModel,
		),
		`${label}.models`,
		(item) => `${item.provider}\u001f${item.model}`,
	);
	const tools = uniqueUsageRows(
		expectArray(
			record.tools,
			`${label}.tools`,
			MAX_WIRE_USAGE_TOOLS,
			validateUsageTool,
		),
		`${label}.tools`,
		(item) => item.name,
	);
	const skills = uniqueUsageRows(
		expectArray(
			record.skills,
			`${label}.skills`,
			MAX_WIRE_USAGE_SKILLS,
			validateUsageSkill,
		),
		`${label}.skills`,
		(item) => item.name,
	);
	const recipes = uniqueUsageRows(
		expectArray(
			record.recipes,
			`${label}.recipes`,
			MAX_WIRE_USAGE_RECIPES,
			validateUsageRecipe,
		),
		`${label}.recipes`,
		(item) => item.agentId,
	);
	const opportunities = uniqueUsageRows(
		expectArray(
			record.opportunities,
			`${label}.opportunities`,
			USAGE_OPPORTUNITY_KINDS.length,
			validateUsageOpportunity,
		),
		`${label}.opportunities`,
		(item) => item.kind,
	);
	return {
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		schema: "experimental",
		windowDays: 30,
		windowFrom,
		windowTo,
		stores,
		sessionCount,
		dispatchRunCount,
		totals: record.totals === null ? null : validateHistoricalUsageTotals(record.totals, `${label}.totals`),
		models,
		modelsTruncated: expectBoolean(
			record.modelsTruncated,
			`${label}.modelsTruncated`,
		),
		tools,
		toolsTruncated: expectBoolean(
			record.toolsTruncated,
			`${label}.toolsTruncated`,
		),
		skills,
		skillsTruncated: expectBoolean(
			record.skillsTruncated,
			`${label}.skillsTruncated`,
		),
		recipes,
		recipesTruncated: expectBoolean(
			record.recipesTruncated,
			`${label}.recipesTruncated`,
		),
		opportunities,
	};
}

function expectRoutingNumber(value: unknown, label: string): number {
	const parsed = expectInteger(value, label);
	if (parsed > 10_000_000_000) {
		invalid(`${label} exceeds the routing inventory bound`);
	}
	return parsed;
}

const ROUTING_LOCATION_PREFIX =
	/^(?:(?:https?|file|ftp|ssh):|[a-z][a-z0-9+.-]*:\/\/|~?[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/iu;

function expectRoutingIdentifier(
	value: unknown,
	label: string,
	maximumBytes: number,
): string {
	const text = expectPresentationText(value, label, maximumBytes);
	if (ROUTING_LOCATION_PREFIX.test(text) || text.includes("\\")) {
		invalid(`${label} cannot contain a URL or native path`);
	}
	return text;
}

function expectNullableRoutingIdentifier(
	value: unknown,
	label: string,
	maximumBytes: number,
): string | null {
	if (value === null) return null;
	return expectRoutingIdentifier(value, label, maximumBytes);
}

function validateRoutingModel(value: unknown, label: string): WireRoutingModel {
	const record = expectExactKeys(value, label, [
		"targetId",
		"runtimeId",
		"modelId",
		"capabilities",
		"contextWindow",
		"maxOutputTokens",
		"residency",
	]);
	const capabilities = expectArray(
		record.capabilities,
		`${label}.capabilities`,
		ROUTING_MODEL_CAPABILITIES.length,
		(entry, entryLabel) => expectEnum(entry, entryLabel, ROUTING_MODEL_CAPABILITIES),
	);
	if (new Set(capabilities).size !== capabilities.length) {
		invalid(`${label}.capabilities contains duplicate values`);
	}
	return {
		targetId: expectRoutingIdentifier(
			record.targetId,
			`${label}.targetId`,
			128,
		),
		runtimeId: expectRoutingIdentifier(
			record.runtimeId,
			`${label}.runtimeId`,
			128,
		),
		modelId: expectRoutingIdentifier(record.modelId, `${label}.modelId`, 256),
		capabilities,
		contextWindow: expectRoutingNumber(
			record.contextWindow,
			`${label}.contextWindow`,
		),
		maxOutputTokens: expectRoutingNumber(
			record.maxOutputTokens,
			`${label}.maxOutputTokens`,
		),
		residency: expectEnum(
			record.residency,
			`${label}.residency`,
			ROUTING_MODEL_RESIDENCIES,
		),
	};
}

function validateRoutingProfile(
	value: unknown,
	label: string,
): WireRoutingProfile {
	const record = expectExactKeys(value, label, [
		"name",
		"target",
		"runtime",
		"model",
		"thinkingLevel",
	]);
	return {
		name: expectRoutingIdentifier(record.name, `${label}.name`, 128),
		target: expectNullableRoutingIdentifier(
			record.target,
			`${label}.target`,
			128,
		),
		runtime: expectNullableRoutingIdentifier(
			record.runtime,
			`${label}.runtime`,
			128,
		),
		model: expectNullableRoutingIdentifier(record.model, `${label}.model`, 256),
		thinkingLevel: expectEnum(
			record.thinkingLevel,
			`${label}.thinkingLevel`,
			THINKING_LEVELS,
		),
	};
}

function validateRoutingBinding(
	value: unknown,
	label: string,
): WireRoutingBinding {
	const record = expectExactKeys(value, label, [
		"agentId",
		"profile",
		"target",
		"model",
		"resolved",
	]);
	const target = expectNullableRoutingIdentifier(
		record.target,
		`${label}.target`,
		128,
	);
	const model = expectNullableRoutingIdentifier(
		record.model,
		`${label}.model`,
		256,
	);
	const resolved = expectBoolean(record.resolved, `${label}.resolved`);
	if (!resolved && (target !== null || model !== null)) {
		invalid(`${label} unresolved binding cannot name a route`);
	}
	return {
		agentId: expectRoutingIdentifier(record.agentId, `${label}.agentId`, 128),
		profile: expectRoutingIdentifier(record.profile, `${label}.profile`, 128),
		target,
		model,
		resolved,
	};
}

function uniqueRoutingRows<T>(
	items: readonly T[],
	label: string,
	key: (item: T) => string,
): readonly T[] {
	if (new Set(items.map(key)).size !== items.length) {
		invalid(`${label} contains duplicate rows`);
	}
	return items;
}

function validateRoutingInspection(
	value: unknown,
	label: string,
): WireRoutingInspection {
	const record = expectExactKeys(value, label, [
		"inspectedAt",
		"models",
		"profiles",
		"bindings",
	]);
	const modelsRecord = expectExactKeys(record.models, `${label}.models`, [
		"availability",
		"items",
		"truncated",
		"emptyTargetCount",
	]);
	const profilesRecord = expectExactKeys(record.profiles, `${label}.profiles`, [
		"availability",
		"items",
		"truncated",
	]);
	const bindingsRecord = expectExactKeys(record.bindings, `${label}.bindings`, [
		"availability",
		"items",
		"truncated",
	]);
	const modelsAvailability = expectEnum(
		modelsRecord.availability,
		`${label}.models.availability`,
		ROUTING_AVAILABILITY,
	);
	const profilesAvailability = expectEnum(
		profilesRecord.availability,
		`${label}.profiles.availability`,
		ROUTING_AVAILABILITY,
	);
	const bindingsAvailability = expectEnum(
		bindingsRecord.availability,
		`${label}.bindings.availability`,
		ROUTING_AVAILABILITY,
	);
	const models = uniqueRoutingRows(
		expectArray(
			modelsRecord.items,
			`${label}.models.items`,
			MAX_WIRE_ROUTING_MODELS,
			validateRoutingModel,
		),
		`${label}.models.items`,
		(item) => `${item.targetId}\u001f${item.modelId}`,
	);
	const profiles = uniqueRoutingRows(
		expectArray(
			profilesRecord.items,
			`${label}.profiles.items`,
			MAX_WIRE_ROUTING_PROFILES,
			validateRoutingProfile,
		),
		`${label}.profiles.items`,
		(item) => item.name,
	);
	const bindings = uniqueRoutingRows(
		expectArray(
			bindingsRecord.items,
			`${label}.bindings.items`,
			MAX_WIRE_ROUTING_BINDINGS,
			validateRoutingBinding,
		),
		`${label}.bindings.items`,
		(item) => item.agentId,
	);
	const modelsTruncated = expectBoolean(
		modelsRecord.truncated,
		`${label}.models.truncated`,
	);
	const profilesTruncated = expectBoolean(
		profilesRecord.truncated,
		`${label}.profiles.truncated`,
	);
	const bindingsTruncated = expectBoolean(
		bindingsRecord.truncated,
		`${label}.bindings.truncated`,
	);
	const emptyTargetCount = expectInteger(
		modelsRecord.emptyTargetCount,
		`${label}.models.emptyTargetCount`,
	);
	if (emptyTargetCount > 64) {
		invalid(`${label}.models.emptyTargetCount exceeds the target bound`);
	}
	if (
		modelsAvailability === "failed" &&
		(models.length > 0 || modelsTruncated || emptyTargetCount > 0)
	) {
		invalid(`${label}.models cannot carry results when its adapter failed`);
	}
	if (
		profilesAvailability === "failed" &&
		(profiles.length > 0 || profilesTruncated)
	) {
		invalid(`${label}.profiles cannot carry results when its adapter failed`);
	}
	if (
		bindingsAvailability === "failed" &&
		(bindings.length > 0 || bindingsTruncated)
	) {
		invalid(`${label}.bindings cannot carry results when its adapter failed`);
	}
	return {
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		models: {
			availability: modelsAvailability,
			items: models,
			truncated: modelsTruncated,
			emptyTargetCount,
		},
		profiles: {
			availability: profilesAvailability,
			items: profiles,
			truncated: profilesTruncated,
		},
		bindings: {
			availability: bindingsAvailability,
			items: bindings,
			truncated: bindingsTruncated,
		},
	};
}

function expectDispatchNumber(
	value: unknown,
	label: string,
	integer: boolean,
): number {
	if (
		typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
		value > Number.MAX_SAFE_INTEGER
	) {
		return invalid(`${label} must be a bounded non-negative number`);
	}
	if (integer && !Number.isSafeInteger(value)) {
		return invalid(`${label} must be a safe integer`);
	}
	return value;
}

export function validateDispatchInspection(
	value: unknown,
	label = "dispatch inspection",
): WireDispatchInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"inspectedAt",
		"generatedAt",
		"admission",
		"running",
		"retryingCount",
		"totals",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const admissionRecord = expectExactKeys(
		record.admission,
		`${label}.admission`,
		["state", "expiresAt"],
	);
	const state = expectEnum(
		admissionRecord.state,
		`${label}.admission.state`,
		DISPATCH_ADMISSION_STATES,
	);
	const expiresAt = admissionRecord.expiresAt === null ? null : expectTimestamp(
		admissionRecord.expiresAt,
		`${label}.admission.expiresAt`,
	);
	if ((state === "open") !== (expiresAt === null)) {
		invalid(`${label}.admission expiry contradicts its state`);
	}
	const runningRecord = expectExactKeys(record.running, `${label}.running`, [
		"total",
		"alive",
		"stale",
		"dead",
		"unreported",
	]);
	const running = {
		total: expectDispatchNumber(
			runningRecord.total,
			`${label}.running.total`,
			true,
		),
		alive: expectDispatchNumber(
			runningRecord.alive,
			`${label}.running.alive`,
			true,
		),
		stale: expectDispatchNumber(
			runningRecord.stale,
			`${label}.running.stale`,
			true,
		),
		dead: expectDispatchNumber(
			runningRecord.dead,
			`${label}.running.dead`,
			true,
		),
		unreported: expectDispatchNumber(
			runningRecord.unreported,
			`${label}.running.unreported`,
			true,
		),
	};
	if (
		running.alive + running.stale + running.dead + running.unreported !==
			running.total
	) {
		invalid(`${label}.running categories must sum to the total`);
	}
	const totalsRecord = expectExactKeys(record.totals, `${label}.totals`, [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"runtimeSeconds",
	]);
	return {
		scope: "installation",
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		generatedAt: expectTimestamp(record.generatedAt, `${label}.generatedAt`),
		admission: { state, expiresAt },
		running,
		retryingCount: expectDispatchNumber(
			record.retryingCount,
			`${label}.retryingCount`,
			true,
		),
		totals: {
			inputTokens: expectDispatchNumber(
				totalsRecord.inputTokens,
				`${label}.totals.inputTokens`,
				true,
			),
			outputTokens: expectDispatchNumber(
				totalsRecord.outputTokens,
				`${label}.totals.outputTokens`,
				true,
			),
			totalTokens: expectDispatchNumber(
				totalsRecord.totalTokens,
				`${label}.totals.totalTokens`,
				true,
			),
			costUsd: expectDispatchNumber(
				totalsRecord.costUsd,
				`${label}.totals.costUsd`,
				false,
			),
			runtimeSeconds: expectDispatchNumber(
				totalsRecord.runtimeSeconds,
				`${label}.totals.runtimeSeconds`,
				false,
			),
		},
	};
}

export function validateFleetInspection(
	value: unknown,
	label = "fleet inspection",
): WireFleetInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"inspectedAt",
		"generatedAt",
		"runs",
		"truncated",
		"roots",
		"rootsTruncated",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const seen = new Set<string>();
	const runs = expectArray(
		record.runs,
		`${label}.runs`,
		MAX_WIRE_FLEET_INSPECTION_RUNS,
		(value, runLabel): WireFleetInspectionRun => {
			const run = expectExactKeys(value, runLabel, [
				"runId",
				"agentId",
				"model",
				"target",
				"node",
				"phase",
				"startedAt",
				"elapsedMs",
				"task",
				"journal",
				"events",
				"eventsTruncated",
				"evidence",
				"outcome",
				"outcomeDetail",
				"terminal",
			]);
			const runId = expectPresentationText(run.runId, `${runLabel}.runId`, 128);
			if (seen.has(runId)) invalid(`${label}.runs repeats ${runId}`);
			seen.add(runId);
			const evidence = expectExactKeys(run.evidence, `${runLabel}.evidence`, [
				"state",
				"summary",
			]);
			return {
				runId,
				agentId: expectPresentationText(
					run.agentId,
					`${runLabel}.agentId`,
					128,
				),
				model: expectPresentationText(run.model, `${runLabel}.model`, 256),
				target: expectPresentationText(run.target, `${runLabel}.target`, 128),
				node: expectPresentationText(run.node, `${runLabel}.node`, 128),
				phase: expectPresentationText(run.phase, `${runLabel}.phase`, 128),
				startedAt: expectTimestamp(run.startedAt, `${runLabel}.startedAt`),
				elapsedMs: expectDispatchNumber(
					run.elapsedMs,
					`${runLabel}.elapsedMs`,
					true,
				),
				task: expectNullablePresentationText(
					run.task,
					`${runLabel}.task`,
					1024,
				),
				journal: expectEnum(
					run.journal,
					`${runLabel}.journal`,
					FLEET_JOURNAL_STATES,
				),
				events: expectArray(
					run.events,
					`${runLabel}.events`,
					MAX_WIRE_FLEET_INSPECTION_EVENTS,
					(event, eventLabel) => {
						const entry = expectExactKeys(event, eventLabel, [
							"at",
							"label",
							"detail",
						]);
						return {
							at: expectTimestamp(entry.at, `${eventLabel}.at`),
							label: expectPresentationText(
								entry.label,
								`${eventLabel}.label`,
								128,
							),
							detail: expectNullablePresentationText(
								entry.detail,
								`${eventLabel}.detail`,
								512,
							),
						};
					},
				),
				eventsTruncated: expectBoolean(
					run.eventsTruncated,
					`${runLabel}.eventsTruncated`,
				),
				evidence: {
					state: expectEnum(
						evidence.state,
						`${runLabel}.evidence.state`,
						FLEET_EVIDENCE_STATES,
					),
					summary: expectPresentationText(
						evidence.summary,
						`${runLabel}.evidence.summary`,
						512,
					),
				},
				outcome: expectNullablePresentationText(
					run.outcome,
					`${runLabel}.outcome`,
					256,
				),
				outcomeDetail: expectNullablePresentationText(
					run.outcomeDetail,
					`${runLabel}.outcomeDetail`,
					512,
				),
				terminal: expectBoolean(run.terminal, `${runLabel}.terminal`),
			};
		},
	);
	const seenRoots = new Set<string>();
	const roots = expectArray(
		record.roots,
		`${label}.roots`,
		MAX_WIRE_FLEET_INSPECTION_ROOTS,
		(value, rootLabel): WireFleetInspectionRoot => {
			const root = expectExactKeys(value, rootLabel, [
				"rootId",
				"fleet",
				"startedAt",
				"elapsedMs",
				"running",
				"resumedFrom",
				"plannedSteps",
				"recordedSteps",
				"steps",
				"stepsTruncated",
			]);
			const rootId = expectPresentationText(root.rootId, `${rootLabel}.rootId`, 128);
			if (seenRoots.has(rootId)) invalid(`${label}.roots repeats ${rootId}`);
			seenRoots.add(rootId);
			const seenSteps = new Set<string>();
			const steps = expectArray(
				root.steps,
				`${rootLabel}.steps`,
				MAX_WIRE_FLEET_INSPECTION_STEPS,
				(step, stepLabel): WireFleetInspectionStep => {
					const entry = expectExactKeys(step, stepLabel, [
						"stepId",
						"runId",
						"agentId",
						"outcome",
						"detail",
					]);
					const stepId = expectPresentationText(entry.stepId, `${stepLabel}.stepId`, 128);
					if (seenSteps.has(stepId)) invalid(`${rootLabel}.steps repeats ${stepId}`);
					seenSteps.add(stepId);
					const runId = expectNullablePresentationText(entry.runId, `${stepLabel}.runId`, 128);
					const agentId = expectNullablePresentationText(entry.agentId, `${stepLabel}.agentId`, 128);
					// A step that never ran has no run to attribute, so an agent without a
					// run is a record this GUI cannot render truthfully.
					if (runId === null && agentId !== null) {
						invalid(`${stepLabel} attributes an agent to a step that never ran`);
					}
					return {
						stepId,
						runId,
						agentId,
						outcome: expectPresentationText(entry.outcome, `${stepLabel}.outcome`, 256),
						detail: expectNullablePresentationText(entry.detail, `${stepLabel}.detail`, 512),
					};
				},
			);
			const plannedSteps = expectDispatchNumber(root.plannedSteps, `${rootLabel}.plannedSteps`, true);
			const recordedSteps = expectDispatchNumber(root.recordedSteps, `${rootLabel}.recordedSteps`, true);
			if (recordedSteps > plannedSteps) {
				invalid(`${rootLabel} records more steps than it planned`);
			}
			if (steps.length > plannedSteps) {
				invalid(`${rootLabel} indexes more steps than it planned`);
			}
			return {
				rootId,
				fleet: expectPresentationText(root.fleet, `${rootLabel}.fleet`, 128),
				startedAt: expectTimestamp(root.startedAt, `${rootLabel}.startedAt`),
				elapsedMs: expectDispatchNumber(root.elapsedMs, `${rootLabel}.elapsedMs`, true),
				running: expectBoolean(root.running, `${rootLabel}.running`),
				resumedFrom: expectNullablePresentationText(root.resumedFrom, `${rootLabel}.resumedFrom`, 128),
				plannedSteps,
				recordedSteps,
				steps,
				stepsTruncated: expectBoolean(root.stepsTruncated, `${rootLabel}.stepsTruncated`),
			};
		},
	);
	return {
		scope: "installation",
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		generatedAt: expectTimestamp(record.generatedAt, `${label}.generatedAt`),
		runs,
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
		roots,
		rootsTruncated: expectBoolean(record.rootsTruncated, `${label}.rootsTruncated`),
	};
}

function expectNullableDispatchNumber(
	value: unknown,
	label: string,
	integer: boolean,
): number | null {
	return value === null ? null : expectDispatchNumber(value, label, integer);
}

/** A bounded list of distinct identity strings. */
function expectIdentityList(value: unknown, label: string): readonly string[] {
	const list = expectArray(
		value,
		label,
		MAX_WIRE_EVIDENCE_IDS,
		(entry, entryLabel) => expectPresentationText(entry, entryLabel, 128),
	);
	if (new Set(list).size !== list.length) invalid(`${label} repeats an entry`);
	return list;
}

export function validateFleetVerification(
	value: unknown,
	label = "fleet verification",
): WireFleetVerification {
	const record = expectExactKeys(value, label, ["runId", "verifiedAt", "state", "reason", "axes"]);
	const state = expectEnum(record.state, `${label}.state`, FLEET_VERIFY_STATES);
	const reason = record.reason === null ? null : expectEnum(record.reason, `${label}.reason`, FLEET_VERIFY_REASONS);
	// A receipt that authenticated, or that has not been sealed yet, has no
	// reason to give; one that did not authenticate always has one.
	if ((reason === null) !== (state === "verified" || state === "pending")) {
		invalid(`${label}.reason contradicts its state`);
	}
	// The two states that mean "there was nothing readable to check" are exactly
	// the two reasons that say so.
	if ((state === "unavailable") !== (reason === "receipt-unreadable" || reason === "envelope-unavailable")) {
		invalid(`${label}.state contradicts its reason`);
	}
	const axesRecord = expectExactKeys(record.axes, `${label}.axes`, EVIDENCE_AXES);
	const axes: Record<string, string> = {};
	for (const axis of EVIDENCE_AXES) {
		axes[axis] = expectEnum(axesRecord[axis], `${label}.axes.${axis}`, EVIDENCE_AXIS_STATES[axis]);
	}
	// A receipt that authenticated cannot report its own integrity as failed.
	if (state === "verified" && axes.artifactIntegrity === "failed") {
		invalid(`${label} verified a receipt whose integrity axis failed`);
	}
	return {
		runId: expectPresentationText(record.runId, `${label}.runId`, 128),
		verifiedAt: expectTimestamp(record.verifiedAt, `${label}.verifiedAt`),
		state,
		reason,
		axes: axes as WireFleetVerification["axes"],
	};
}

export function validateEvidenceDetail(
	value: unknown,
	label = "evidence detail",
): WireEvidenceDetail {
	const record = expectExactKeys(value, label, [
		"evidenceId",
		"sourceKind",
		"inspectedAt",
		"generatedAt",
		"canonical",
		"runs",
		"runsTruncated",
	]);
	const canonical = expectBoolean(record.canonical, `${label}.canonical`);
	const runsTruncated = expectBoolean(record.runsTruncated, `${label}.runsTruncated`);
	const seen = new Set<string>();
	const runs = expectArray(
		record.runs,
		`${label}.runs`,
		MAX_WIRE_EVIDENCE_DETAIL_RUNS,
		(value, runLabel): WireEvidenceDetailRun => {
			const run = expectExactKeys(value, runLabel, ["runId", "verdict", "axes"]);
			const runId = expectPresentationText(run.runId, `${runLabel}.runId`, 128);
			if (seen.has(runId)) invalid(`${label}.runs repeats ${runId}`);
			seen.add(runId);
			const axesRecord = expectExactKeys(run.axes, `${runLabel}.axes`, EVIDENCE_AXES);
			const axes: Record<string, string> = {};
			for (const axis of EVIDENCE_AXES) {
				axes[axis] = expectEnum(axesRecord[axis], `${runLabel}.axes.${axis}`, EVIDENCE_AXIS_STATES[axis]);
			}
			return {
				runId,
				verdict: expectEnum(run.verdict, `${runLabel}.verdict`, EVIDENCE_TRUST_VERDICTS),
				axes: axes as WireEvidenceDetailRun["axes"],
			};
		},
	);
	// A bundle with no canonical projection has no axes to report, and one that
	// reported axes is not in the historical format.
	if (!canonical && (runs.length > 0 || runsTruncated)) {
		invalid(`${label} reports runs from a non-canonical projection`);
	}
	return {
		evidenceId: expectPresentationText(record.evidenceId, `${label}.evidenceId`, 128),
		sourceKind: expectEnum(record.sourceKind, `${label}.sourceKind`, EVIDENCE_SOURCE_KINDS),
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		generatedAt: expectTimestamp(record.generatedAt, `${label}.generatedAt`),
		canonical,
		runs,
		runsTruncated,
	};
}

export function validateEvidenceInspection(
	value: unknown,
	label = "evidence inspection",
): WireEvidenceInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"inspectedAt",
		"generatedAt",
		"artifacts",
		"truncated",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const seen = new Set<string>();
	const artifacts = expectArray(
		record.artifacts,
		`${label}.artifacts`,
		MAX_WIRE_EVIDENCE_ARTIFACTS,
		(value, rowLabel): WireEvidenceArtifact => {
			const artifact = expectExactKeys(value, rowLabel, [
				"evidenceId",
				"sourceKind",
				"generatedAt",
				"startedAt",
				"endedAt",
				"runIds",
				"runIdsTruncated",
				"agentIds",
				"statuses",
				"tags",
				"totals",
				"redactionCount",
				"trust",
			]);
			const evidenceId = expectPresentationText(artifact.evidenceId, `${rowLabel}.evidenceId`, 128);
			if (seen.has(evidenceId)) invalid(`${label}.artifacts repeats ${evidenceId}`);
			seen.add(evidenceId);
			const totals = expectExactKeys(artifact.totals, `${rowLabel}.totals`, [
				"runs",
				"receipts",
				"toolCalls",
				"toolErrors",
				"blockedToolCalls",
				"protectedArtifacts",
				"tokens",
				"costUsd",
				"wallTimeMs",
			]);
			const toolCalls = expectDispatchNumber(totals.toolCalls, `${rowLabel}.totals.toolCalls`, true);
			const toolErrors = expectDispatchNumber(totals.toolErrors, `${rowLabel}.totals.toolErrors`, true);
			// A failed call is a subset of the calls that were attempted.
			if (toolErrors > toolCalls) {
				invalid(`${rowLabel}.totals reports more tool errors than tool calls`);
			}
			const trust = expectExactKeys(artifact.trust, `${rowLabel}.trust`, [
				"verdict",
				"runsCovered",
				"historical",
			]);
			const verdict = expectEnum(trust.verdict, `${rowLabel}.trust.verdict`, EVIDENCE_TRUST_VERDICTS);
			const runsCovered = expectDispatchNumber(trust.runsCovered, `${rowLabel}.trust.runsCovered`, true);
			const historical = expectBoolean(trust.historical, `${rowLabel}.trust.historical`);
			// A bundle with no canonical trust record has no verdict of its own,
			// and one that recorded runs is no longer in the historical format.
			if (historical && (runsCovered > 0 || verdict !== "unknown")) {
				invalid(`${rowLabel}.trust contradicts its historical projection`);
			}
			return {
				evidenceId,
				sourceKind: expectEnum(artifact.sourceKind, `${rowLabel}.sourceKind`, EVIDENCE_SOURCE_KINDS),
				generatedAt: expectTimestamp(artifact.generatedAt, `${rowLabel}.generatedAt`),
				startedAt: expectNullableTimestamp(artifact.startedAt, `${rowLabel}.startedAt`),
				endedAt: expectNullableTimestamp(artifact.endedAt, `${rowLabel}.endedAt`),
				runIds: expectIdentityList(artifact.runIds, `${rowLabel}.runIds`),
				runIdsTruncated: expectBoolean(artifact.runIdsTruncated, `${rowLabel}.runIdsTruncated`),
				agentIds: expectIdentityList(artifact.agentIds, `${rowLabel}.agentIds`),
				statuses: expectIdentityList(artifact.statuses, `${rowLabel}.statuses`),
				tags: expectIdentityList(artifact.tags, `${rowLabel}.tags`),
				totals: {
					runs: expectDispatchNumber(totals.runs, `${rowLabel}.totals.runs`, true),
					receipts: expectDispatchNumber(totals.receipts, `${rowLabel}.totals.receipts`, true),
					toolCalls,
					toolErrors,
					blockedToolCalls: expectDispatchNumber(
						totals.blockedToolCalls,
						`${rowLabel}.totals.blockedToolCalls`,
						true,
					),
					protectedArtifacts: expectDispatchNumber(
						totals.protectedArtifacts,
						`${rowLabel}.totals.protectedArtifacts`,
						true,
					),
					tokens: expectDispatchNumber(totals.tokens, `${rowLabel}.totals.tokens`, true),
					costUsd: expectDispatchNumber(totals.costUsd, `${rowLabel}.totals.costUsd`, false),
					wallTimeMs: expectDispatchNumber(totals.wallTimeMs, `${rowLabel}.totals.wallTimeMs`, true),
				},
				redactionCount: expectDispatchNumber(artifact.redactionCount, `${rowLabel}.redactionCount`, true),
				trust: { verdict, runsCovered, historical },
			};
		},
	);
	return {
		scope: "installation",
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		generatedAt: expectTimestamp(record.generatedAt, `${label}.generatedAt`),
		artifacts,
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
	};
}

export function validateTraceInspection(
	value: unknown,
	label = "trace inspection",
): WireTraceInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"inspectedAt",
		"generatedAt",
		"available",
		"runs",
		"truncated",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const available = expectBoolean(record.available, `${label}.available`);
	const truncated = expectBoolean(record.truncated, `${label}.truncated`);
	const seen = new Set<string>();
	const runs = expectArray(
		record.runs,
		`${label}.runs`,
		MAX_WIRE_TRACE_RUNS,
		(value, runLabel): WireTraceRun => {
			const run = expectExactKeys(value, runLabel, [
				"runId",
				"agent",
				"target",
				"model",
				"runtime",
				"node",
				"status",
				"startedAt",
				"elapsedMs",
				"totalTokens",
				"totalCostUsd",
				"phases",
				"phasesTruncated",
			]);
			const runId = expectPresentationText(run.runId, `${runLabel}.runId`, 128);
			if (seen.has(runId)) invalid(`${label}.runs repeats ${runId}`);
			seen.add(runId);
			return {
				runId,
				agent: expectPresentationText(run.agent, `${runLabel}.agent`, 128),
				target: expectPresentationText(run.target, `${runLabel}.target`, 128),
				model: expectPresentationText(run.model, `${runLabel}.model`, 256),
				runtime: expectPresentationText(run.runtime, `${runLabel}.runtime`, 128),
				node: expectNullablePresentationText(run.node, `${runLabel}.node`, 128),
				status: expectPresentationText(run.status, `${runLabel}.status`, 64),
				startedAt: expectTimestamp(run.startedAt, `${runLabel}.startedAt`),
				elapsedMs: expectNullableDispatchNumber(run.elapsedMs, `${runLabel}.elapsedMs`, true),
				totalTokens: expectNullableDispatchNumber(run.totalTokens, `${runLabel}.totalTokens`, true),
				totalCostUsd: expectNullableDispatchNumber(run.totalCostUsd, `${runLabel}.totalCostUsd`, false),
				phases: expectArray(
					run.phases,
					`${runLabel}.phases`,
					MAX_WIRE_TRACE_PHASES,
					(phase, phaseLabel): WireTracePhase => {
						const entry = expectExactKeys(phase, phaseLabel, [
							"name",
							"kind",
							"owner",
							"status",
							"attempt",
							"retries",
							"failed",
							"elapsedMs",
							"totalTokens",
							"totalCostUsd",
						]);
						return {
							name: expectPresentationText(entry.name, `${phaseLabel}.name`, 128),
							kind: expectPresentationText(entry.kind, `${phaseLabel}.kind`, 64),
							owner: expectPresentationText(entry.owner, `${phaseLabel}.owner`, 128),
							status: expectPresentationText(entry.status, `${phaseLabel}.status`, 64),
							attempt: expectDispatchNumber(entry.attempt, `${phaseLabel}.attempt`, true),
							retries: expectDispatchNumber(entry.retries, `${phaseLabel}.retries`, true),
							failed: expectBoolean(entry.failed, `${phaseLabel}.failed`),
							elapsedMs: expectNullableDispatchNumber(entry.elapsedMs, `${phaseLabel}.elapsedMs`, true),
							totalTokens: expectNullableDispatchNumber(entry.totalTokens, `${phaseLabel}.totalTokens`, true),
							totalCostUsd: expectNullableDispatchNumber(entry.totalCostUsd, `${phaseLabel}.totalCostUsd`, false),
						};
					},
				),
				phasesTruncated: expectBoolean(run.phasesTruncated, `${runLabel}.phasesTruncated`),
			};
		},
	);
	// A trace database that was never written has nothing to have read, so rows
	// or a truncation alongside that claim describe two different installations.
	if (!available && (runs.length > 0 || truncated)) {
		invalid(`${label} reports rows from an unavailable trace database`);
	}
	return {
		scope: "installation",
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		generatedAt: expectTimestamp(record.generatedAt, `${label}.generatedAt`),
		available,
		runs,
		truncated,
	};
}

function expectToolVersion(value: unknown, label: string, nullable = false): string | null {
	const text = nullable ? expectNullablePresentationText(value, label, 64) : expectPresentationText(value, label, 64);
	if (text !== null && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(text)) {
		invalid(`${label} must be a semantic version`);
	}
	return text;
}

export function validateToolchainInspection(
	value: unknown,
	label = "toolchain inspection",
): WireToolchainInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"inspectedAt",
		"tools",
		"truncated",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const seen = new Set<string>();
	const tools = expectArray(
		record.tools,
		`${label}.tools`,
		MAX_WIRE_TOOLCHAIN_ITEMS,
		(value, itemLabel): WireToolchainItem => {
			const item = expectExactKeys(value, itemLabel, [
				"id",
				"pinnedVersion",
				"license",
				"platform",
				"supported",
				"installed",
				"source",
				"foundVersion",
				"minimumVersion",
				"pathCandidate",
			]);
			const id = expectPresentationText(item.id, `${itemLabel}.id`, 64);
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) || seen.has(id)) {
				invalid(`${itemLabel}.id must be unique and tool-shaped`);
			}
			seen.add(id);
			const source = expectEnum(item.source, `${itemLabel}.source`, TOOLCHAIN_SOURCES);
			const foundVersion = expectToolVersion(item.foundVersion, `${itemLabel}.foundVersion`, true);
			if ((source === "none") !== (foundVersion === null)) {
				invalid(`${itemLabel} has contradictory resolution facts`);
			}
			const platform = expectNullablePresentationText(item.platform, `${itemLabel}.platform`, 64);
			if (platform !== null && !/^[a-z0-9]+-[a-z0-9_]+$/u.test(platform)) {
				invalid(`${itemLabel}.platform is invalid`);
			}
			const license = expectPresentationText(item.license, `${itemLabel}.license`, 64);
			if (!/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/u.test(license)) {
				invalid(`${itemLabel}.license is invalid`);
			}
			let pathCandidate: WireToolchainItem["pathCandidate"] = null;
			if (item.pathCandidate !== null) {
				const candidate = expectExactKeys(item.pathCandidate, `${itemLabel}.pathCandidate`, [
					"version",
					"satisfiesMinimum",
				]);
				pathCandidate = {
					version: expectToolVersion(candidate.version, `${itemLabel}.pathCandidate.version`, true),
					satisfiesMinimum: expectBoolean(
						candidate.satisfiesMinimum,
						`${itemLabel}.pathCandidate.satisfiesMinimum`,
					),
				};
				if (pathCandidate.satisfiesMinimum && source !== "path") {
					invalid(`${itemLabel} has contradictory PATH candidate facts`);
				}
			}
			return {
				id,
				pinnedVersion: expectToolVersion(item.pinnedVersion, `${itemLabel}.pinnedVersion`) as string,
				license,
				platform,
				supported: expectBoolean(item.supported, `${itemLabel}.supported`),
				installed: expectBoolean(item.installed, `${itemLabel}.installed`),
				source,
				foundVersion,
				minimumVersion: expectToolVersion(item.minimumVersion, `${itemLabel}.minimumVersion`) as string,
				pathCandidate,
			};
		},
	);
	return {
		scope: "installation",
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		tools,
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
	};
}

function validateRecoveryCounts(
	value: unknown,
	label: string,
): WireRecoveryCounts {
	const record = expectExactKeys(value, label, [
		"checks",
		"passed",
		"warnings",
		"failures",
	]);
	const counts = {
		checks: expectDispatchNumber(record.checks, `${label}.checks`, true),
		passed: expectDispatchNumber(record.passed, `${label}.passed`, true),
		warnings: expectDispatchNumber(record.warnings, `${label}.warnings`, true),
		failures: expectDispatchNumber(record.failures, `${label}.failures`, true),
	};
	if (counts.passed + counts.warnings + counts.failures !== counts.checks) {
		invalid(`${label} severity counts must sum to checks`);
	}
	return counts;
}

export function validateRecoveryInspection(
	value: unknown,
	label = "recovery inspection",
): WireRecoveryInspection {
	const record = expectExactKeys(value, label, [
		"scope",
		"projectContext",
		"inspectedAt",
		"healthy",
		"pathsResolved",
		"versions",
		"summary",
		"sections",
		"checks",
		"checksTruncated",
	]);
	if (record.scope !== "installation") {
		invalid(`${label}.scope must be installation`);
	}
	const pathsResolved = expectDispatchNumber(
		record.pathsResolved,
		`${label}.pathsResolved`,
		true,
	);
	if (pathsResolved !== 4) {
		invalid(`${label}.pathsResolved must describe all four fixed roots`);
	}
	const versionsRecord = expectExactKeys(record.versions, `${label}.versions`, [
		"clioCoder",
		"node",
		"platform",
	]);
	const versions = {
		clioCoder: expectNullablePresentationText(
			versionsRecord.clioCoder,
			`${label}.versions.clioCoder`,
			64,
		),
		node: expectNullablePresentationText(
			versionsRecord.node,
			`${label}.versions.node`,
			64,
		),
		platform: expectNullablePresentationText(
			versionsRecord.platform,
			`${label}.versions.platform`,
			64,
		),
	};
	const summary = validateRecoveryCounts(record.summary, `${label}.summary`);
	if (summary.checks === 0) {
		invalid(`${label}.summary must contain at least one reported check`);
	}
	const seen = new Set<WireRecoverySectionId>();
	const sections = expectArray(
		record.sections,
		`${label}.sections`,
		RECOVERY_SECTION_IDS.length,
		(row, rowLabel): WireRecoverySection => {
			const sectionRecord = expectExactKeys(row, rowLabel, [
				"id",
				"checks",
				"passed",
				"warnings",
				"failures",
			]);
			const id = expectEnum(
				sectionRecord.id,
				`${rowLabel}.id`,
				RECOVERY_SECTION_IDS,
			);
			if (seen.has(id)) invalid(`${label}.sections repeats ${id}`);
			seen.add(id);
			const counts = validateRecoveryCounts(
				{
					checks: sectionRecord.checks,
					passed: sectionRecord.passed,
					warnings: sectionRecord.warnings,
					failures: sectionRecord.failures,
				},
				rowLabel,
			);
			return { id, ...counts };
		},
	);
	const sectionTotals = sections.reduce<WireRecoveryCounts>(
		(total, section) => ({
			checks: total.checks + section.checks,
			passed: total.passed + section.passed,
			warnings: total.warnings + section.warnings,
			failures: total.failures + section.failures,
		}),
		{ checks: 0, passed: 0, warnings: 0, failures: 0 },
	);
	if (
		sectionTotals.checks !== summary.checks ||
		sectionTotals.passed !== summary.passed ||
		sectionTotals.warnings !== summary.warnings ||
		sectionTotals.failures !== summary.failures
	) invalid(`${label}.sections contradict the summary`);
	const healthy = expectBoolean(record.healthy, `${label}.healthy`);
	if (healthy !== (summary.failures === 0)) {
		invalid(`${label}.healthy contradicts its failure count`);
	}
	const checksTruncated = expectBoolean(
		record.checksTruncated,
		`${label}.checksTruncated`,
	);
	const checks = expectArray(
		record.checks,
		`${label}.checks`,
		MAX_WIRE_RECOVERY_CHECKS,
		(row, rowLabel): WireRecoveryCheck => {
			const checkRecord = expectExactKeys(row, rowLabel, [
				"name",
				"section",
				"level",
			]);
			const name = expectNullablePresentationText(
				checkRecord.name,
				`${rowLabel}.name`,
				96,
			);
			// A name that reached here unsafe means the host projection did not do
			// its job, so this rejects rather than redacting on the browser's behalf.
			if (name !== null && !isSafeRecoveryCheckName(name)) {
				invalid(`${rowLabel}.name is not a safe diagnostic check name`);
			}
			return {
				name,
				section: expectEnum(
					checkRecord.section,
					`${rowLabel}.section`,
					RECOVERY_SECTION_IDS,
				),
				level: expectEnum(
					checkRecord.level,
					`${rowLabel}.level`,
					RECOVERY_CHECK_LEVELS,
				),
			};
		},
	);
	if (
		checksTruncated
			? checks.length !== MAX_WIRE_RECOVERY_CHECKS || summary.checks <= MAX_WIRE_RECOVERY_CHECKS
			: checks.length !== summary.checks
	) invalid(`${label}.checks contradict the reported check count`);
	// The per-check verdicts and the per-section tallies are two projections of
	// one sweep, so they have to agree wherever the list is complete.
	if (!checksTruncated) {
		for (const section of sections) {
			const rows = checks.filter((check) => check.section === section.id);
			if (
				rows.length !== section.checks ||
				rows.filter((check) => check.level === "ok").length !== section.passed ||
				rows.filter((check) => check.level === "warn").length !== section.warnings ||
				rows.filter((check) => check.level === "error").length !== section.failures
			) invalid(`${label}.checks contradict section ${section.id}`);
		}
	}
	return {
		scope: "installation",
		projectContext: expectBoolean(
			record.projectContext,
			`${label}.projectContext`,
		),
		inspectedAt: expectTimestamp(record.inspectedAt, `${label}.inspectedAt`),
		healthy,
		pathsResolved,
		versions,
		summary,
		sections,
		checks,
		checksTruncated,
	};
}

function validateTargetHealth(value: unknown, label: string): WireTargetHealth {
	const record = expectExactKeys(value, label, [
		"healthy",
		"latencyMs",
		"reason",
		"probedAt",
	]);
	return {
		healthy: expectBoolean(record.healthy, `${label}.healthy`),
		latencyMs: record.latencyMs === null ? null : expectInteger(record.latencyMs, `${label}.latencyMs`),
		reason: expectNullablePresentationText(
			record.reason,
			`${label}.reason`,
			128,
		),
		probedAt: expectTimestamp(record.probedAt, `${label}.probedAt`),
	};
}

function validateTarget(value: unknown, label: string): WireTarget {
	const record = expectExactKeys(value, label, [
		"id",
		"runtime",
		"models",
		"isOrchestrator",
		"health",
	]);
	return {
		id: expectPresentationText(record.id, `${label}.id`, 128),
		runtime: expectPresentationText(record.runtime, `${label}.runtime`, 64),
		models: expectArray(
			record.models,
			`${label}.models`,
			64,
			(entry, entryLabel) => expectPresentationText(entry, entryLabel, 256),
		),
		isOrchestrator: expectBoolean(
			record.isOrchestrator,
			`${label}.isOrchestrator`,
		),
		health: record.health === null ? null : validateTargetHealth(record.health, `${label}.health`),
	};
}

function validateTargets(value: unknown, label: string): readonly WireTarget[] {
	return expectArray(value, label, 64, validateTarget);
}

function validateWireWorkspace(
	value: unknown,
	label: string,
): WireProjectWorkspace {
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
		"usageInspection",
		"routingInspection",
		"targets",
		"targetsTruncated",
		"fleet",
		"processGeneration",
		"lastSequence",
	]);
	return {
		project: validateWireProjectSummary(record.project, `${label}.project`),
		tree: validateWireTree(record.tree, `${label}.tree`),
		treeTruncated: expectBoolean(
			record.treeTruncated,
			`${label}.treeTruncated`,
		),
		sessions: expectArray(
			record.sessions,
			`${label}.sessions`,
			MAX_WIRE_COLLECTION_ENTRIES,
			validateWireSessionSummary,
		),
		sessionsTruncated: expectBoolean(
			record.sessionsTruncated,
			`${label}.sessionsTruncated`,
		),
		clio: validateClioSnapshot(record.clio, `${label}.clio`),
		timeline: expectArray(
			record.timeline,
			`${label}.timeline`,
			MAX_WIRE_TIMELINE_ENTRIES,
			validateWireTimelineItem,
		),
		timelineTruncated: expectBoolean(
			record.timelineTruncated,
			`${label}.timelineTruncated`,
		),
		activeTurn: record.activeTurn === null ? null : validateActiveTurn(record.activeTurn, `${label}.activeTurn`),
		pendingPermission: record.pendingPermission === null ? null : validateWirePendingPermission(
			record.pendingPermission,
			`${label}.pendingPermission`,
		),
		deleteChallenge: record.deleteChallenge === null ? null : validateWireDeleteChallenge(
			record.deleteChallenge,
			`${label}.deleteChallenge`,
		),
		settings: record.settings === null ? null : validateSettingsState(record.settings, `${label}.settings`),
		configInspection: record.configInspection === null ? null : validateConfigInspection(
			record.configInspection,
			`${label}.configInspection`,
		),
		catalogInspection: record.catalogInspection === null ? null : validateCatalogInspection(
			record.catalogInspection,
			`${label}.catalogInspection`,
		),
		usageInspection: record.usageInspection === null ? null : validateUsageInspection(
			record.usageInspection,
			`${label}.usageInspection`,
		),
		routingInspection: record.routingInspection === null ? null : validateRoutingInspection(
			record.routingInspection,
			`${label}.routingInspection`,
		),
		targets: record.targets === null ? null : validateTargets(record.targets, `${label}.targets`),
		targetsTruncated: expectBoolean(
			record.targetsTruncated,
			`${label}.targetsTruncated`,
		),
		fleet: expectArray(
			record.fleet,
			`${label}.fleet`,
			MAX_WIRE_FLEET_RUNS,
			validateFleetRun,
		),
		processGeneration: expectNullableId(
			record.processGeneration,
			`${label}.processGeneration`,
		),
		lastSequence: expectInteger(record.lastSequence, `${label}.lastSequence`),
	};
}

function validateProjectSnapshotPayload(
	value: unknown,
	label: string,
): ProjectSnapshotPayload {
	const record = expectExactKeys(value, label, ["tree", "treeTruncated"]);
	return {
		tree: validateWireTree(record.tree, `${label}.tree`),
		treeTruncated: expectBoolean(
			record.treeTruncated,
			`${label}.treeTruncated`,
		),
	};
}

function validateBrowseListing(
	value: unknown,
	label: string,
): ProjectBrowseListingPayload {
	const record = expectExactKeys(value, label, [
		"path",
		"parent",
		"entries",
		"truncated",
		"openable",
		"reason",
	]);
	return {
		path: expectNativePath(record.path, `${label}.path`),
		parent: record.parent === null ? null : expectNativePath(record.parent, `${label}.parent`),
		entries: expectArray(
			record.entries,
			`${label}.entries`,
			MAX_WIRE_BROWSE_ENTRIES,
			(entry, entryLabel) => {
				const entryRecord = expectExactKeys(entry, entryLabel, [
					"name",
					"hidden",
					"guarded",
				]);
				return {
					name: expectEntryName(entryRecord.name, `${entryLabel}.name`),
					hidden: expectBoolean(entryRecord.hidden, `${entryLabel}.hidden`),
					guarded: expectBoolean(entryRecord.guarded, `${entryLabel}.guarded`),
				};
			},
		),
		truncated: expectBoolean(record.truncated, `${label}.truncated`),
		openable: expectBoolean(record.openable, `${label}.openable`),
		reason: expectNullablePresentationText(
			record.reason,
			`${label}.reason`,
			512,
		),
	};
}

function expectStreamText(value: unknown, label: string): string {
	const text = expectString(value, label, { minBytes: 1, maxBytes: 16 * 1024 });
	if (hasUnsafePresentationCharacter(text)) {
		invalid(`${label} contains an unsafe control character`);
	}
	return text;
}

function validateUsage(value: unknown, label: string): WireUsage {
	const record = expectExactKeys(value, label, [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"reasoning",
	]);
	return {
		input: expectInteger(record.input, `${label}.input`),
		output: expectInteger(record.output, `${label}.output`),
		cacheRead: expectInteger(record.cacheRead, `${label}.cacheRead`),
		cacheWrite: expectInteger(record.cacheWrite, `${label}.cacheWrite`),
		reasoning: expectInteger(record.reasoning, `${label}.reasoning`),
	};
}

function validateServerPayload(
	kind: ServerEventKind,
	value: unknown,
): ServerEventPayloadByKind[ServerEventKind] {
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
			return {
				workspace: validateWireWorkspace(
					record.workspace,
					`${label}.workspace`,
				),
			};
		}
		case "fs.delete.challenge":
			return validateWireDeleteChallenge(value, label);
		case "clio.state": {
			const record = expectExactKeys(value, label, ["snapshot"]);
			return {
				snapshot: validateClioSnapshot(record.snapshot, `${label}.snapshot`),
			};
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
			return {
				settings: validateSettingsState(record.settings, `${label}.settings`),
			};
		}
		case "config.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateConfigInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "catalog.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateCatalogInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "usage.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateUsageInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "routing.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateRoutingInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "dispatch.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateDispatchInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "fleet.inspection.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateFleetInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "toolchain.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateToolchainInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "trace.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateTraceInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "evidence.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateEvidenceInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
		}
		case "evidence.detail.state": {
			const record = expectExactKeys(value, label, ["detail"]);
			return { detail: validateEvidenceDetail(record.detail, `${label}.detail`) };
		}
		case "fleet.verification.state": {
			const record = expectExactKeys(value, label, ["verification"]);
			return { verification: validateFleetVerification(record.verification, `${label}.verification`) };
		}
		case "recovery.state": {
			const record = expectExactKeys(value, label, ["inspection"]);
			return {
				inspection: validateRecoveryInspection(
					record.inspection,
					`${label}.inspection`,
				),
			};
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
				targetId: expectPresentationText(
					record.targetId,
					`${label}.targetId`,
					128,
				),
				health: validateTargetHealth(record.health, `${label}.health`),
			};
		}
		case "turn.started": {
			const record = expectExactKeys(value, label, [
				"promptSummary",
				"origin",
				"startedAt",
				"source",
			]);
			const origin = expectEnum(
				record.origin,
				`${label}.origin`,
				["live", "replay"] as const,
			);
			const startedAt = record.startedAt === null ? null : expectTimestamp(record.startedAt, `${label}.startedAt`);
			const source = validateEventSource(record.source, `${label}.source`);
			if (origin === "replay") {
				if (startedAt !== null) {
					invalid(`${label}.startedAt must be null for replay history`);
				}
				if (source !== "replayed-from-clio") {
					invalid(`${label}.source must identify replay history`);
				}
			} else {
				if (startedAt === null) {
					invalid(`${label}.startedAt must identify when a live turn began`);
				}
				if (source === "replayed-from-clio") {
					invalid(
						`${label}.source cannot identify a live turn as replay history`,
					);
				}
			}
			return {
				promptSummary: expectPresentationText(
					record.promptSummary,
					`${label}.promptSummary`,
					8 * 1024,
				),
				origin,
				startedAt,
				source,
			};
		}
		case "turn.text":
		case "turn.thought": {
			const record = expectExactKeys(value, label, [
				"text",
				"agents",
				"source",
			]);
			return {
				text: expectStreamText(record.text, `${label}.text`),
				agents: validateAgentAttributions(record.agents, `${label}.agents`),
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
				"agents",
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
				agents: validateAgentAttributions(record.agents, `${label}.agents`),
				source: validateEventSource(record.source, `${label}.source`),
			};
		}
		case "fleet.activity": {
			const record = expectExactKeys(value, label, ["run", "source"]);
			return {
				run: validateFleetRun(record.run, `${label}.run`),
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
			if (record.toolCallId !== null) {
				invalid(`${label}.toolCallId must be null for event version 1`);
			}
			if (record.shape !== null) {
				invalid(`${label}.shape must be null for event version 1`);
			}
			return {
				toolCallId: null,
				tool: expectPresentationText(record.tool, `${label}.tool`, 64),
				repeatCount: expectInteger(record.repeatCount, `${label}.repeatCount`),
				blocksThisTurn: expectInteger(
					record.blocksThisTurn,
					`${label}.blocksThisTurn`,
				),
				budget: expectInteger(record.budget, `${label}.budget`),
				disposition: expectEnum(
					record.disposition,
					`${label}.disposition`,
					LOOP_DISPOSITIONS,
				),
				interrupted: expectBoolean(record.interrupted, `${label}.interrupted`),
				shape: null,
				source: validateEventSource(record.source, `${label}.source`),
			};
		}
		case "turn.permission.requested":
			return validateWirePendingPermission(value, label);
		case "turn.permission.resolved": {
			const record = expectExactKeys(value, label, [
				"permissionId",
				"decision",
				"source",
			]);
			return {
				permissionId: expectId(record.permissionId, `${label}.permissionId`),
				decision: expectEnum(
					record.decision,
					`${label}.decision`,
					PERMISSION_RESOLUTIONS,
				),
				source: validateEventSource(record.source, `${label}.source`),
			};
		}
		case "turn.terminal": {
			const record = expectExactKeys(value, label, [
				"outcome",
				"code",
				"summary",
				"source",
			], [
				"stopReason",
				"usage",
			]);
			const stopReason = Object.hasOwn(record, "stopReason")
				? expectEnum(
					record.stopReason,
					`${label}.stopReason`,
					TURN_STOP_REASONS,
				)
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
			const record = expectExactKeys(value, label, ["code", "message"], [
				"requestId",
			]);
			const requestId = Object.hasOwn(record, "requestId")
				? expectId(record.requestId, `${label}.requestId`)
				: undefined;
			return {
				code: expectEnum(
					record.code,
					`${label}.code`,
					[
						"unsupported-version",
						"invalid-frame",
						"sequence-error",
						"internal",
					] as const,
				),
				message: expectSanitizedMessage(record.message, `${label}.message`),
				...(requestId === undefined ? {} : { requestId }),
			};
		}
		case "command.error": {
			const record = expectExactKeys(value, label, ["code", "message"], [
				"requestId",
			]);
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

function parseJsonFrame(
	frame: string,
	maximumBytes: number,
	label: string,
): unknown {
	if (typeof frame !== "string") {
		throw new ProtocolValidationError(
			"invalid-frame",
			`${label} must be a text frame`,
		);
	}
	if (utf8Bytes(frame) > maximumBytes) {
		throw new ProtocolValidationError(
			"frame-too-large",
			`${label} exceeds ${maximumBytes} bytes`,
		);
	}
	try {
		return JSON.parse(frame) as unknown;
	} catch {
		throw new ProtocolValidationError(
			"invalid-frame",
			`${label} is not valid JSON`,
		);
	}
}

function encodeJsonFrame(
	value: unknown,
	maximumBytes: number,
	label: string,
): string {
	let frame: string;
	try {
		frame = JSON.stringify(value);
	} catch {
		throw new ProtocolValidationError(
			"invalid-frame",
			`${label} is not JSON serializable`,
		);
	}
	if (typeof frame !== "string") {
		throw new ProtocolValidationError(
			"invalid-frame",
			`${label} is not JSON serializable`,
		);
	}
	if (utf8Bytes(frame) > maximumBytes) {
		throw new ProtocolValidationError(
			"frame-too-large",
			`${label} exceeds ${maximumBytes} bytes`,
		);
	}
	return frame;
}

export function validateClientCommand(value: unknown): ClientCommand {
	const record = expectExactKeys(value, "client command", [
		"protocolVersion",
		"requestId",
		"kind",
		"payload",
	]);
	if (record.protocolVersion !== PROTOCOL_VERSION) {
		throw new ProtocolValidationError(
			"unsupported-version",
			`client command protocolVersion must be ${PROTOCOL_VERSION}`,
		);
	}
	const kind = expectEnum(
		record.kind,
		"client command.kind",
		CLIENT_COMMAND_KINDS,
	);
	return {
		protocolVersion: PROTOCOL_VERSION,
		requestId: expectId(record.requestId, "client command.requestId"),
		kind,
		payload: validateClientPayload(kind, record.payload),
	} as ClientCommand;
}

export function parseClientCommand(frame: string): ClientCommand {
	return validateClientCommand(
		parseJsonFrame(frame, MAX_CLIENT_FRAME_BYTES, "client frame"),
	);
}

export function encodeClientCommand(command: ClientCommand): string {
	return encodeJsonFrame(
		validateClientCommand(command),
		MAX_CLIENT_FRAME_BYTES,
		"client frame",
	);
}

const NO_CONTEXT_EVENT_KINDS = new Set<ServerEventKind>([
	"connection.ready",
	"protocol.error",
	"project.browse.listing",
	"dispatch.state",
	"fleet.inspection.state",
	"toolchain.state",
	"trace.state",
	"evidence.state",
	"evidence.detail.state",
	"fleet.verification.state",
	"recovery.state",
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
	"usage.state",
	"routing.state",
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
): Pick<
	ServerEnvelopeBase<ServerEventKind>,
	"projectId" | "processGeneration" | "sessionId" | "turnId"
> {
	const hasProject = Object.hasOwn(record, "projectId");
	const hasGeneration = Object.hasOwn(record, "processGeneration");
	const hasSession = Object.hasOwn(record, "sessionId");
	const hasTurn = Object.hasOwn(record, "turnId");

	if (NO_CONTEXT_EVENT_KINDS.has(kind)) {
		if (hasProject || hasGeneration || hasSession || hasTurn) {
			invalid(
				`${kind} must not carry project, process-generation, session, or turn IDs`,
			);
		}
		return {};
	}
	if (PROJECT_CONTEXT_EVENT_KINDS.has(kind)) {
		if (!hasProject || hasGeneration || hasSession || hasTurn) {
			invalid(`${kind} must carry only a projectId context`);
		}
		return { projectId: expectId(record.projectId, "server event.projectId") };
	}
	if (TURN_EVENT_KINDS.has(kind)) {
		if (!hasProject || !hasGeneration || !hasSession || !hasTurn) {
			invalid(
				`${kind} must carry projectId, processGeneration, sessionId, and turnId`,
			);
		}
		return {
			projectId: expectId(record.projectId, "server event.projectId"),
			processGeneration: expectId(
				record.processGeneration,
				"server event.processGeneration",
			),
			sessionId: expectId(record.sessionId, "server event.sessionId"),
			turnId: expectId(record.turnId, "server event.turnId"),
		};
	}
	// command.error may be global or scoped. Context must remain hierarchical.
	if (hasGeneration) invalid(`${kind} cannot carry a process generation`);
	if (hasTurn && !hasSession) {
		invalid(`${kind} cannot carry turnId without sessionId`);
	}
	if ((hasSession || hasTurn) && !hasProject) {
		invalid(`${kind} cannot carry session/turn IDs without projectId`);
	}
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
		[
			"protocolVersion",
			"workspaceInstanceId",
			"sequence",
			"eventId",
			"kind",
			"terminal",
			"payload",
		],
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
		workspaceInstanceId: expectId(
			record.workspaceInstanceId,
			"server event.workspaceInstanceId",
		),
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
	return validateServerEvent(
		parseJsonFrame(frame, MAX_SERVER_EVENT_BYTES, "server event frame"),
	);
}

export function encodeServerEvent(event: ServerEvent): string {
	return encodeJsonFrame(
		validateServerEvent(event),
		MAX_SERVER_EVENT_BYTES,
		"server event frame",
	);
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

	constructor(
		nextSequence = 1,
		maximumEvents = MAX_SERVER_EVENTS_PER_CONNECTION,
	) {
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
		if (
			this.#workspaceInstanceId !== undefined &&
			event.workspaceInstanceId !== this.#workspaceInstanceId
		) {
			throw new ProtocolValidationError(
				"sequence-error",
				"server event workspace instance changed mid-stream",
			);
		}

		const fingerprint = canonicalJson(event);
		if (
			event.sequence === this.#nextSequence - 1 &&
			this.#lastFingerprint !== undefined
		) {
			if (fingerprint === this.#lastFingerprint) return "duplicate";
			throw new ProtocolValidationError(
				"sequence-error",
				`conflicting server event at sequence ${event.sequence}`,
			);
		}
		if (event.sequence < this.#nextSequence) {
			throw new ProtocolValidationError(
				"sequence-error",
				`server event sequence regressed to ${event.sequence}`,
			);
		}
		if (event.sequence > this.#nextSequence) {
			throw new ProtocolValidationError(
				"sequence-error",
				`server event sequence gap: expected ${this.#nextSequence}, received ${event.sequence}`,
			);
		}
		if (this.#eventIds.has(event.eventId)) {
			throw new ProtocolValidationError(
				"sequence-error",
				`server eventId ${event.eventId} was reused`,
			);
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
export type DisconnectCause =
	| "client-close"
	| "remote-close"
	| "network-error"
	| "protocol-error";

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
	onDisconnect(
		listener: (disconnect: LocalTransportDisconnect) => void,
	): () => void;
	close(code?: number, reason?: string): void;
}

export interface WebSocketLocalTransportOptions {
	readonly protocols?: string | readonly string[];
	readonly expectedSequence?: number;
	readonly webSocketFactory?: (
		url: string,
		protocols?: string | string[],
	) => WebSocket;
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	if (
		normalized === "localhost" || normalized.endsWith(".localhost") ||
		normalized === "[::1]" || normalized === "::1"
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
	if (
		(url.protocol !== "ws:" && url.protocol !== "wss:") ||
		!isLoopbackHostname(url.hostname)
	) {
		throw new TypeError(
			"LocalTransport URL must use ws/wss on a loopback host",
		);
	}
	if (url.username !== "" || url.password !== "" || url.hash !== "") {
		throw new TypeError(
			"LocalTransport URL must not contain credentials or a fragment",
		);
	}
	return url.href;
}

/** Browser WebSocket adapter with validation, ordering, duplicate suppression, and one-shot disconnect signaling. */
export class WebSocketLocalTransport implements LocalTransport {
	readonly #socket: WebSocket;
	readonly #sequenceGuard: ServerSequenceGuard;
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	readonly #disconnectListeners = new Set<
		(disconnect: LocalTransportDisconnect) => void
	>();
	#disconnect: LocalTransportDisconnect | undefined;
	#clientClosing = false;
	#sawNetworkError = false;

	constructor(
		endpoint: string | URL,
		options: WebSocketLocalTransportOptions = {},
	) {
		const url = assertLocalWebSocketUrl(endpoint);
		let protocols: string | string[] | undefined;
		if (typeof options.protocols === "string") protocols = options.protocols;
		else if (options.protocols !== undefined) {
			protocols = [...options.protocols];
		}
		const factory = options.webSocketFactory ??
			((socketUrl: string, socketProtocols?: string | string[]) =>
				socketProtocols === undefined ? new WebSocket(socketUrl) : new WebSocket(socketUrl, socketProtocols));
		this.#socket = factory(url, protocols);
		this.#sequenceGuard = new ServerSequenceGuard(
			options.expectedSequence ?? 1,
		);

		this.#socket.addEventListener("message", (event: MessageEvent<unknown>) => {
			if (typeof event.data !== "string") {
				this.#failProtocol("Server sent a non-text WebSocket frame");
				return;
			}
			try {
				const serverEvent = parseServerEvent(event.data);
				if (this.#sequenceGuard.observe(serverEvent) === "duplicate") return;
				for (const listener of this.#eventListeners) {
					this.#notifyEventListener(listener, serverEvent);
				}
			} catch (error) {
				this.#failProtocol(
					error instanceof Error ? error.message : "Invalid server event",
				);
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
		if (this.#socket.readyState !== WebSocket.OPEN) {
			throw new Error(`LocalTransport is ${this.state}`);
		}
		this.#socket.send(encodeClientCommand(command));
	}

	onEvent(listener: (event: ServerEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	onDisconnect(
		listener: (disconnect: LocalTransportDisconnect) => void,
	): () => void {
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
			this.#signalDisconnect({
				cause: "client-close",
				code,
				reason,
				wasClean: true,
			});
			return;
		}
		this.#socket.close(code, reason);
	}

	#notifyEventListener(
		listener: (event: ServerEvent) => void,
		event: ServerEvent,
	): void {
		try {
			listener(event);
		} catch (error) {
			queueMicrotask(() => {
				throw error;
			});
		}
	}

	#failProtocol(reason: string): void {
		const disconnect = {
			cause: "protocol-error",
			code: 1002,
			reason,
			wasClean: false,
		} as const;
		this.#signalDisconnect(disconnect);
		if (
			this.#socket.readyState === WebSocket.CONNECTING ||
			this.#socket.readyState === WebSocket.OPEN
		) {
			this.#socket.close(1002, "Invalid GUI protocol event");
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
