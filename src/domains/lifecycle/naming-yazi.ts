import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveClioDirs } from "../../core/xdg.js";
import { ensureYaziProfile, resetYaziProfile, yaziProfileDir } from "../mux/yazi/profile.js";
import { resolveToolBinary } from "../toolchain/resolve.js";

export interface YaziNamingInspection {
	profileDir: string;
	present: boolean;
	legacyEvents: number;
	legacyEnvironmentNames: number;
}

export interface YaziNamingRegenerationReport extends YaziNamingInspection {
	status: "absent" | "canonical" | "regenerated" | "removed-unresolved" | "regeneration-failed";
	detail: string;
}

export interface YaziNamingOptions {
	cacheDir?: string;
	yaziPath?: string | null;
	yaPath?: string | null;
}

function occurrences(text: string, pattern: RegExp): number {
	return [...text.matchAll(pattern)].length;
}

/** Inspect only the generated keymap below the selected Clio Coder cache root. */
export function inspectYaziNaming(cacheDir: string = resolveClioDirs().cache): YaziNamingInspection {
	const profileDir = yaziProfileDir(cacheDir);
	const present = statSync(profileDir, { throwIfNoEntry: false })?.isDirectory() === true;
	let keymap = "";
	try {
		keymap = readFileSync(join(profileDir, "keymap.toml"), "utf8");
	} catch {
		// Missing or unreadable generated material is handled as disposable cache.
	}
	return {
		profileDir,
		present,
		legacyEvents: occurrences(keymap, /(?<!clio-coder-)clio-pick/gmu),
		legacyEnvironmentNames: occurrences(keymap, /\$CLIO_YAZI_PICK_TOKEN\b/gmu),
	};
}

/**
 * Replace the disposable managed profile from current inputs. Resolution is
 * performed before removal so the report can state why a profile could not be
 * rebuilt, while deletion remains confined to `<cache>/yazi/profile`.
 */
export function regenerateYaziNamingProfile(options: YaziNamingOptions = {}): YaziNamingRegenerationReport {
	const cacheDir = options.cacheDir ?? resolveClioDirs().cache;
	const before = inspectYaziNaming(cacheDir);
	if (!before.present) {
		return { ...before, status: "absent", detail: "managed Yazi profile is absent; next open writes canonical names" };
	}
	if (before.legacyEvents === 0 && before.legacyEnvironmentNames === 0) {
		return { ...before, status: "canonical", detail: "managed Yazi profile already uses canonical names" };
	}
	const yaziPath = options.yaziPath === undefined ? resolveToolBinary("yazi").binaryPath : options.yaziPath;
	const yaPath = options.yaPath === undefined ? resolveToolBinary("ya").binaryPath : options.yaPath;
	resetYaziProfile(before.profileDir);
	if (!yaziPath || !yaPath) {
		return {
			...before,
			status: "removed-unresolved",
			detail: "legacy managed profile removed; Yazi/ya is unresolved, so the next managed open will regenerate it",
		};
	}
	const profile = ensureYaziProfile({ yaziPath, yaPath, profileDir: before.profileDir });
	if (!profile) {
		return {
			...before,
			status: "regeneration-failed",
			detail: "legacy managed profile removed, but current Yazi rejected the regenerated profile",
		};
	}
	return { ...before, status: "regenerated", detail: "managed Yazi profile regenerated with canonical names" };
}
