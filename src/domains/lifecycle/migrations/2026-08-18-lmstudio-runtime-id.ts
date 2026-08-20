import { existsSync } from "node:fs";

import { readSettings, settingsPath, updateSettings } from "../../../core/config.js";
import { authStoragePath } from "../../providers/auth/backend-file.js";
import { openAuthStorage } from "../../providers/auth/index.js";
import type { Migration } from "./index.js";

function normalizeLmStudioUrl(url: string | undefined): string | undefined {
	if (!url) return url;
	if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
	if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
	return url;
}

const migration: Migration = {
	id: "2026-08-18-lmstudio-runtime-id",
	async up(): Promise<void> {
		let keepLegacyCredential = false;
		if (existsSync(settingsPath())) {
			const current = readSettings();
			keepLegacyCredential = current.targets.some((target) => target.auth?.apiKeyRef === "lmstudio-native");
			const needsSettingsRewrite = current.targets.some(
				(target) =>
					target.runtime === "lmstudio-native" ||
					((target.runtime === "lmstudio" || target.runtime === "lmstudio-native") &&
						normalizeLmStudioUrl(target.url) !== target.url),
			);
			if (needsSettingsRewrite) {
				updateSettings((settings) => {
					for (const target of settings.targets) {
						if (target.runtime !== "lmstudio-native" && target.runtime !== "lmstudio") continue;
						target.runtime = "lmstudio";
						const url = normalizeLmStudioUrl(target.url);
						if (url !== undefined) target.url = url;
					}
				});
			}
		}
		if (!existsSync(authStoragePath())) return;
		// Only reach for the rename when a legacy credential is actually stored.
		// Most homes this migration runs on never held one, and asking the store
		// to rename nothing is work that can only fail: it takes the credentials
		// lock and, before this guard existed, refused outright on a file the
		// parser could not fully read, which failed every later `clio-coder
		// upgrade` on that machine.
		const storage = openAuthStorage();
		if (!storage.hasStored("lmstudio-native")) return;
		storage.renameProvider("lmstudio-native", "lmstudio", { keepSource: keepLegacyCredential });
	},
};

export default migration;
