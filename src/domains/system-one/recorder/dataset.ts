/**
 * The opt-in decision dataset as research-tier telemetry (#434): each decision, with its redacted state and the
 * question specs it asked, and each outcome that followed it, is a `system_one.sample_captured` record in the
 * session's journal whose content the writer keeps in the session's `objects/`. Research mode with
 * `telemetry.research.systemOneDataset`, content capture and the workspace's consent admits it, and telemetry
 * retention governs it like any other research content.
 *
 * A decision whose call finished before any session existed (the first turn's `turn` site runs before the user turn
 * creates the session) has no journal to land in, so it is held until `adopt` names the session that drains it, the
 * same one that receives its ledger row. A process that ends first drops it: the process scope keeps no content. An
 * outcome that names a held decision waits with it and is recorded right after it.
 */

import type { EventPayload } from "../../../core/telemetry/events.js";
import type { RedactionTally } from "../../evidence/redact.js";
import { createRedactionTally } from "../../evidence/redact.js";
import { specHash } from "../questions.js";
import type {
	Answer,
	CallOutcome,
	DecisionRecord,
	EngineKind,
	OutcomeRecord,
	Question,
	RouteRecord,
	SiteId,
} from "../types.js";
import { boundState, scrub, scrubbed } from "./scrub.js";

/** A process that cannot record must not hold rows without bound. */
const MAX_HELD = 512;

export interface DatasetDecisionRow {
	readonly kind: "decision";
	readonly v: 1;
	readonly callId: string;
	readonly at: string;
	readonly session: string | null;
	readonly ref?: string;
	readonly site: SiteId;
	readonly siteVersion: string;
	readonly engine: string;
	/** The engine's kind. Named apart from the row `kind`, which classifies the line. */
	readonly engineKind: EngineKind;
	readonly target: string;
	readonly model: string | null;
	readonly build: string | null;
	readonly outcome: CallOutcome;
	readonly error?: string;
	readonly latencyMs: number;
	readonly deadlineMs: number;
	/** Redacted, and cut to its head when the serialized state passed the size bound. */
	readonly state: Readonly<Record<string, unknown>>;
	readonly stateTruncated?: true;
	/** sha256 of the unredacted serialized state. */
	readonly stateDigest: string;
	readonly redactions: number;
	/** Question id to the hash of its spec row. */
	readonly questions: Readonly<Record<string, string>>;
	readonly answers?: Readonly<Record<string, Answer>>;
	readonly usage?: { readonly input: number; readonly output: number };
	/** Why the readout is not the configured one; see `EngineReply.note`. */
	readonly note?: string;
	readonly fitted?: boolean;
	readonly policy?: Readonly<Record<string, string | number | boolean | null>>;
	/** Per-engine provenance, with the rendered questions a bounded renderer sent. */
	readonly routes?: ReadonlyArray<RouteRecord>;
}

export interface DatasetOutcomeRow {
	readonly kind: "outcome";
	readonly v: 1;
	readonly ref: string;
	readonly source: OutcomeRecord["source"];
	readonly at: string;
	readonly facts: Readonly<Record<string, unknown>>;
}

function plainState(serialized: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Not JSON: the caller's serialization fell back to a sentinel, and there is no state to keep.
	}
	return {};
}

/** A short identifier field: a target, model or build name can carry a path or a URL with userinfo. */
function scrubText(value: string, tally: RedactionTally): string {
	return scrub(value, tally, false);
}

function decisionRow(item: PendingDecision, questions: Record<string, string>): DatasetDecisionRow {
	const { record } = item;
	const tally = createRedactionTally();
	const bounded = boundState(scrub(plainState(item.serialized), tally));
	const error = record.error === undefined ? undefined : scrub(record.error, tally);
	const policy = record.policy === undefined ? undefined : scrub(record.policy, tally);
	const answers = record.answers === undefined ? undefined : scrub(record.answers, tally, false);
	const routes = record.routes === undefined ? undefined : scrub(record.routes, tally, false);
	return {
		kind: "decision",
		v: 1,
		callId: record.callId,
		at: record.at,
		session: item.session,
		...(record.ref !== undefined ? { ref: record.ref } : {}),
		site: record.site,
		siteVersion: record.siteVersion,
		engine: record.engine,
		engineKind: record.kind,
		target: scrubText(record.target, tally),
		model: record.model === null ? null : scrubText(record.model, tally),
		build: record.build === null ? null : scrubText(record.build, tally),
		outcome: record.outcome,
		...(error !== undefined ? { error } : {}),
		latencyMs: record.latencyMs,
		deadlineMs: record.deadlineMs,
		state: bounded.state,
		...(bounded.truncated ? { stateTruncated: true as const } : {}),
		stateDigest: item.digest,
		redactions: tally.count,
		questions,
		...(answers !== undefined ? { answers } : {}),
		...(record.usage !== undefined ? { usage: record.usage } : {}),
		...(record.note !== undefined ? { note: record.note } : {}),
		...(record.fitted !== undefined ? { fitted: record.fitted } : {}),
		...(policy !== undefined ? { policy } : {}),
		...(routes !== undefined ? { routes } : {}),
	};
}

function outcomeRow(record: OutcomeRecord): DatasetOutcomeRow {
	return {
		kind: "outcome",
		v: 1,
		ref: record.ref,
		source: record.source,
		at: record.at,
		facts: scrubbed(record.facts).value,
	};
}

/** What one sample's content object holds: a decision with the specs it asked, or an outcome. */
export type DatasetSample =
	| { readonly decision: DatasetDecisionRow; readonly specs: Readonly<Record<string, Question>> }
	| { readonly outcome: DatasetOutcomeRow };
export type SampleData = Omit<EventPayload<"system_one.sample_captured">, "content" | "bytes">;

export interface PendingDecision {
	readonly record: DecisionRecord;
	readonly session: string | null;
	/** The state as serialized once by the caller, so the digest and the row agree. */
	readonly serialized: string;
	readonly digest: string;
}

export interface DatasetWriter {
	/** A decision with no session is held until `adopt`; any other is recorded. */
	decision(item: PendingDecision): void;
	/** Recorded under its originating session; an outcome for a held decision follows its adoption. */
	outcome(record: OutcomeRecord): void;
	/** Stamp the held decisions with `session` and record them. */
	adopt(session: string): void;
	/** Drop what is still held: no session will receive it. */
	flush(): void;
}

export interface DatasetWriterDeps {
	/** Read when a sample is about to be recorded, so turning capture off applies to held decisions too. */
	recording(session: string | null): boolean;
	/** The session current now, for outcomes without an explicit origin. */
	currentSession(): string | null;
	/** Hand one sample to the session's journal; the writer stores its content and cites it. */
	sample(session: string, data: SampleData, content: DatasetSample): void;
}

export function createDatasetWriter(deps: DatasetWriterDeps): DatasetWriter {
	let held: PendingDecision[] = [];
	let heldOutcomes: OutcomeRecord[] = [];

	const recordDecision = (item: PendingDecision, session: string): void => {
		if (!deps.recording(session)) return;
		const hashes: Record<string, string> = {};
		const specs: Record<string, Question> = {};
		for (const [id, question] of Object.entries(item.record.questions)) {
			const hash = specHash(question);
			hashes[id] = hash;
			specs[hash] ??= scrub(question, createRedactionTally(), false);
		}
		const decision = decisionRow({ ...item, session }, hashes);
		deps.sample(
			session,
			{
				sample: "decision",
				decisionId: decision.callId,
				site: decision.site,
				...(decision.ref !== undefined ? { ref: decision.ref } : {}),
			},
			{ decision, specs },
		);
	};
	const recordOutcome = (record: OutcomeRecord, session: string | null): void => {
		if (session === null || !deps.recording(session)) return;
		deps.sample(session, { sample: "outcome", ref: record.ref }, { outcome: outcomeRow(record) });
	};

	return {
		decision(item) {
			if (item.session !== null) {
				recordDecision(item, item.session);
				return;
			}
			held.push(item);
			if (held.length > MAX_HELD) held = held.slice(held.length - MAX_HELD);
		},
		outcome(record) {
			if (held.some((item) => item.record.ref === record.ref)) {
				heldOutcomes.push(record);
				if (heldOutcomes.length > MAX_HELD) heldOutcomes = heldOutcomes.slice(heldOutcomes.length - MAX_HELD);
				return;
			}
			recordOutcome(record, record.session !== undefined ? record.session : deps.currentSession());
		},
		adopt(session) {
			const waiting = held;
			const outcomes = heldOutcomes;
			held = [];
			heldOutcomes = [];
			for (const item of waiting) recordDecision(item, session);
			for (const record of outcomes) recordOutcome(record, session);
		},
		flush() {
			held = [];
			heldOutcomes = [];
		},
	};
}
