// The per-session draft registry and its browser storage keys. It sits apart from `composer-model.ts` so the task
// list can discard a deleted task's draft without pulling the composer's policy (and the slash table it reads) into
// the first-paint bundle.

import type { DraftStore } from "./composer-model.js";

/** Drafts are kept per session and capped, the same way `sessionBuffer` caps projections. */
export const MAX_DRAFT_STORES = 32;
export const DRAFT_KEY = "clio-coder-draft:";
export const DRAFT_INDEX = "clio-coder-draft-index";
export const stores = new Map<string, DraftStore>();

export function storedDraftIds(): string[] {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(DRAFT_INDEX) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
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
