import { type MemoryRestorationInput, type MemoryRestorationRender, renderMemoryRestoration } from "./restoration.js";

export interface MemoryCommitScope {
	readonly sessionId: string;
	readonly branchAnchorTurnId: string | null;
}

/** The host must verify successful durability/current scope before calling the notifier. */
export interface SuccessfulMemoryContextCommit extends MemoryCommitScope {
	readonly kind: "continuity" | "summary";
	readonly commitId: string;
	readonly outcome: "summarized" | "evicted" | "continuity_only";
}

export interface MemoryContentStamp {
	readonly generation: number;
	readonly commitEpoch: number;
}

export interface MemoryRestorationOffer extends MemoryRestorationRender {
	readonly commitId: string;
	readonly scope: MemoryCommitScope;
	readonly authority: MemoryContentStamp;
}

export type MemoryCommitVerdict = "accepted" | "duplicate" | "conflict" | "stale" | "disposed";

export interface PrepareMemoryRestorationInput extends MemoryRestorationInput {
	readonly scope: MemoryCommitScope;
	readonly generation: number;
}

/**
 * In-process content authority only. Owns no bank, usage, queue, IO or model.
 * Retain seen identities for the active scope rather than evicting old IDs and
 * permitting duplicate commits to advance the epoch again. Cancellation revokes
 * offers but keeps pending restoration; navigation explicitly clears it.
 */
export class MemoryCommitState {
	#scope: MemoryCommitScope;
	#generation: number;
	#commitEpoch = 0;
	#disposed = false;
	#seen = new Map<string, SuccessfulMemoryContextCommit["outcome"]>();
	#pending: string | null = null;
	#issued: MemoryRestorationOffer | null = null;

	constructor(scope: MemoryCommitScope, generation: number) {
		assertScope(scope);
		assertGeneration(generation);
		this.#scope = copyScope(scope);
		this.#generation = generation;
	}

	capture(): MemoryContentStamp {
		return Object.freeze({ generation: this.#generation, commitEpoch: this.#commitEpoch });
	}

	isCurrent(stamp: MemoryContentStamp, scope: MemoryCommitScope): boolean {
		return !this.#disposed && this.#matches(scope, stamp.generation) && stamp.commitEpoch === this.#commitEpoch;
	}

	notifyContextCommitted(input: SuccessfulMemoryContextCommit, generation: number): MemoryCommitVerdict {
		if (this.#disposed) return "disposed";
		if (!this.#matches(input, generation)) {
			return generation === this.#generation && this.#seen.has(input.commitId) ? "conflict" : "stale";
		}
		if (input.commitId.trim().length === 0) throw new Error("memory commit identity must be nonblank");
		const previous = this.#seen.get(input.commitId);
		if (previous !== undefined) return previous === input.outcome ? "duplicate" : "conflict";
		if (this.#commitEpoch === Number.MAX_SAFE_INTEGER) throw new Error("memory commit epoch exhausted");
		this.#seen.set(input.commitId, input.outcome);
		this.#commitEpoch += 1;
		this.#pending = input.commitId;
		this.#issued = null;
		return "accepted";
	}

	prepareRestoration(input: PrepareMemoryRestorationInput): MemoryRestorationOffer | null {
		if (this.#disposed || !this.#matches(input.scope, input.generation) || this.#pending === null) return null;
		const rendered = renderMemoryRestoration(input);
		this.#issued = Object.freeze({
			...rendered,
			commitId: this.#pending,
			scope: this.#scope,
			authority: this.capture(),
		});
		return this.#issued;
	}

	/** Host calls only after installing the exact offered bytes into its admitted context. */
	acknowledgeRestoration(offer: MemoryRestorationOffer, scope: MemoryCommitScope, generation: number): boolean {
		if (
			this.#disposed ||
			offer !== this.#issued ||
			!this.#matches(scope, generation) ||
			!this.isCurrent(offer.authority, offer.scope)
		)
			return false;
		this.#pending = null;
		this.#issued = null;
		return true;
	}

	/** Caller supplies a strictly newer generation; no bank reset and no new commit epoch. */
	cancel(generation: number): boolean {
		if (this.#disposed || !validGeneration(generation) || generation <= this.#generation) return false;
		this.#generation = generation;
		this.#issued = null;
		return true;
	}

	/** Navigation is explicit even when returning to the same session/branch identity. */
	reset(scope: MemoryCommitScope, generation: number): boolean {
		if (this.#disposed || !validGeneration(generation) || generation <= this.#generation) return false;
		assertScope(scope);
		this.#scope = copyScope(scope);
		this.#generation = generation;
		this.#commitEpoch = 0;
		this.#seen.clear();
		this.#pending = null;
		this.#issued = null;
		return true;
	}

	dispose(): void {
		this.#disposed = true;
		this.#seen.clear();
		this.#pending = null;
		this.#issued = null;
	}

	#matches(scope: MemoryCommitScope, generation: number): boolean {
		return (
			generation === this.#generation &&
			scope.sessionId === this.#scope.sessionId &&
			scope.branchAnchorTurnId === this.#scope.branchAnchorTurnId
		);
	}
}

function validGeneration(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function assertGeneration(value: number): void {
	if (!validGeneration(value)) throw new Error("memory generation must be a nonnegative safe integer");
}

function assertScope(scope: MemoryCommitScope): void {
	if (
		scope.sessionId.trim().length === 0 ||
		(scope.branchAnchorTurnId !== null && scope.branchAnchorTurnId.trim().length === 0)
	)
		throw new Error("memory scope identities must be nonblank");
}

function copyScope(scope: MemoryCommitScope): MemoryCommitScope {
	return Object.freeze({ sessionId: scope.sessionId, branchAnchorTurnId: scope.branchAnchorTurnId });
}
