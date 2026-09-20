import { marked, type Token, type Tokens } from "marked";

/** Deterministic heading anchors shared by the document link check and renderer. */
export function documentHeadings(tokens: readonly Token[]) {
	const ids = new Map<Token, string>();
	const counts = new Map<string, number>();
	marked.walkTokens([...tokens], (token) => {
		if (token.type !== "heading") return;
		const text = (token as Tokens.Heading).text.replace(/<[^>]*>/g, "").replace(/[`*_~]/g, "");
		const base = text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}_\s-]/gu, "")
			.replace(/\s/g, "-");
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		ids.set(token, n ? `${base}-${n}` : base);
	});
	return ids;
}
