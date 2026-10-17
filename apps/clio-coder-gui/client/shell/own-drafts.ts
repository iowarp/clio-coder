// The drafts this window created, so "New task" reuses only its own (#420). sessionStorage is the
// narrowest identity that survives a reload of one window and differs between windows: every tab and
// every window opened through openAppWindow (noopener) starts with its own copy.

import { withOwnDraft } from "./shell-model.js";

const OWN_DRAFTS_KEY = "clio-coder-own-drafts";

export function ownDrafts(): string[] {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(OWN_DRAFTS_KEY) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

export function rememberOwnDraft(id: string): void {
	try {
		sessionStorage.setItem(OWN_DRAFTS_KEY, JSON.stringify(withOwnDraft(ownDrafts(), id)));
	} catch {
		// Without storage this window forgets its draft, and the next New task starts a fresh session instead.
	}
}
