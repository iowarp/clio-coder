import {
	acknowledgeFirstRequest,
	decodeHomeDraft,
	type FirstRequest,
	HOME_DRAFT_TEXT_MAX_CHARACTERS,
	type HomeDraft,
} from "./home-draft-model.js";

// The explicit Forget Browser action already clears this namespace before reloading.
const KEY = "clio-coder-draft:home-first-task";
let state: HomeDraft | undefined;
const listeners = new Set<() => void>();
let busy = false;

export function homeDraft(): HomeDraft {
	if (!state) {
		try {
			state = decodeHomeDraft(sessionStorage.getItem(KEY));
		} catch {
			// Route continuity still works in memory when per-tab storage is disabled.
			state = decodeHomeDraft(null);
		}
	}
	return state;
}

export function subscribeHomeDraft(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function updateHomeDraft(patch: Partial<HomeDraft>): void {
	const previous = homeDraft();
	if (patch.text !== undefined) {
		patch =
			patch.text.length > HOME_DRAFT_TEXT_MAX_CHARACTERS
				? { ...patch, text: previous.text, textIssue: "too-large" }
				: { ...patch, textIssue: patch.textIssue ?? null };
	}
	const edited =
		(patch.text !== undefined && patch.text !== previous.text) ||
		(patch.workspaceId !== undefined && patch.workspaceId !== previous.workspaceId);
	state = { ...previous, ...patch, revision: Math.min(previous.revision + (edited ? 1 : 0), Number.MAX_SAFE_INTEGER) };
	try {
		sessionStorage.setItem(KEY, JSON.stringify(state));
	} catch {
		// Keep the in-memory draft when browser storage is unavailable or full.
	}
	for (const listener of listeners) listener();
}

export function confirmFirstRequest(sent: FirstRequest): void {
	updateHomeDraft(acknowledgeFirstRequest(homeDraft(), sent));
}

/** Route changes can remount Home while its mutation is still running. */
export function acquireFirstRequest(): boolean {
	if (busy) return false;
	busy = true;
	for (const listener of listeners) listener();
	return true;
}

export function releaseFirstRequest(): void {
	busy = false;
	for (const listener of listeners) listener();
}

export const firstRequestBusy = (): boolean => busy;
