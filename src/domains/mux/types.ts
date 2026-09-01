/**
 * Clio-owned vocabulary for the pane layer.
 *
 * Nothing in this file names a herdr wire shape. `socket-client.ts` is the only
 * module that reads the newline-delimited JSON coming off the socket, and it
 * maps every response into the types declared here before anything else in the
 * process sees it. That keeps the blast radius of a herdr protocol bump inside
 * one file and keeps `npm run lint`'s boundary check honest about what the mux
 * domain exports to the rest of Clio.
 */

/** Which capability ladder rung the mux resolved to at interactive boot. */
export type MuxMode = "embedded" | "guest" | "none";

/** Locates one pane inside a herdr session. */
export interface MuxPaneRef {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

/**
 * Semantic agent state as the pane layer reports and reads it.
 *
 * `done` and `unknown` only ever arrive from the server; Clio reports the three
 * states in {@link MuxReportableAgentState}.
 */
export type MuxAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

/** The subset of {@link MuxAgentState} Clio is allowed to assert about a pane. */
export type MuxReportableAgentState = "idle" | "working" | "blocked";

/** One pane, projected from the server's pane record. */
export interface MuxPane {
	paneId: string;
	tabId: string;
	workspaceId: string;
	focused: boolean;
	agentState: MuxAgentState;
	revision: number;
	label: string | null;
	title: string | null;
	cwd: string | null;
	agent: string | null;
	tokens: Readonly<Record<string, string>>;
}

/** One tab, projected from the server's tab record. */
export interface MuxTab {
	tabId: string;
	workspaceId: string;
	number: number;
	label: string;
	focused: boolean;
	paneCount: number;
	agentState: MuxAgentState;
}

/** Git worktree metadata projected from herdr's worktree API. */
export interface MuxWorktree {
	path: string;
	branch: string | null;
	isBare: boolean;
	isDetached: boolean;
	isPrunable: boolean;
	isLinkedWorktree: boolean;
	openWorkspaceId: string | null;
	label: string;
}

/** Repository identity accompanying a `worktree.list` result. */
export interface MuxWorktreeSource {
	repoKey: string;
	repoName: string;
	repoRoot: string;
	sourceCheckoutPath: string;
	sourceWorkspaceId: string | null;
}

/** Identity and capability facts recorded from the `ping` handshake. */
export interface MuxServerInfo {
	version: string;
	protocol: number;
}

/**
 * Bootstrap state. The documented herdr pattern is to take one snapshot and
 * then trust the event stream, so the client refetches this after every
 * reconnect rather than trying to replay missed events.
 */
export interface MuxSnapshot {
	server: MuxServerInfo;
	focusedPaneId: string | null;
	focusedTabId: string | null;
	focusedWorkspaceId: string | null;
	panes: ReadonlyArray<MuxPane>;
	tabs: ReadonlyArray<MuxTab>;
}

/** Lifecycle event kinds the pane layer can subscribe to. */
export type MuxEventKind = "pane.closed" | "pane.exited" | "pane.moved" | "layout.updated";

/**
 * One pushed lifecycle event. A discriminated union because the payloads
 * differ: pane leave events carry the pane, a move carries the id rewrite
 * herdr performs, and a layout update carries the whole tab geometry so a
 * consumer does not have to turn around and fetch what the push already said.
 */
export type MuxEvent =
	| { kind: "pane.closed" | "pane.exited"; paneId: string; workspaceId: string }
	| { kind: "pane.moved"; paneId: string; previousPaneId: string; tabId: string; workspaceId: string }
	| { kind: "layout.updated"; geometry: MuxTabGeometry };

/** One rectangle in terminal cells, as herdr's layout snapshots report them. */
export interface MuxRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Cell-precise geometry of one tab: the outer area, every pane's rect, and
 * every split with its live ratio. This is what dock sizing converges on.
 */
export interface MuxTabGeometry {
	workspaceId: string;
	tabId: string;
	zoomed: boolean;
	area: MuxRect;
	focusedPaneId: string | null;
	panes: ReadonlyArray<{ paneId: string; focused: boolean; rect: MuxRect }>;
	splits: ReadonlyArray<{ direction: "right" | "down"; ratio: number; rect: MuxRect }>;
}

/**
 * One node of a portable tab layout tree, as `layout.export` describes it.
 * Split ratio is the share of the axis the `first` child keeps.
 */
export type MuxLayoutNode =
	| { type: "pane"; paneId: string | null; label: string | null }
	| { type: "split"; direction: "right" | "down"; ratio: number; first: MuxLayoutNode; second: MuxLayoutNode };

/** A whole tab's portable layout tree. */
export interface MuxLayoutTree {
	workspaceId: string;
	tabId: string;
	zoomed: boolean;
	focusedPaneId: string | null;
	root: MuxLayoutNode;
}

/** Where Clio's own pane lives, read from the herdr environment. */
export interface MuxSelfLocation {
	workspaceId: string | null;
	tabId: string | null;
	paneId: string | null;
}

/**
 * Typed failure classes. `unknown` carries the server's own code through
 * untouched so a herdr version that grows a new code is legible in logs
 * without a Clio release.
 */
export type MuxErrorKind =
	| "not_found"
	| "invalid_params"
	| "agent_blocked"
	| "feature_disabled"
	| "agent_prompt_stalled"
	| "timeout"
	| "transport"
	| "protocol"
	| "unknown";

/** Every failure the mux domain raises. */
export class MuxError extends Error {
	readonly kind: MuxErrorKind;
	/** The server's raw error code, when the failure came back over the wire. */
	readonly wireCode: string | null;
	readonly method: string | null;

	constructor(kind: MuxErrorKind, message: string, options: { wireCode?: string; method?: string } = {}) {
		super(message);
		this.name = "MuxError";
		this.kind = kind;
		this.wireCode = options.wireCode ?? null;
		this.method = options.method ?? null;
	}
}

/** A request that never got a response line inside its budget. */
export class MuxRequestTimeout extends MuxError {
	readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number) {
		super("timeout", `mux request ${method} timed out after ${timeoutMs}ms`, { method });
		this.name = "MuxRequestTimeout";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Codes herdr returns today that mean the same thing as one of our kinds.
 * Anything absent falls through the suffix and prefix rules in
 * {@link muxErrorKind}, and anything those miss stays `unknown`.
 */
const ERROR_KIND_BY_WIRE_CODE: Readonly<Record<string, MuxErrorKind>> = {
	agent_blocked: "agent_blocked",
	agent_prompt_stalled: "agent_prompt_stalled",
	feature_disabled: "feature_disabled",
	invalid_params: "invalid_params",
	invalid_request: "invalid_params",
	not_found: "not_found",
};

/** Classify one server error code into a Clio failure kind. */
export function muxErrorKind(wireCode: string): MuxErrorKind {
	const mapped = ERROR_KIND_BY_WIRE_CODE[wireCode];
	if (mapped) return mapped;
	if (wireCode.endsWith("_not_found")) return "not_found";
	if (wireCode.startsWith("invalid_")) return "invalid_params";
	return "unknown";
}

/** Diagnostic sink. The mux never throws at its callers, so this is how failures surface. */
export type MuxLog = (level: "debug" | "info" | "warning", message: string) => void;

/** The three sounds `notification.show` accepts, per protocol 17's schema. */
export type MuxNotificationSound = "none" | "done" | "request";

/** What Clio reports about its own hosting pane in guest mode (SA-3). */
export interface MuxSelfReport {
	state: MuxReportableAgentState;
	/** Short human line herdr may show beside the state. */
	message?: string;
	/** Presentation tokens; a null value clears that token. */
	tokens?: Readonly<Record<string, string | null>>;
	/** Per-state sidebar label overrides, e.g. `{ blocked: "needs approval" }`. */
	stateLabels?: Readonly<Record<string, string>>;
	/** Expiry for this report's tokens, 1..86400000 ms. */
	ttlMs?: number;
}

/**
 * Why Clio created a pane. `watch` is the workers-view watch pane; everything
 * else (presets, operator argv, the yazi companion) is `utility`. The purpose
 * doubles as the pane's `role` metadata token so a restarted session can adopt
 * a surviving watch pane by scanning one snapshot.
 */
export type MuxPanePurpose = "watch" | "utility";

/** One pane Clio created and therefore may act on. */
export interface MuxPaneRecord {
	ref: MuxPaneRef;
	purpose: MuxPanePurpose;
	label: string;
	openedAt: number;
	/**
	 * True when the record was adopted from a snapshot at boot rather than
	 * created in this process, so a resumed session reuses the pane it found
	 * instead of opening a second one.
	 */
	adopted?: boolean;
}
