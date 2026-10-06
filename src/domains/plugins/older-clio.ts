/**
 * A package built for a Clio from before playbooks declares `resources.fleets`,
 * package or component kind `fleet`, or a `fleet:<name>` requirement in its
 * Clio namespace. This release refuses it with the fix instead of reading it.
 * The upgrade migration and the discovery error share this one detector.
 */

/** The canonical WTF-P install, which carries the WTF-P plugin and its desk extension. */
export const WTFP_PLUGIN_NAME = "wtfp";
export const WTFP_INSTALL_COMMAND = "wtf-p install clio";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What the Clio namespace declares from the retired fleets layout, or null when it declares none of it. */
export function olderClioDeclaration(namespace: unknown): string | null {
	if (!record(namespace)) return null;
	if (record(namespace.resources) && "fleets" in namespace.resources) return "resources.fleets";
	if (namespace.kind === "fleet") return "kind fleet";
	if (Array.isArray(namespace.requires) && namespace.requires.some((ref) => String(ref).startsWith("fleet:")))
		return "a fleet: requirement";
	if (Array.isArray(namespace.components)) {
		for (const item of namespace.components) {
			if (!record(item)) continue;
			if (item.kind === "fleet") return "a fleet component";
			if (Array.isArray(item.requires) && item.requires.some((ref) => String(ref).startsWith("fleet:")))
				return "a fleet: requirement";
		}
	}
	return null;
}

/** The refusal text: what was declared, what replaced it, and the exact fix for the named package. */
export function olderClioMessage(name: string, declaration: string): string {
	const fix =
		name === WTFP_PLUGIN_NAME
			? `install the current WTF-P with \`${WTFP_INSTALL_COMMAND}\`, which installs the WTF-P plugin and its desk extension`
			: "its author renames resources.fleets to resources.playbooks, the fleets directory to playbooks, and fleet kinds and requirements to playbook";
	return `built for an older Clio: ${name} declares ${declaration}, and playbooks replaced fleets; ${fix}`;
}
