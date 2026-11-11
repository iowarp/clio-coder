import { type LoadedFragment, loadFragments } from "./fragment-loader.js";
import { stripRowMarkers } from "./preconditions.js";

let cachedGuidance: ReadonlyMap<string, LoadedFragment> | undefined;

/** Shipped procedures are retrieved as observations, never as authorization. */
export function guidanceForDocs(query: string): ReadonlyArray<{ id: string; text: string }> {
	const ids = ["operating.support-guidance"];
	// Retrieval vocabulary only: this selects text, never a permission or action.
	if (/\b(?:memory|remember\w*|retain\w*|retention|promot\w*)\b/iu.test(query)) {
		ids.push("operating.memory-guidance");
	}
	if (PLAYBOOK_TOPIC.test(query)) ids.push("identity.docs-routing");
	return guidanceByIds(ids);
}

const PLAYBOOK_TOPIC = /\b(?:playbooks?|fleets?|workflows?|agent\s+bindings?|agentProfiles|profiles?)\b/iu;

/** Listing and authoring rules for a `kind=playbook` or `kind=agent` catalog read (S-84). */
export function guidanceForLibraryKind(kind: string | undefined): ReadonlyArray<{ id: string; text: string }> {
	return kind === "playbook" || kind === "agent" ? guidanceByIds(["identity.docs-routing"]) : [];
}

/** Route reading and configure_clio procedure for settings reads and previews (S-84). */
export function guidanceForSettings(): ReadonlyArray<{ id: string; text: string }> {
	return guidanceByIds(["identity.settings-routing"]);
}

/** The text form tool results append: a `Guidance:` heading, then each block. */
export function renderGuidance(blocks: ReadonlyArray<{ text: string }>): string {
	return blocks.length === 0 ? "" : `\n\nGuidance:\n${blocks.map((block) => block.text).join("\n\n")}`;
}

function guidanceByIds(ids: ReadonlyArray<string>): ReadonlyArray<{ id: string; text: string }> {
	if (!cachedGuidance) {
		const table = loadFragments();
		cachedGuidance = new Map(
			[
				"operating.support-guidance",
				"operating.memory-guidance",
				"identity.docs-routing",
				"identity.settings-routing",
			].flatMap((id) => {
				const fragment = table.byId.get(id);
				return fragment ? [[id, fragment] as const] : [];
			}),
		);
	}
	const guidance = cachedGuidance;
	return ids.flatMap((id) => {
		const fragment = guidance.get(id);
		return fragment ? [{ id, text: stripRowMarkers(fragment.body).trim() }] : [];
	});
}
