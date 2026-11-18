import { isAbsolute, join } from "node:path";
import { resolveClioDirs } from "../../core/xdg.js";

/**
 * The operator's components directory, set by `campaign run` for each entry. A component is an installation
 * artifact, not session data, so an entry whose own data root is empty and thrown away resolves the operator's
 * installed components from here, read-only: nothing installs into it.
 */
export const OPERATOR_COMPONENTS_ENV = "CLIO_CODER_OPERATOR_COMPONENTS_DIR";

function borrowedComponentsDir(): string | null {
	const dir = process.env[OPERATOR_COMPONENTS_ENV];
	return dir && isAbsolute(dir) ? dir : null;
}

/** True when this process runs on the operator's behalf and reads their components instead of installing its own. */
export function usesOperatorComponents(): boolean {
	return borrowedComponentsDir() !== null;
}

/** The components directory the operator's `clio-coder tools install` fills. */
export function operatorComponentsDir(): string {
	return borrowedComponentsDir() ?? join(resolveClioDirs().data, "components");
}

/** Where this process's own `tools install` puts a component version. */
export function componentInstallDir(id: string, version: string): string {
	return join(resolveClioDirs().data, "components", id, version);
}

/** Where the operator installs a component version, the path an install hint names. */
export function operatorComponentDir(id: string, version: string): string {
	return join(operatorComponentsDir(), id, version);
}

/** Every prefix a component version may already be installed in: this process's own, then the operator's. */
export function componentSearchDirs(id: string, version: string): string[] {
	const own = componentInstallDir(id, version);
	const operator = operatorComponentDir(id, version);
	return operator === own ? [own] : [own, operator];
}
