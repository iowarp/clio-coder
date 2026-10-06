import type { Migration, MigrationReport } from "./index.js";

/**
 * Fleet contracts became playbooks, and a plugin and its extension became two
 * packages. This converts the user home once: `<configDir>/fleets` merges into
 * `<configDir>/playbooks`, plugin install records drop the fleet kind, Library
 * plugins the new layout cannot read are replaced with the current Library copy
 * (the old Materio bundle becomes `plugin:materio`), and third-party plugins
 * that still declare fleets stay installed and are named with the fix. It never
 * installs or reinstalls an extension, because the operator reviews an
 * extension's capability envelope before it is installed and boot runs this
 * with no operator present. A bundle's runtime and an api 2 extension installed
 * before the envelope binding are each named with the command that installs it
 * with review. Each plugin install the conversion makes is a lifecycle receipt
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
