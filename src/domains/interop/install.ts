import { installLibraryPackage, type LibraryPackageInstallInput, type PluginInstallResult } from "../plugins/index.js";

/** Keep every adoption on the same provenance, trust, integrity and removal seam as the library. */
export function installInteropPackage(input: LibraryPackageInstallInput): PluginInstallResult {
	return installLibraryPackage(input);
}
