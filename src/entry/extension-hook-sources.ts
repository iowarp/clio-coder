import type { ExtensionSnapshot } from "../domains/extensions/index.js";
import type { CapturedHookSourceSet } from "../domains/middleware/index.js";

/**
 * Adapt an extension snapshot's captured hook declarations to the
 * middleware-native captured source set. This is the only place the two
 * domains' shapes meet; middleware never imports extension types.
 */
export function capturedHookSourcesFor(
	snapshot: Pick<ExtensionSnapshot, "generation" | "hookSources">,
): CapturedHookSourceSet {
	return {
		generation: snapshot.generation,
		sources: snapshot.hookSources.map((source) => ({
			provenance: {
				id: source.provenance.id,
				scope: source.provenance.scope,
				...(source.provenance.sourcePath !== undefined ? { sourcePath: source.provenance.sourcePath } : {}),
				canonicalRoot: source.provenance.canonicalRoot,
				manifestDigest: source.provenance.manifestDigest,
				contentDigest: source.provenance.contentDigest,
			},
			declarationsDigest: source.declarationsDigest,
			declarations: source.declarations,
			...(source.parseError !== undefined ? { parseError: source.parseError } : {}),
		})),
	};
}
