/** Local discovery must work without a second model or a phrase-perfect query. */
const STOP_WORDS = new Set(
	"a an and are as at be by can could for from how i in is it me of on or please the this to tool tools use with you".split(
		" ",
	),
);
const ALIASES: Readonly<Record<string, string>> = {
	interview: "ask_user question",
	clarify: "ask_user question",
	delegate: "dispatch worker",
	agent: "dispatch worker recipe",
	skill: "context workflow skill",
	test: "verify check test",
	search: "grep find search",
	file: "file path",
};

// In a task phrase, the subject carries more information than the request verb.
// Exact tool names still bypass this weighting entirely.
const REQUEST_VERBS = new Set("find search get show list inspect locate discover use".split(" "));

function singular(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 3 && term.endsWith("s") && !/(?:ss|us|is)$/u.test(term)) return term.slice(0, -1);
	return term;
}

function terms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(singular);
}

/** Exact names and phrases lead; partial task vocabulary still yields useful candidates. */
export function discoveryScore(query: string, name: string, description: string): number {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return 0;
	const lowerName = name.toLowerCase();
	const lowerDescription = description.toLowerCase();
	if (lowerName === normalized) return 10_000;
	const phrase = lowerName.includes(normalized) || lowerDescription.includes(normalized);
	const queryTerms = [...new Set(terms(normalized).filter((term) => !STOP_WORDS.has(term)))];
	const nameTerms = new Set(terms(lowerName));
	const descriptionTerms = new Set(terms(lowerDescription));
	let score = phrase ? 1000 : 0;
	for (const term of queryTerms) {
		const weight = queryTerms.length > 1 && REQUEST_VERBS.has(term) ? 0.1 : 1;
		if (nameTerms.has(term)) score += 20 * weight;
		if (descriptionTerms.has(term)) score += 5 * weight;
		for (const alias of terms(ALIASES[term] ?? "")) {
			if (nameTerms.has(alias)) score += 3 * weight;
			if (descriptionTerms.has(alias)) score += weight;
		}
	}
	return score;
}
