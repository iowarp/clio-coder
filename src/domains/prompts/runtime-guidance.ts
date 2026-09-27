import { type LoadedFragment, loadFragments } from "./fragment-loader.js";

let cachedGuidance: ReadonlyMap<string, LoadedFragment> | undefined;

/** Shipped procedures are retrieved as observations, never as authorization. */
export function guidanceForDocs(query: string): ReadonlyArray<{ id: string; text: string }> {
	if (!cachedGuidance) {
		const table = loadFragments();
		cachedGuidance = new Map(
			["operating.support-guidance", "operating.memory-guidance"].flatMap((id) => {
				const fragment = table.byId.get(id);
				return fragment ? [[id, fragment] as const] : [];
			}),
		);
	}
	const ids = ["operating.support-guidance"];
	// Retrieval vocabulary only: this selects text, never a permission or action.
	if (/\b(?:memory|remember\w*|retain\w*|retention|promot\w*)\b/iu.test(query)) {
		ids.push("operating.memory-guidance");
	}
	const guidance = cachedGuidance;
	return ids.flatMap((id) => {
		const fragment = guidance.get(id);
		return fragment ? [{ id, text: fragment.body.trim() }] : [];
	});
}
