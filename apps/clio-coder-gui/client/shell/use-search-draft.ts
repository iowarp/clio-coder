import { useState } from "react";
import type { SearchDraft } from "./search-draft-model.js";
import { observed, startDraft, typed } from "./search-draft-model.js";

/** Binds a search box to a URL value without losing keystrokes typed before the router commits. */
export function useSearchDraft(urlValue: string, write: (value: string) => void) {
	const [draft, setDraft] = useState<SearchDraft>(() => startDraft(urlValue));
	const [seen, setSeen] = useState(urlValue);
	let current = draft;
	if (seen !== urlValue) {
		// Reconcile during render so the input never paints a stale value.
		current = observed(draft, urlValue);
		setSeen(urlValue);
		if (current !== draft) setDraft(current);
	}
	return {
		value: current.value,
		onChange: (event: { readonly target: { readonly value: string } }) => {
			const value = event.target.value;
			setDraft((previous) => typed(previous, value));
			write(value);
		},
	};
}

/** The next search params built from the live location, not the render-time copy a transition may hold back. */
export function liveSearchWith(key: string, value: string): URLSearchParams {
	const next = new URLSearchParams(window.location.search);
	if (value) next.set(key, value);
	else next.delete(key);
	return next;
}
