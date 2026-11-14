/**
 * A URL-bound search box keeps its own draft. React Router commits search-param navigations inside a transition, so
 * the URL value a render sees can lag several keystrokes behind the input. The draft is what the operator typed; the
 * values it already sent are remembered so their late echoes are not mistaken for an outside navigation.
 */

export interface SearchDraft {
	readonly value: string;
	readonly sent: readonly string[];
}

const SENT_LIMIT = 32;

export function startDraft(url: string): SearchDraft {
	return { value: url, sent: [] };
}

export function typed(draft: SearchDraft, value: string): SearchDraft {
	const sent = [...draft.sent, value];
	return { value, sent: sent.length > SENT_LIMIT ? sent.slice(sent.length - SENT_LIMIT) : sent };
}

export function observed(draft: SearchDraft, url: string): SearchDraft {
	if (url === draft.value) return draft.sent.length === 0 ? draft : { value: draft.value, sent: [] };
	const index = draft.sent.indexOf(url);
	if (index >= 0) return { value: draft.value, sent: draft.sent.slice(index + 1) };
	// Back, Forward, "Clear filters" or a link: the URL wins.
	return { value: url, sent: [] };
}
