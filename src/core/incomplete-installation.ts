import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageRoot } from "./package-root.js";

function missingModulePath(message: string): string | null {
	const specifier = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(message)?.[1];
	if (!specifier) return null;
	if (specifier.startsWith("file:")) {
		try {
			return fileURLToPath(specifier);
		} catch {
			return null;
		}
	}
	return isAbsolute(specifier) ? specifier : null;
}

/**
 * Turn a missing Clio-owned lazy chunk into an actionable reinstall message.
 * Errors for user extensions, hooks, or any module outside this installation's
 * generated `dist` directory remain untouched.
 */
export function incompleteInstallationAdvice(err: unknown): string | null {
	if ((err as NodeJS.ErrnoException | undefined)?.code !== "ERR_MODULE_NOT_FOUND") return null;
	const message = err instanceof Error ? err.message : String(err);
	let outputDir: string;
	try {
		outputDir = join(resolvePackageRoot(), "dist");
	} catch {
		return null;
	}
	const missing = missingModulePath(message);
	if (!missing) return null;
	const fromOutput = relative(outputDir, missing);
	if (fromOutput === "" || fromOutput.startsWith("..") || isAbsolute(fromOutput)) return null;
	return [
		`${message}`,
		"",
		"This Clio Coder installation is incomplete: the command's own module is missing from",
		`${outputDir}`,
		"Reinstall to restore it, using the line that matches how you installed:",
		"  npm install -g @iowarp/clio-coder    # npm install",
		"  npm run install:local                # source checkout",
	].join("\n");
}
