// Which library rows the desktop may act on, and what an extension row offers instead. The plan contract's
// `packageRef` names only the PACKAGE_KINDS, so a button on any other kind is a guaranteed 400. Extension
// consent (the capability envelope review) stays in the terminal. Pure, so the commands are testable without a browser.

import { copyOperations, missingScopes, PACKAGE_KINDS, type Package, type Scope, verb } from "./library-plan.js";

export interface TerminalStep {
	label: string;
	command: string;
}

export const TERMINAL_NOTE =
	"Extensions are reviewed and changed in the terminal, where their capability envelope is shown for approval. Run one of these, or open /library in Clio Coder.";

/** True when the plan contract accepts this package's ref, so the catalog may offer Install, Update, Enable, Disable and Remove. */
export const desktopManaged = (pkg: Pick<Package, "kind">): boolean =>
	(PACKAGE_KINDS as readonly string[]).includes(pkg.kind);

const scopeFlag = (scope: Scope) => `--${scope}`;

/** The terminal command for each action the catalog would have offered on this row, in the order it would have offered them. */
export function terminalSteps(pkg: Package): TerminalStep[] {
	const steps: TerminalStep[] = [];
	for (const copy of pkg.copies) {
		const scope = copy.scope as Scope;
		for (const operation of copyOperations(String(copy.state))) {
			steps.push({
				label: `${verb(operation)} the ${scope} copy`,
				command: `clio-coder library ${operation} ${pkg.ref} ${scopeFlag(scope)}`,
			});
		}
	}
	if (pkg.catalogOrigin !== "installed") {
		for (const scope of missingScopes(pkg)) {
			steps.push(
				scope === "user"
					? { label: "Install for me", command: `clio-coder library install ${pkg.ref}` }
					: { label: "Install in this project", command: `clio-coder library install ${pkg.ref} --project` },
			);
		}
	}
	return steps;
}
