import { join } from "node:path";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import {
	createProfileKnowledgeBase,
	type ProfileKnowledgeBase,
} from "../../src/domains/providers/profile-knowledge.js";

/**
 * The model catalog the package ships, alone: packaged profiles and their substring fallback tier, with no
 * `model-catalog.d` overlay and no operator profile file, so an overlay on the machine running the suite
 * cannot change an answer.
 */
export function packagedModelCatalog(): ProfileKnowledgeBase {
	return createProfileKnowledgeBase({
		overlayRoots: [],
		userPath: join(resolvePackageRoot(), "models", "operator-profiles-not-read.yaml"),
	});
}
