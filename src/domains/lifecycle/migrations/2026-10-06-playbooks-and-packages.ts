import type { Migration, MigrationReport } from "./index.js";

/**
 * Fleet contracts became playbooks, and a plugin and its extension became two
 * packages. This converts the user home once: `<configDir>/fleets` merges into
 * `<configDir>/playbooks`, plugin install records drop the fleet kind, Library
 * installs the new layout cannot read are replaced with the current Library
 * copies (the old Materio bundle becomes `plugin:materio` plus
 * `extension:materio`), api 2 extensions installed before the envelope binding
 * are reinstalled from the Library or named with the command that reinstalls
 * them, and third-party plugins that still declare fleets stay installed and are
 * named with the fix. Each install the conversion makes is a lifecycle receipt
 * with actor `upgrade`. A workspace's `.clio-coder/` converts the first time
 * Clio opens it (`convertWorkspaceOnce`).
 *
 * The body loads on first use so `doctor` and `upgrade --dry-run`, which only
 * list migration ids, never load the plugin, extension and Library writers.
 */
const migration: Migration = {
	id: "2026-10-06-playbooks-and-packages",
	async up(): Promise<MigrationReport> {
		const { convertUserHome } = await import("../canonical-names.js");
		return convertUserHome();
	},
};

export default migration;
