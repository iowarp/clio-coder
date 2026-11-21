/**
 * The attach wire: what a second terminal attached to a running CLIO Coder
 * session receives, and the few commands it may send back.
 *
 * Every message is one JSON object on one line, `{ v: 1, type, ... }`. The
 * protocol is pure data and knows nothing about how the bytes travel or who
 * opened the door; the transport and the consent source sit behind their own
 * interfaces in host.ts. Anything a client sends that is not exactly one of the
 * commands below is refused with a structured error and never reaches the host
 * session.
 *
 * Roles are ordered. A client asks for one at hello and holds the lower of what
 * it asked for and what the host's consent admits for it, so a client can never
 * talk itself above the host's ceiling and the host can never push a role onto
 * a client that asked for less.
 */

export const ATTACH_PROTOCOL_VERSION = 1;

/** observer watches; approver also answers the approval card; pair also speaks into the session. */
export const ATTACH_ROLES = ["observer", "approver", "pair"] as const;
export type AttachRole = (typeof ATTACH_ROLES)[number];

const ROLE_RANK: Readonly<Record<AttachRole, number>> = { observer: 0, approver: 1, pair: 2 };

/** A client line larger than this is refused unread; a pair message's own bound is below it. */
export const ATTACH_CLIENT_LINE_MAX_BYTES = 16_384;
/** A pair message's size limit, the same one a peer prompt has. */
export const ATTACH_SAY_MAX_BYTES = 8_192;
/** A transcript block's text as sent to a client; the host transcript keeps the whole of it. */
const ATTACH_BLOCK_TEXT_MAX = 2_000;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function isAttachRole(value: unknown): value is AttachRole {
	return typeof value === "string" && (ATTACH_ROLES as readonly string[]).includes(value);
}

/** The role a client holds: the lower of what it asked for and the host's ceiling; null when the host admits none. */
export function effectiveAttachRole(asked: AttachRole, ceiling: AttachRole | null): AttachRole | null {
	if (ceiling === null) return null;
	return ROLE_RANK[asked] <= ROLE_RANK[ceiling] ? asked : ceiling;
}

/** Whether `role` may send `command`. Hello and bye are open to every role. */
export function attachRoleAllows(role: AttachRole, command: AttachCommand["type"]): boolean {
	switch (command) {
		case "hello":
		case "bye":
			return true;
		case "approve":
		case "deny":
			return ROLE_RANK[role] >= ROLE_RANK.approver;
		case "say":
			return role === "pair";
	}
}

/** One transcript block as a client sees it, the shape the session's transcript export lays out. */
export type AttachBlock =
	| { kind: "request"; text: string }
	| { kind: "response"; text: string; reasoning: boolean; model: string | null }
	| { kind: "tool"; name: string; args: string; viaGateway: boolean }
	| { kind: "result"; name: string; text: string; failed: boolean; viaGateway: boolean }
	| { kind: "note"; title: string; text: string };

/**
 * The approval card's facts as they may leave the host process: the sanitized
 * view the card renders from, never the call's raw arguments or mutation text.
 */
export interface AttachApprovalView {
	requestId: string;
	tool: string;
	actionClass: string;
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	reason: string;
	target?: string;
	consequence?: ReadonlyArray<string>;
	mutation?: { kind: "write" | "edit"; bytes: number; replacements: number; digest: string };
}

export interface AttachStatus {
	/** The agent status machine's phase (`idle`, `streaming`, `tool_blocked`, ...). */
	phase: string;
}

export interface AttachPresenceEntry {
	clientId: string;
	role: AttachRole;
	label?: string;
}

export type AttachErrorCode =
	| "malformed"
	| "unsupported-version"
	| "unknown-type"
	| "not-ready"
	| "already-ready"
	| "forbidden"
	| "not-admitted"
	| "stale"
	| "refused"
	| "internal";

/** Events the host sends. `replay` and `block` carry the transcript; the rest are state. */
export type AttachServerEvent =
	| { v: 1; type: "hello"; clientId: string; sessionId: string | null; role: AttachRole }
	| { v: 1; type: "role"; role: AttachRole }
	| { v: 1; type: "presence"; clients: AttachPresenceEntry[] }
	| { v: 1; type: "replay"; blocks: AttachBlock[]; omitted: number }
	| { v: 1; type: "block"; block: AttachBlock }
	| { v: 1; type: "status"; status: AttachStatus }
	| { v: 1; type: "approval.open"; request: AttachApprovalView }
	| { v: 1; type: "approval.closed"; requestId: string; status: "granted" | "denied" | "expired"; decidedBy?: string }
	| { v: 1; type: "ok"; command: "approve" | "deny" | "say"; detail: string; requestId?: string }
	| { v: 1; type: "error"; code: AttachErrorCode; message: string; command?: string }
	| { v: 1; type: "bye"; reason: string };

/** Live events the host session publishes to every attached client. */
export type AttachLiveEvent = Extract<
	AttachServerEvent,
	{ type: "block" | "status" | "approval.open" | "approval.closed" }
>;

/** Commands a client sends. Nothing else is accepted. */
export type AttachCommand =
	| { type: "hello"; role: AttachRole; label?: string }
	| { type: "approve"; requestId: string }
	| { type: "deny"; requestId: string }
	| { type: "say"; text: string }
	| { type: "bye" };

export type AttachParse<T> = { ok: true; value: T } | { ok: false; code: AttachErrorCode; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A client-chosen name, for the host's notices: only the characters a pane id holds, bounded. */
function sanitizeLabel(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:@%-]/g, "").slice(0, 32);
}

/**
 * Text that reads as a slash command (`/model x`, `/attach off`). A pair message is plain text for the model and is
 * never parsed as a command, so text shaped like one is refused instead of reaching the model looking like one. A
 * path such as `/tmp/x is full` is plain text.
 */
export function looksLikeSlashCommand(text: string): boolean {
	return /^\s*\/[A-Za-z][\w:-]*(?:\s|$)/u.test(text);
}

/** Non-empty, bounded, and free of control characters other than newline and tab. */
function validSayText(text: string): boolean {
	if (text.trim().length === 0 || Buffer.byteLength(text, "utf8") > ATTACH_SAY_MAX_BYTES) return false;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return false;
	}
	return true;
}

function onlyKeys(record: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
	return Object.keys(record).every((key) => key === "v" || key === "type" || allowed.includes(key));
}

/** Parse one client line. Every failure is an answer, never a throw. */
export function parseAttachCommand(line: string): AttachParse<AttachCommand> {
	const fail = (code: AttachErrorCode, message: string): AttachParse<AttachCommand> => ({ ok: false, code, message });
	if (Buffer.byteLength(line, "utf8") > ATTACH_CLIENT_LINE_MAX_BYTES)
		return fail("malformed", `a command line is at most ${ATTACH_CLIENT_LINE_MAX_BYTES} bytes`);
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return fail("malformed", "a command is one JSON object per line");
	}
	if (!isRecord(value)) return fail("malformed", "a command is one JSON object per line");
	if (value.v !== ATTACH_PROTOCOL_VERSION) return fail("unsupported-version", "this host speaks attach protocol v1");
	const malformed = (what: string) => fail("malformed", `${String(value.type)}: ${what}`);
	switch (value.type) {
		case "hello": {
			if (!onlyKeys(value, ["role", "label"])) return malformed("unknown field");
			if (!isAttachRole(value.role)) return malformed("role is observer, approver or pair");
			if (value.label !== undefined && typeof value.label !== "string") return malformed("label is a string");
			const label = typeof value.label === "string" ? sanitizeLabel(value.label) : "";
			return { ok: true, value: { type: "hello", role: value.role, ...(label.length > 0 ? { label } : {}) } };
		}
		case "approve":
		case "deny": {
			if (!onlyKeys(value, ["requestId"])) return malformed("unknown field");
			if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId))
				return malformed("requestId names one pending approval");
			return { ok: true, value: { type: value.type, requestId: value.requestId } };
		}
		case "say": {
			if (!onlyKeys(value, ["text"])) return malformed("unknown field");
			if (typeof value.text !== "string" || !validSayText(value.text))
				return malformed(`text is non-empty plain text of at most ${ATTACH_SAY_MAX_BYTES} bytes`);
			if (looksLikeSlashCommand(value.text))
				return fail("refused", "slash commands stay with the host operator; a pair message is plain text");
			return { ok: true, value: { type: "say", text: value.text } };
		}
		case "bye":
			if (!onlyKeys(value, [])) return malformed("unknown field");
			return { ok: true, value: { type: "bye" } };
		default:
			return fail("unknown-type", "commands are hello, approve, deny, say and bye");
	}
}

function clip(text: string): string {
	return text.length <= ATTACH_BLOCK_TEXT_MAX
		? text
		: `${text.slice(0, ATTACH_BLOCK_TEXT_MAX)}\n… ${text.length - ATTACH_BLOCK_TEXT_MAX} more characters`;
}

/** A transcript block bounded for the wire. */
export function attachBlock(block: AttachBlock): AttachBlock {
	switch (block.kind) {
		case "tool":
			return { ...block, args: clip(block.args) };
		case "note":
		case "request":
		case "response":
		case "result":
			return { ...block, text: clip(block.text) };
	}
}

/** The card's view reduced to the fields that may leave the host process. */
export function attachApprovalView(view: {
	requestId: string;
	tool: string;
	actionClass: string;
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	reason: string;
	target?: string;
	consequence?: ReadonlyArray<string>;
	mutation?: { kind: "write" | "edit"; bytes: number; replacements: number; digest: string };
}): AttachApprovalView {
	const mutation = view.mutation;
	return {
		requestId: view.requestId,
		tool: view.tool,
		actionClass: view.actionClass,
		origin:
			view.origin.kind === "main"
				? { kind: "main" }
				: { kind: "worker", agentId: view.origin.agentId, runId: view.origin.runId },
		reason: view.reason,
		...(view.target !== undefined ? { target: view.target } : {}),
		...(view.consequence !== undefined ? { consequence: [...view.consequence] } : {}),
		...(mutation !== undefined
			? {
					mutation: {
						kind: mutation.kind,
						bytes: mutation.bytes,
						replacements: mutation.replacements,
						digest: mutation.digest,
					},
				}
			: {}),
	};
}

const SERVER_TYPES: ReadonlySet<string> = new Set([
	"hello",
	"role",
	"presence",
	"replay",
	"block",
	"status",
	"approval.open",
	"approval.closed",
	"ok",
	"error",
	"bye",
]);

/** Parse one host line on the client side; null for anything this client does not understand. */
export function parseAttachEvent(line: string): AttachServerEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== ATTACH_PROTOCOL_VERSION || typeof value.type !== "string") return null;
	if (!SERVER_TYPES.has(value.type)) return null;
	switch (value.type) {
		case "hello":
		case "role":
			if (!isAttachRole(value.role)) return null;
			break;
		case "replay":
			if (!Array.isArray(value.blocks)) return null;
			break;
		case "block":
			if (!isRecord(value.block)) return null;
			break;
		case "approval.open":
			if (!isRecord(value.request) || typeof value.request.requestId !== "string") return null;
			break;
		case "approval.closed":
			if (typeof value.requestId !== "string") return null;
			break;
	}
	return value as unknown as AttachServerEvent;
}
