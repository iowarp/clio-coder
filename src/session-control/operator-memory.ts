/**
 * Hot keywords for memory. The operator's own submitted words ("remember that
 * ...", "don't forget ...", "from now on ...", a leading `# `, `/remember`)
 * are captured here at turn submission, by the harness, never by a prompt
 * instruction and never from tool output or model text: the chat loop calls
 * `handleTyped` only for text an operator typed.
 *
 * Session scope pins an operator note in the session ledger; project and
 * global scope write operator-approved memory records. Either way the next
 * turn's `# Memory` carries it, and the chip the caller shows offers to move
 * it or undo it.
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
	classifyOperatorStatement,
	type DurableOperatorScope,
	detectOperatorMemoryIntent,
	type MemoryRecord,
	type MemoryRecordStanding,
	OPERATOR_SECRET_REFUSAL,
	OPERATOR_STATEMENT_MAX_CHARS,
	type OperatorMemoryIntent,
	type OperatorMemoryScope,
	type OperatorSessionNote,
	type OperatorStatedKind,
	operatorStatementHoldsSecret,
	operatorStatementMatch,
	rememberOperatorStatement,
	restoreOperatorStatement,
	retractOperatorStatement,
	slashRememberIntent,
} from "../domains/memory/index.js";
import type { TaskMemoryModelClient } from "../domains/memory/task-memory-policy.js";
import type { SessionContract } from "../domains/session/contract.js";
import { foldOperatorNotes, OPERATOR_NOTE_ENTRY, type OperatorNoteEntryData } from "../domains/session/entries.js";

/** What the memory runtime lends the capture: its store root, workspace and background route. */
export interface OperatorMemoryStorePort {
	/** Memory is on and has a data root. Off, nothing is captured and typed text reaches the model unchanged. */
	enabled(): boolean;
	dataDir(): string;
	cwd(): string;
	/** The background memory route, or null when none is configured or its endpoint is busy. */
	modelClient(): TaskMemoryModelClient | null;
}

/** The chip a surface shows for one capture: TUI as a transcript line, ACP as `_meta["clio-coder/memory"]`. */
export interface OperatorMemoryChip {
	version: 1;
	captureId: string;
	action: "remembered" | "forgot" | "undone" | "refused";
	scope?: OperatorMemoryScope;
	kind?: OperatorStatedKind;
	text: string;
}

export interface OperatorMemoryReport {
	level: "info" | "success" | "warning" | "error";
	text: string;
	chip?: OperatorMemoryChip;
}

export interface OperatorMemoryCommands {
	/** `/remember <text>`. */
	remember(text: string): Promise<OperatorMemoryReport>;
	/** `/remember undo [capture]`: the latest capture when none is named. */
	undo(captureId?: string): Promise<OperatorMemoryReport>;
	/** `/remember scope <scope> [capture]`. */
	rescope(scope: OperatorMemoryScope, captureId?: string): Promise<OperatorMemoryReport>;
	/** `/remember forget <text>`. */
	forget(text: string): Promise<OperatorMemoryReport>;
}

export interface OperatorMemory extends OperatorMemoryCommands {
	/**
	 * Capture from text the operator typed and submitted; null, synchronously,
	 * when it asks nothing remembered or forgotten. `captureOnly` means the
	 * submission was only the statement, so no model turn follows. The report
	 * is emitted through `emit` before the promise resolves.
	 */
	handleTyped(typed: string): Promise<{ captureOnly: boolean }> | null;
	/** Pins standing in the current session, plus any taken before the session existed. */
	sessionNotes(): OperatorSessionNote[];
	/** Section-delta standings for session-note ids, so an undone pin reads as withdrawn. */
	noteStandings(ids: readonly string[]): Map<string, MemoryRecordStanding>;
}

export interface OperatorMemoryDeps {
	store: OperatorMemoryStorePort | undefined;
	session: SessionContract | undefined;
	parentTurnId(): string | null;
	emit(report: OperatorMemoryReport): void;
	/** Background classification bound; tests shorten it. */
	classifyTimeoutMs?: number;
}

type Placement =
	| { scope: "session"; noteId: string; replaced: OperatorSessionNote | null }
	| { scope: DurableOperatorScope; recordId: string; previous: MemoryRecord | null };

interface Capture {
	id: string;
	text: string;
	kind: OperatorStatedKind;
	/** The operator named the scope; classification never moves it. */
	explicitScope: boolean;
	sessionId: string | null;
	/** Undefined for a forget. */
	placement?: Placement;
	retraction?: { kind: "note"; note: OperatorSessionNote } | { kind: "record"; previous: MemoryRecord };
	undone: boolean;
}

const SCOPE_WORDS: Record<OperatorMemoryScope, string> = {
	session: "this session",
	project: "this project",
	global: "all projects",
};

const MAX_CAPTURES = 32;

export function operatorMemoryScopeLabel(scope: OperatorMemoryScope): string {
	return SCOPE_WORDS[scope];
}

function rememberedText(scope: OperatorMemoryScope): string {
	const others = (["session", "project", "global"] as const).filter((value) => value !== scope).join("|");
	return `Remembered for ${SCOPE_WORDS[scope]} · change scope: /remember scope ${others} · undo: /remember undo`;
}

function clip(text: string, max = 80): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function createOperatorMemory(deps: OperatorMemoryDeps): OperatorMemory {
	const captures: Capture[] = [];
	/** Pins taken before any session existed; written to the session the first turn creates. */
	let pending: OperatorNoteEntryData[] = [];

	const sessionId = (): string | null => deps.session?.current()?.id ?? null;

	const appendNote = (data: OperatorNoteEntryData): void => {
		if (!deps.session?.current()) {
			pending.push(data);
			return;
		}
		deps.session.appendEntry({
			kind: "custom",
			parentTurnId: deps.parentTurnId(),
			customType: OPERATOR_NOTE_ENTRY,
			display: false,
			data,
		});
	};

	const notes = (): OperatorSessionNote[] => {
		if (pending.length > 0 && deps.session?.current()) {
			const queued = pending;
			pending = [];
			for (const data of queued) appendNote(data);
		}
		const recorded = deps.session?.current()
			? deps.session
					.readEntries()
					.flatMap((entry) =>
						entry.kind === "custom" && entry.customType === OPERATOR_NOTE_ENTRY
							? [entry.data as Partial<OperatorNoteEntryData>]
							: [],
					)
			: [];
		return foldOperatorNotes([...recorded, ...pending]);
	};

	const pin = (text: string, kind: OperatorStatedKind): Extract<Placement, { scope: "session" }> => {
		const replaced = notes().find((note) => note.text.trim().toLowerCase() === text.trim().toLowerCase()) ?? null;
		const noteId = replaced?.id ?? `note-${randomBytes(6).toString("hex")}`;
		appendNote({ version: 1, action: "pin", id: noteId, text, kind });
		return { scope: "session", noteId, replaced };
	};

	const unpin = (noteId: string): void => appendNote({ version: 1, action: "unpin", id: noteId });

	const place = async (
		store: OperatorMemoryStorePort,
		text: string,
		kind: OperatorStatedKind,
		scope: OperatorMemoryScope,
	): Promise<Placement> => {
		if (scope === "session") return pin(text, kind);
		const write = await rememberOperatorStatement(store.dataDir(), {
			text,
			kind,
			scope,
			cwd: store.cwd(),
			sessionId: sessionId(),
		});
		return { scope, recordId: write.record.id, previous: write.previous };
	};

	/** Take back what one placement did: unpin or restore the replaced pin, remove or restore the record. */
	const unplace = async (store: OperatorMemoryStorePort, placement: Placement): Promise<void> => {
		if (placement.scope === "session") {
			if (placement.replaced === null) unpin(placement.noteId);
			else
				appendNote({
					version: 1,
					action: "pin",
					id: placement.noteId,
					text: placement.replaced.text,
					kind: placement.replaced.kind,
				});
			return;
		}
		await restoreOperatorStatement(store.dataDir(), placement.recordId, placement.previous);
	};

	const keep = (capture: Capture): void => {
		captures.push(capture);
		if (captures.length > MAX_CAPTURES) captures.splice(0, captures.length - MAX_CAPTURES);
	};

	const chip = (capture: Capture, action: OperatorMemoryChip["action"]): OperatorMemoryChip => ({
		version: 1,
		captureId: capture.id,
		action,
		...(capture.placement ? { scope: capture.placement.scope } : {}),
		kind: capture.kind,
		text: capture.text,
	});

	const unavailable = (): OperatorMemoryReport => ({
		level: "warning",
		text: "Not remembered: memory is off (context.memory.enabled), so nothing would carry it to a later turn.",
	});

	const failed = (error: unknown): OperatorMemoryReport => ({
		level: "error",
		text: `Not remembered: ${error instanceof Error ? error.message : String(error)}`,
	});

	/** Move a capture the operator did not scope when the background route places it elsewhere. */
	const classify = (store: OperatorMemoryStorePort, capture: Capture): void => {
		let client: TaskMemoryModelClient | null;
		try {
			client = store.modelClient();
		} catch {
			client = null;
		}
		if (client === null) return;
		const placement = capture.placement;
		if (placement === undefined) return;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deps.classifyTimeoutMs ?? 20_000);
		timer.unref?.();
		void classifyOperatorStatement(client, capture.text, basename(store.cwd()), controller.signal)
			.then(async (verdict) => {
				clearTimeout(timer);
				// The operator may have moved or undone it meanwhile; their action wins.
				if (verdict === null || capture.undone || capture.placement !== placement) return;
				const scope = capture.explicitScope ? placement.scope : verdict.scope;
				if (scope === placement.scope && verdict.kind === capture.kind) return;
				await unplace(store, placement);
				capture.kind = verdict.kind;
				// Restoring the first placement put back any record it replaced, so this write finds that record
				// again and its predecessor stays what undo restores.
				capture.placement = await place(store, capture.text, capture.kind, scope);
				// A kind-only refinement leaves the scope the operator was already told;
				// announcing it again printed the same "Remembered for this project" twice.
				if (scope !== placement.scope)
					deps.emit({ level: "success", text: rememberedText(scope), chip: chip(capture, "remembered") });
			})
			.catch(() => {
				// The first placement stands; classification only ever refines it.
				clearTimeout(timer);
			});
	};

	const remember = async (
		intent: Extract<OperatorMemoryIntent, { action: "remember" }>,
	): Promise<OperatorMemoryReport> => {
		const store = deps.store;
		if (store === undefined || !store.enabled()) return unavailable();
		const capture: Capture = {
			id: `cap-${randomBytes(4).toString("hex")}`,
			text: intent.text,
			kind: intent.kind,
			explicitScope: intent.scope !== null,
			sessionId: sessionId(),
			undone: false,
		};
		// The refusal chip never carries the statement: it holds the secret, and ACP would put it on the wire.
		if (operatorStatementHoldsSecret(intent.text))
			return {
				level: "warning",
				text: OPERATOR_SECRET_REFUSAL,
				chip: { ...chip(capture, "refused"), text: "That looks like a secret; keep it in credential storage." },
			};
		if (intent.text.length > OPERATOR_STATEMENT_MAX_CHARS)
			return {
				level: "warning",
				text: `Not remembered: ${intent.text.length} characters is more than one memory holds (${OPERATOR_STATEMENT_MAX_CHARS}). Say the fact itself in a sentence or two.`,
			};
		try {
			capture.placement = await place(store, intent.text, intent.kind, intent.scope ?? "project");
		} catch (error) {
			return failed(error);
		}
		keep(capture);
		classify(store, capture);
		return {
			level: "success",
			text: rememberedText(capture.placement.scope),
			chip: chip(capture, "remembered"),
		};
	};

	const forget = async (text: string): Promise<OperatorMemoryReport> => {
		const store = deps.store;
		if (store === undefined || !store.enabled()) return unavailable();
		const capture: Capture = {
			id: `cap-${randomBytes(4).toString("hex")}`,
			text,
			kind: "fact",
			explicitScope: true,
			sessionId: sessionId(),
			undone: false,
		};
		const note = notes()
			.map((candidate) => ({ candidate, score: operatorStatementMatch(text, candidate.text) }))
			.filter((match) => match.score > 0)
			.sort((left, right) => right.score - left.score)[0];
		try {
			if (note !== undefined && note.score >= 2) {
				unpin(note.candidate.id);
				capture.retraction = { kind: "note", note: note.candidate };
				capture.text = note.candidate.text;
			} else {
				const retracted = await retractOperatorStatement(store.dataDir(), text, store.cwd());
				if (retracted !== null) {
					capture.retraction = { kind: "record", previous: retracted.previous };
					capture.text = retracted.previous.lesson;
				} else if (note !== undefined) {
					unpin(note.candidate.id);
					capture.retraction = { kind: "note", note: note.candidate };
					capture.text = note.candidate.text;
				}
			}
		} catch (error) {
			return failed(error);
		}
		if (capture.retraction === undefined)
			return { level: "info", text: `Nothing remembered matches "${clip(text)}"; nothing was forgotten.` };
		keep(capture);
		return {
			level: "success",
			text: `Forgot "${clip(capture.text)}" · undo: /remember undo`,
			chip: chip(capture, "forgot"),
		};
	};

	const find = (captureId?: string): Capture | undefined =>
		captureId === undefined
			? [...captures].reverse().find((capture) => !capture.undone)
			: captures.find((capture) => capture.id === captureId);

	const handle = (intent: OperatorMemoryIntent): Promise<OperatorMemoryReport> =>
		intent.action === "forget" ? forget(intent.text) : remember(intent);

	return {
		handleTyped(typed) {
			const intent = detectOperatorMemoryIntent(typed);
			if (intent === null || deps.store === undefined || !deps.store.enabled()) return null;
			return handle(intent).then((report) => {
				deps.emit(report);
				return { captureOnly: intent.captureOnly };
			});
		},
		async remember(text) {
			const intent = slashRememberIntent(text);
			return intent === null ? { level: "warning", text: "usage: /remember <what to remember>" } : remember(intent);
		},
		forget,
		async undo(captureId) {
			const capture = find(captureId);
			const store = deps.store;
			if (capture === undefined || capture.undone)
				return { level: "info", text: "Nothing to undo: no remembered or forgotten statement is pending." };
			if (store === undefined || !store.enabled()) return unavailable();
			try {
				if (capture.placement !== undefined) await unplace(store, capture.placement);
				else if (capture.retraction?.kind === "note")
					appendNote({
						version: 1,
						action: "pin",
						id: capture.retraction.note.id,
						text: capture.retraction.note.text,
						kind: capture.retraction.note.kind,
					});
				else if (capture.retraction?.kind === "record")
					await restoreOperatorStatement(store.dataDir(), capture.retraction.previous.id, capture.retraction.previous);
			} catch (error) {
				return { level: "error", text: `Undo failed: ${error instanceof Error ? error.message : String(error)}` };
			}
			capture.undone = true;
			const what = capture.placement !== undefined ? "No longer remembered" : "Remembered again";
			return { level: "info", text: `${what}: "${clip(capture.text)}"`, chip: chip(capture, "undone") };
		},
		async rescope(scope, captureId) {
			const capture = find(captureId);
			const store = deps.store;
			if (capture?.placement === undefined || capture.undone)
				return { level: "info", text: "Nothing to move: no remembered statement is pending." };
			if (store === undefined || !store.enabled()) return unavailable();
			capture.explicitScope = true;
			const from = capture.placement;
			if (from.scope === scope) return { level: "info", text: rememberedText(scope), chip: chip(capture, "remembered") };
			try {
				await unplace(store, from);
				capture.placement = await place(store, capture.text, capture.kind, scope);
			} catch (error) {
				return failed(error);
			}
			return { level: "success", text: rememberedText(scope), chip: chip(capture, "remembered") };
		},
		sessionNotes: notes,
		noteStandings(ids) {
			const standing = new Set(notes().map((note) => note.id));
			return new Map(
				ids.filter((id) => id.startsWith("note-")).map((id) => [id, standing.has(id) ? "eligible" : "deleted"] as const),
			);
		},
	};
}
