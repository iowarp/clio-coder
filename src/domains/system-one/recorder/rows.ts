/**
 * The compact row a session ledger keeps for one System One call.
 *
 * A ledger is read by people and replayed by other tools, so it carries what
 * the call cost and what came back, and never the state it sent: the digest
 * groups identical evidence without storing it. The dataset (`dataset.ts`) is
 * the place that keeps redacted state, and only when the operator asked for it.
 */

import { createHash } from "node:crypto";
import { createRedactionTally } from "../../evidence/redact.js";
import { redactSecretString } from "../../safety/redaction.js";
import type { Answer, CallOutcome, DecisionRecord, EngineKind, RouteRecord, SiteId } from "../types.js";
import { scrub } from "./scrub.js";

export interface SessionRow {
	readonly callId: string;
	/** ISO time the call started. */
	readonly at: string;
	readonly ref?: string;
	readonly site: SiteId;
	readonly siteVersion: string;
	readonly engine: string;
	readonly kind: EngineKind;
	readonly build: string | null;
	readonly outcome: CallOutcome;
	readonly error?: string;
	readonly latencyMs: number;
	readonly deadlineMs: number;
	/** chars/4 of the serialized state, the estimate the engines' window check uses. */
	readonly stateTokens: number;
	/** sha256 of the serialized state. */
	readonly stateDigest: string;
	/** How many questions the call carried. */
	readonly questions: number;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	/** Why the readout is not the configured one; see `EngineReply.note`. */
	readonly note?: string;
	readonly fitted?: boolean;
	readonly policy?: Readonly<Record<string, string | number | boolean | null>>;
	/** Per-engine provenance without the rendered text, which only the dataset keeps. */
	readonly routes?: ReadonlyArray<Omit<RouteRecord, "rendered">>;
}

/** The custom-entry type the chat loop writes one drain under. */
export const SESSION_ROW_CUSTOM_TYPE = "systemOne";

/** The slice of a session tree snapshot that decides where a row hangs. */
export interface RowAnchorTree {
	readonly leafId: string | null;
	readonly nodesById: Readonly<Record<string, { readonly kind: string }>>;
}

export interface AnchoredRows {
	readonly parentTurnId: string | null;
	readonly calls: SessionRow[];
}

/**
 * Split a drain into the ledger entries it is written as, each under the turn its rows
 * describe. A row's `ref` names the user turn a call was asked about, and a slow answer
 * drains after the leaf has moved on: a later turn, or a `/tree` switch elsewhere. Under the
 * leaf it would hang off a turn it knows nothing about and drop out of an active-path replay
 * of the turn it belongs to. A ref that is not a persisted turn (a permission request id, a
 * tool call id, a compaction or branch marker) has no turn to name and keeps the leaf.
 */
export function anchorSessionRows(rows: ReadonlyArray<SessionRow>, tree: RowAnchorTree): AnchoredRows[] {
	const groups = new Map<string | null, SessionRow[]>();
	for (const row of rows) {
		const named = row.ref !== undefined && Object.hasOwn(tree.nodesById, row.ref) ? tree.nodesById[row.ref] : undefined;
		const anchor = row.ref !== undefined && named !== undefined && isMessageNode(named.kind) ? row.ref : tree.leafId;
		const group = groups.get(anchor);
		if (group === undefined) groups.set(anchor, [row]);
		else group.push(row);
	}
	return [...groups].map(([parentTurnId, calls]) => ({ parentTurnId, calls }));
}

/** Compaction and branch nodes are ledger-derived structure, not turns a sidecar can anchor to. */
function isMessageNode(kind: string): boolean {
	return kind !== "compaction" && kind !== "branch";
}

export function serializeState(state: unknown): string {
	try {
		return JSON.stringify(state) ?? "null";
	} catch {
		// A state a site built from non-JSON values still needs a stable digest to group by.
		return "[unserializable]";
	}
}

export function digestOf(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

function estimateStateTokens(serialized: string): number {
	return Math.ceil(serialized.length / 4);
}

/** Characters of an error a ledger row keeps. A refusal can echo the whole request back. */
export const LEDGER_ERROR_MAX_CHARS = 160;

/**
 * Scrubbed with the state's own filters before it is cut, because a secret
 * cut mid-token no longer matches its pattern, then held to the ledger's bound.
 */
function ledgerError(error: string): string {
	const cleaned = scrub(error, createRedactionTally(), false);
	if (cleaned.length <= LEDGER_ERROR_MAX_CHARS) return cleaned;
	let head = cleaned.slice(0, LEDGER_ERROR_MAX_CHARS - 1);
	// A cut between the halves of a surrogate pair would leave a lone surrogate.
	const last = head.charCodeAt(head.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
	return `${head}…`;
}

function scrubPolicy(policy: NonNullable<DecisionRecord["policy"]>): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(policy))
		out[key] = typeof value === "string" ? redactSecretString(value) : value;
	return out;
}

export function buildSessionRow(record: DecisionRecord, serialized: string, digest: string): SessionRow {
	return {
		callId: record.callId,
		at: record.at,
		...(record.ref !== undefined ? { ref: record.ref } : {}),
		site: record.site,
		siteVersion: record.siteVersion,
		engine: record.engine,
		kind: record.kind,
		build: record.build,
		outcome: record.outcome,
		// A transport error can echo the URL, and a URL can carry a key.
		...(record.error !== undefined ? { error: ledgerError(record.error) } : {}),
		latencyMs: record.latencyMs,
		deadlineMs: record.deadlineMs,
		stateTokens: estimateStateTokens(serialized),
		stateDigest: digest,
		questions: Object.keys(record.questions).length,
		...(record.answers !== undefined ? { answers: record.answers } : {}),
		...(record.usage !== undefined ? { usage: record.usage } : {}),
		...(record.note !== undefined ? { note: record.note } : {}),
		...(record.fitted !== undefined ? { fitted: record.fitted } : {}),
		...(record.policy !== undefined ? { policy: scrubPolicy(record.policy) } : {}),
		...(record.routes !== undefined
			? {
					routes: record.routes.map(({ rendered: _rendered, ...route }) => ({
						...route,
						...(route.error !== undefined ? { error: ledgerError(route.error) } : {}),
					})),
				}
			: {}),
	};
}
