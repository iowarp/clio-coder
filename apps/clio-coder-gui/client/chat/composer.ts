/**
 * Composer and message-action policy for the chat surface.
 *
 * Everything the composer decides lives here as a pure function or a plain
 * observable store: the draft itself, the submit decision, the Enter policy,
 * the mid-turn queue projection, the per-message action offers and the outcome
 * footer projection. The app has no DOM test environment, so a decision made
 * inside a component is a decision nothing checks. `Composer.tsx` and
 * `message-actions.tsx` stay declarative and call into this module.
 *
 * Nothing here imports React, a stylesheet or the API client, which is what
 * lets `tests/chat-composer.test.ts` run it under plain node:test.
 */

import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { SessionSnapshot, Turn, Usage } from "../../contracts/sessions.js";
import {
	QUEUE_MAX_ENTRIES,
	type QueueSnapshot,
	STEER_TEXT_MAX_BYTES,
	type SteerMode,
} from "../../contracts/steering.js";
import type { KeyEventLike } from "../interaction/keybindings.js";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";

/** `routes.turn` bounds its text at this many characters, so the composer refuses past it locally. */
export const PROMPT_TEXT_MAX_CHARACTERS = 32000;
/** The mode the engine itself defaults to when a steer carries none. */
export const DEFAULT_STEER_MODE: SteerMode = "next-slot";

// ---------------------------------------------------------------------------
// The draft store
// ---------------------------------------------------------------------------

export interface Draft {
	readonly text: string;
	/** Which queue a mid-turn send should ride. Ignored while no turn is running. */
	readonly mode: SteerMode;
	/**
	 * The `Idempotency-Key` for whatever this draft becomes. It is minted once
	 * per draft and survives an unchanged retry. Editing after a send has begun
	 * mints a new key so changed text cannot claim the earlier request's result.
	 */
	readonly key: string;
}

interface SavedDraft {
	readonly draft: Draft;
	readonly submittedKey: string | null;
}

function randomKey(): string {
	return crypto.randomUUID();
}

/**
 * The draft, held outside the component tree. The timeline re-renders on every
 * streamed delta; a draft that lived in the same component re-rendered the
 * textarea with it, which is the single largest perceived-speed cost in the
 * chat. Subscribers here are only the composer.
 */
export class DraftStore {
	readonly #mint: () => string;
	readonly #listeners = new Set<() => void>();
	#state: Draft;
	#submittedKey: string | null = null;
	#restoredSubmission = false;

	constructor(mint: () => string = randomKey, saved?: SavedDraft) {
		this.#mint = mint;
		this.#state = saved?.draft ?? { text: "", mode: DEFAULT_STEER_MODE, key: mint() };
		this.#submittedKey = saved?.submittedKey ?? null;
		this.#restoredSubmission = this.#submittedKey !== null;
	}

	readonly snapshot = (): Draft => this.#state;
	readonly submittedKey = (): string | null => this.#submittedKey;
	readonly uncertainSubmission = (): boolean => this.#restoredSubmission && this.#submittedKey === this.#state.key;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** Typing, and the retry and starter-prompt fills. Edits after a send get a new key. */
	write(text: string): void {
		if (text === this.#state.text) return;
		if (this.#submittedKey === this.#state.key) this.#restoredSubmission = false;
		this.#commit({ ...this.#state, text, key: this.#submittedKey === this.#state.key ? this.#mint() : this.#state.key });
	}

	chooseMode(mode: SteerMode): void {
		if (mode === this.#state.mode) return;
		if (this.#submittedKey === this.#state.key) this.#restoredSubmission = false;
		this.#commit({ ...this.#state, mode, key: this.#submittedKey === this.#state.key ? this.#mint() : this.#state.key });
	}

	/** An unchanged retry keeps this key; editing after a send starts a new request. */
	markSubmitted(sent: Draft): void {
		if (this.#state.key === sent.key) {
			this.#submittedKey = sent.key;
			this.#notify();
		}
	}

	/** A cleared draft is a new message. */
	clear(): void {
		this.#submittedKey = null;
		this.#restoredSubmission = false;
		this.#commit({ text: "", mode: this.#state.mode, key: this.#mint() });
	}

	/** Acknowledging a send must never erase text typed while the request was in flight. */
	acknowledge(sent: Draft): void {
		if (this.#submittedKey === sent.key) this.#submittedKey = null;
		this.#restoredSubmission = false;
		if (this.#state.key === sent.key && this.#state.text === sent.text && this.#state.mode === sent.mode) {
			this.clear();
			return;
		}
		// Typing after the submitted text is the common case. Keep only the new
		// suffix; if the earlier text was edited, leave it intact for review.
		const text =
			this.#state.text !== sent.text && this.#state.text.startsWith(sent.text)
				? this.#state.text.slice(sent.text.length).trimStart()
				: this.#state.text;
		// The remaining draft is a new request. Reusing the acknowledged key would
		// make the server return the previous result instead of sending it.
		this.#commit({ ...this.#state, text, key: this.#state.key === sent.key ? this.#mint() : this.#state.key });
	}

	/** A definite refusal kept no message, so the same text may be sent as a new request. */
	refuse(sent: Draft): void {
		if (this.#submittedKey !== sent.key) return;
		this.#submittedKey = null;
		this.#restoredSubmission = false;
		if (this.#state.key === sent.key) this.#commit({ ...this.#state, key: this.#mint() });
		else this.#notify();
	}

	#commit(next: Draft): void {
		this.#state = next;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** Drafts are kept per session and capped, the same way `sessionBuffer` caps projections. */
export const MAX_DRAFT_STORES = 32;
const DRAFT_KEY = "clio-coder-draft:";
const DRAFT_INDEX = "clio-coder-draft-index";
const stores = new Map<string, DraftStore>();

function storedDraftIds(): string[] {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(DRAFT_INDEX) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

function savedDraft(id: string): SavedDraft | undefined {
	try {
		const raw = sessionStorage.getItem(`${DRAFT_KEY}${id}`);
		if (!raw) return;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return;
		const draft = (value as { draft?: unknown }).draft;
		const submittedKey = (value as { submittedKey?: unknown }).submittedKey;
		if (typeof draft !== "object" || draft === null) return;
		const fields = draft as Partial<Draft>;
		if (
			typeof fields.text !== "string" ||
			typeof fields.key !== "string" ||
			!/^[!-~]{1,128}$/.test(fields.key) ||
			(fields.mode !== "next-slot" && fields.mode !== "end-of-turn")
		)
			return;
		return {
			draft: { text: fields.text, mode: fields.mode, key: fields.key },
			submittedKey: submittedKey === fields.key ? fields.key : null,
		};
	} catch {
		return;
	}
}

function persistDraft(id: string, store: DraftStore): void {
	try {
		const draft = store.snapshot();
		const key = `${DRAFT_KEY}${id}`;
		const index = storedDraftIds();
		if (draft.text === "") {
			sessionStorage.removeItem(key);
			sessionStorage.setItem(DRAFT_INDEX, JSON.stringify(index.filter((entry) => entry !== id)));
			return;
		}
		sessionStorage.setItem(
			key,
			JSON.stringify({ draft, submittedKey: store.submittedKey() === draft.key ? draft.key : null }),
		);
		if (index.includes(id)) return;
		index.push(id);
		while (index.length > MAX_DRAFT_STORES) {
			const oldest = index.shift();
			if (oldest) sessionStorage.removeItem(`${DRAFT_KEY}${oldest}`);
		}
		sessionStorage.setItem(DRAFT_INDEX, JSON.stringify(index));
	} catch {
		// The draft still lives in memory when browser storage is unavailable or full.
	}
}

export function draftStore(id: string): DraftStore {
	let store = stores.get(id);
	if (!store) {
		if (stores.size >= MAX_DRAFT_STORES) {
			const oldest = stores.keys().next().value;
			if (oldest !== undefined) stores.delete(oldest);
		}
		const created = new DraftStore(randomKey, savedDraft(id));
		created.subscribe(() => persistDraft(id, created));
		store = created;
	}
	stores.delete(id);
	stores.set(id, store);
	return store;
}

export function discardDraftStore(id: string): void {
	stores.delete(id);
	try {
		sessionStorage.removeItem(`${DRAFT_KEY}${id}`);
		sessionStorage.setItem(DRAFT_INDEX, JSON.stringify(storedDraftIds().filter((entry) => entry !== id)));
	} catch {
		/* Deletion still removes the in-memory draft when browser storage is unavailable. */
	}
}

export function resetDraftStores(): void {
	stores.clear();
}

// ---------------------------------------------------------------------------
// What the agent announced
// ---------------------------------------------------------------------------

export interface SteeringAffordances {
	/** POST /steer will be served. `steering.main` is false when the build has no steer queue. */
	readonly steer: boolean;
	/** The modes the engine named, filtered to the two this app knows how to send. */
	readonly modes: readonly SteerMode[];
	/** POST /interrupt will be served. */
	readonly interrupt: boolean;
	/** GET /queue and POST /queue/clear will be served. */
	readonly queue: boolean;
	/** POST /dispatch/steer will be served. */
	readonly dispatch: boolean;
}

export const NO_STEERING: SteeringAffordances = {
	steer: false,
	modes: [],
	interrupt: false,
	queue: false,
	dispatch: false,
};

const KNOWN_MODES: readonly SteerMode[] = ["next-slot", "end-of-turn"];

/**
 * Projects `GET /capabilities` onto the four controls this track offers. Every
 * steering route answers 409 when the agent announced no `steering` member at
 * all, so an absent capability hides the control rather than letting the
 * operator press something that refuses.
 */
export function steeringAffordances(capabilities: AgentCapabilities | null | undefined): SteeringAffordances {
	const steering = capabilities?.steering;
	if (steering === undefined) return NO_STEERING;
	const modes = KNOWN_MODES.filter((mode) => steering.modes.includes(mode));
	return {
		steer: steering.main && modes.length > 0,
		modes,
		interrupt: steering.interrupt,
		queue: true,
		dispatch: steering.dispatch,
	};
}

export interface SteerModeOffer {
	readonly mode: SteerMode;
	readonly label: string;
	readonly lands: string;
}

/**
 * The two modes are not interchangeable and the difference is not obvious from
 * their names, so the surface names the consequence rather than the queue.
 */
const MODE_COPY: Readonly<Record<SteerMode, Omit<SteerModeOffer, "mode">>> = {
	"next-slot": { label: "Now", lands: "Lands between tool calls, while this turn is still running." },
	"end-of-turn": { label: "After this turn", lands: "Waits in the follow-up queue until the whole turn has settled." },
};

export function steerModeOffers(affordances: SteeringAffordances): readonly SteerModeOffer[] {
	return affordances.modes.map((mode) => ({ mode, ...MODE_COPY[mode] }));
}

// ---------------------------------------------------------------------------
// The submit decision
// ---------------------------------------------------------------------------

export type SubmitIntent =
	| { readonly kind: "prompt"; readonly text: string; readonly idempotencyKey: string }
	| { readonly kind: "steer"; readonly text: string; readonly mode: SteerMode; readonly idempotencyKey: string }
	| { readonly kind: "blocked"; readonly reason: string };

export interface ComposerSituation {
	readonly sessionState: SessionSnapshot["state"];
	readonly turnRunning: boolean;
	/** A send this composer already put on the wire and has not settled. */
	readonly sending: boolean;
	readonly steering: SteeringAffordances;
	/** Absent when the agent's capability answer is available. */
	readonly steeringUnavailable?: "checking" | "failed";
}

const CLOSED_SESSION_REASON: Readonly<Record<string, string>> = {
	starting: "This session is still starting. It will take a prompt once the agent answers.",
	unknown: "This session is not reachable right now, so nothing can be sent into it.",
	closed: "This session is closed. Open a new one to keep working.",
	failed: "This session failed. Open a new one to keep working.",
};

function blocked(reason: string): SubmitIntent {
	return { kind: "blocked", reason };
}

/** Characters for the route schema, bytes for the engine's own steer bound. */
export function textSize(text: string): { readonly characters: number; readonly bytes: number } {
	return { characters: text.length, bytes: new TextEncoder().encode(text).length };
}

function tooLong(text: string, characters: number, bytes: number): string | null {
	const size = textSize(text);
	if (size.characters > characters)
		return `This message is ${size.characters.toLocaleString("en-US")} characters and the limit is ${characters.toLocaleString("en-US")}. Shorten it or send it in two.`;
	if (size.bytes > bytes)
		return `This message is ${size.bytes.toLocaleString("en-US")} bytes and the limit is ${bytes.toLocaleString("en-US")}. Shorten it or send it in two.`;
	return null;
}

/**
 * The whole submit policy, in one place. A running turn does not block the
 * composer: it redirects the send into the steering queue when the agent
 * announced one, and explains itself when it did not.
 */
export function submitIntent(draft: Draft, situation: ComposerSituation): SubmitIntent {
	if (situation.sending) return blocked("The previous send is still on the wire.");
	if (situation.sessionState !== "open")
		return blocked(CLOSED_SESSION_REASON[situation.sessionState] ?? "This session cannot take a message.");
	const text = draft.text.trim();
	if (text === "") return blocked("Write a message first.");
	if (situation.turnRunning) {
		if (situation.steeringUnavailable === "checking")
			return blocked("Checking whether this agent can accept a message during the current turn.");
		if (situation.steeringUnavailable === "failed")
			return blocked("Could not check this agent's mid-turn controls. Retry the check before sending.");
		if (!situation.steering.steer)
			return blocked(
				"This Clio Coder build cannot take direction while a turn runs. Your draft is kept; send it when the turn settles, or stop the turn.",
			);
		const mode = situation.steering.modes.includes(draft.mode) ? draft.mode : situation.steering.modes[0];
		if (mode === undefined) return blocked("This Clio Coder build announced no steering mode.");
		const over = tooLong(text, STEER_TEXT_MAX_BYTES, STEER_TEXT_MAX_BYTES);
		return over === null ? { kind: "steer", text, mode, idempotencyKey: draft.key } : blocked(over);
	}
	const over = tooLong(text, PROMPT_TEXT_MAX_CHARACTERS, PROMPT_TEXT_MAX_CHARACTERS * 4);
	return over === null ? { kind: "prompt", text, idempotencyKey: draft.key } : blocked(over);
}

/** The label the submit control carries, which is also the promise it makes. */
export function submitLabel(intent: SubmitIntent, situation: ComposerSituation, mode?: SteerMode): string {
	if (intent.kind === "steer") return intent.mode === "next-slot" ? "Send now" : "Queue for after";
	if (intent.kind === "prompt") return "Send";
	// A blocked button (empty draft) still names what the chosen delivery mode would do.
	if (!(situation.turnRunning && situation.steering.steer)) return "Send";
	return mode === "end-of-turn" ? "Queue for after" : "Send now";
}

// ---------------------------------------------------------------------------
// The Enter policy
// ---------------------------------------------------------------------------

export type ComposerKeyAction = "send" | "newline" | "ignore";

export interface ComposerKeyContext {
	/** True while a dialog, the palette or any other layer owns the keyboard. */
	readonly layerOwned: boolean;
	/** True mid-IME-composition, where Enter commits a candidate and must never send. */
	readonly composing: boolean;
}

/**
 * Enter sends, Shift+Enter inserts a newline, and the declared `send` chord
 * (Ctrl or Cmd + Enter) sends as well so the registry's own binding keeps
 * working from the composer.
 *
 * Plain Enter is deliberately NOT a registry entry. `tests/interaction.test.ts`
 * asserts the table never binds a bare printable key, and rightly so: a bare
 * Enter is a composer-local policy that depends on which field has focus, not a
 * document-level chord. The registry keeps the chord; this keeps the policy.
 */
export function composerKeyAction(event: KeyEventLike, context: ComposerKeyContext): ComposerKeyAction {
	if (event.key !== "Enter") return "ignore";
	if (context.composing) return "newline";
	if (context.layerOwned) return "newline";
	if (matchesKeybinding(KEYBINDINGS.send, event)) return "send";
	if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return "newline";
	return "send";
}

// ---------------------------------------------------------------------------
// The queue waiting on the engine
// ---------------------------------------------------------------------------

export type QueueName = "steer" | "follow-up";

export interface QueuedMessage {
	readonly id: string;
	readonly queue: QueueName;
	readonly position: number;
	readonly text: string;
	readonly lands: string;
}

/**
 * `GET /queue` returns two flat arrays of text. This gives each entry a stable
 * key, a position and the sentence that says when it will be read, in the order
 * the engine will read them: the steering queue drains mid-run, the follow-up
 * queue after the turn.
 */
export function projectQueue(snapshot: QueueSnapshot | null | undefined): readonly QueuedMessage[] {
	if (!snapshot) return [];
	const rows: QueuedMessage[] = [];
	const push = (queue: QueueName, texts: readonly string[], lands: string) => {
		for (const [index, text] of texts.slice(0, QUEUE_MAX_ENTRIES).entries())
			rows.push({ id: `${queue}:${index}`, queue, position: index + 1, text, lands });
	};
	push("steer", snapshot.steer, MODE_COPY["next-slot"].lands);
	push("follow-up", snapshot.followUp, MODE_COPY["end-of-turn"].lands);
	return rows;
}

export function queueSummary(messages: readonly QueuedMessage[]): string {
	if (messages.length === 0) return "Nothing is waiting.";
	const steering = messages.filter((message) => message.queue === "steer").length;
	const followUp = messages.length - steering;
	const parts: string[] = [];
	if (steering > 0) parts.push(`${steering} waiting for the next tool call`);
	if (followUp > 0) parts.push(`${followUp} waiting for the turn to end`);
	return `${parts.join(" · ")}.`;
}

/**
 * `POST /queue/clear` hands back every text it drained, and they are the
 * client's to re-send. Dropping them would lose typed work, so they come back
 * into the draft, appended after whatever is already there and deduplicated
 * against it.
 */
export function restoredDraft(current: string, restored: readonly string[]): string {
	const blocks = current.trim() === "" ? [] : [current.trimEnd()];
	for (const text of restored) {
		const trimmed = text.trim();
		if (trimmed !== "" && !blocks.includes(trimmed)) blocks.push(trimmed);
	}
	return blocks.join("\n\n").slice(0, PROMPT_TEXT_MAX_CHARACTERS);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export interface ComposerNotice {
	readonly tone: "warn" | "fail";
	readonly message: string;
}

function problemOf(error: unknown): { status?: unknown; detail?: unknown } | null {
	if (typeof error !== "object" || error === null) return null;
	const problem = (error as { problem?: unknown }).problem;
	return typeof problem === "object" && problem !== null ? (problem as { status?: unknown; detail?: unknown }) : null;
}

/**
 * A 409 from a steering route is not an error, it is the agent saying it does
 * not serve that method. It reads as a plain sentence in the composer and never
 * as a failure toast.
 */
export function capabilityRefusal(error: unknown): string | null {
	const problem = problemOf(error);
	if (problem?.status !== 409) return null;
	return typeof problem.detail === "string" && problem.detail.trim() !== ""
		? problem.detail
		: "This Clio Coder build does not serve that control.";
}

export function noticeForError(error: unknown): ComposerNotice | null {
	if (error === null || error === undefined) return null;
	const refusal = capabilityRefusal(error);
	if (refusal !== null) return { tone: "warn", message: refusal };
	const message = error instanceof Error ? error.message : String(error);
	return { tone: "fail", message };
}

/**
 * `POST /steer` and `POST /interrupt` answer 200 with `accepted: false` or
 * `cancelled: false` and a refusal sentence. That is a reported fact, not an
 * error, and it must be shown rather than swallowed.
 */
export function noticeForRefusal(
	result: { readonly accepted?: boolean; readonly cancelled?: boolean; readonly refusal?: string } | null | undefined,
): ComposerNotice | null {
	if (!result) return null;
	const settled = result.accepted ?? result.cancelled ?? true;
	if (settled) return null;
	return { tone: "warn", message: result.refusal ?? "The engine refused, and reported no reason." };
}

// ---------------------------------------------------------------------------
// Per-message actions
// ---------------------------------------------------------------------------

export type MessageActionId = "copy-request" | "copy-response" | "retry";

export interface MessageActionOffer {
	readonly id: MessageActionId;
	readonly label: string;
	readonly available: boolean;
	/** Why the action is not offered, for the title attribute. Null when it is. */
	readonly unavailable: string | null;
}

export interface MessageActionContext {
	/** The operator's own prompt, verbatim. */
	readonly requestText: string | null;
	/** The response segments joined by a blank line, as raw Markdown. */
	readonly responseText: string;
	readonly status: Turn["status"];
}

/**
 * Retry fills the composer and focuses it. It never auto-sends: a failed turn
 * usually needs the prompt edited, and re-sending an identical prompt into a
 * failing route is the loop the safety system exists to break.
 */
export function messageActionOffers(context: MessageActionContext): readonly MessageActionOffer[] {
	const hasRequest = (context.requestText ?? "").trim() !== "";
	const hasResponse = context.responseText.trim() !== "";
	const retryable = context.status === "failed" || context.status === "cancelled";
	return [
		{
			id: "copy-request",
			label: "Copy prompt",
			available: hasRequest,
			unavailable: hasRequest ? null : "This turn recorded no prompt.",
		},
		{
			id: "copy-response",
			label: "Copy response",
			available: hasResponse,
			unavailable: hasResponse ? null : "This turn has not written anything yet.",
		},
		{
			id: "retry",
			label: "Try again",
			available: retryable && hasRequest,
			unavailable: retryable
				? hasRequest
					? null
					: "This turn recorded no prompt to try again."
				: "Only a failed or stopped turn can be tried again.",
		},
	];
}

// ---------------------------------------------------------------------------
// The outcome footer
// ---------------------------------------------------------------------------

export type OutcomeTone = "neutral" | "running" | "success" | "warn" | "fail" | "unverified";

export interface TurnOutcomeView {
	readonly tone: OutcomeTone;
	readonly glyph: string;
	readonly label: string;
	/** The problem detail, when the turn carried one. */
	readonly detail: string | null;
	readonly stopReason: string | null;
	readonly facts: readonly string[];
	/** Reported accounting, retained for the keyboard-reachable breakdown beside the outcome. */
	readonly usage: Usage | null;
	readonly usageTitle: string | null;
	readonly finishedAt: string | null;
}

/** Two numbers visible. */
export function usageSummary(usage: Usage): string {
	return `${usage.input.toLocaleString("en-US")} in · ${usage.output.toLocaleString("en-US")} out`;
}

/** Five in the tooltip, because the other three are cache and reasoning accounting. */
export function usageTitle(usage: Usage): string {
	return [
		`input ${usage.input.toLocaleString("en-US")}`,
		`output ${usage.output.toLocaleString("en-US")}`,
		`cache read ${usage.cacheRead.toLocaleString("en-US")}`,
		`cache write ${usage.cacheWrite.toLocaleString("en-US")}`,
		`reasoning ${usage.reasoning.toLocaleString("en-US")}`,
	].join(" · ");
}

const OUTCOME: Readonly<Record<Turn["status"], { tone: OutcomeTone; glyph: string; label: string }>> = {
	running: { tone: "running", glyph: "▸", label: "Turn running" },
	succeeded: { tone: "success", glyph: "✓", label: "Turn complete" },
	failed: { tone: "fail", glyph: "✕", label: "Turn failed" },
	cancelled: { tone: "warn", glyph: "–", label: "Turn stopped" },
};

/**
 * The footer carries per-turn facts: how many tool calls this turn made and what
 * it spent. Both are reported values; nothing here is derived or estimated.
 */
export function turnOutcome(turn: Turn, toolCount: number): TurnOutcomeView {
	const shape = OUTCOME[turn.status];
	const facts: string[] = [];
	if (toolCount > 0) facts.push(`${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`);
	if (turn.usage !== null) facts.push(`tokens ${usageSummary(turn.usage)}`);
	return {
		tone: shape.tone,
		glyph: shape.glyph,
		label: shape.label,
		detail: turn.status === "succeeded" ? null : (turn.problem?.detail ?? null),
		stopReason: turn.status === "failed" ? turn.stopReason : null,
		facts,
		usage: turn.usage,
		usageTitle: turn.usage === null ? null : usageTitle(turn.usage),
		finishedAt: turn.finishedAt,
	};
}
