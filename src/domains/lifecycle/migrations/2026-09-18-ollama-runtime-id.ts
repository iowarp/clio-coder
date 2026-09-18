import { existsSync } from "node:fs";

import { readSettings, settingsPath, updateSettings } from "../../../core/config.js";
import { authStoragePath } from "../../providers/auth/backend-file.js";
import { openAuthStorage } from "../../providers/auth/index.js";
import type { Migration } from "./index.js";

/**
 * Rewrites targets persisted under the released `ollama-native` runtime id to
 * the canonical `ollama` (#376). Until this runs, the registry still resolves
 * the old id as an alias, so a home that never upgrades keeps booting.
 */
const migration: Migration = {
	id: "2026-09-18-ollama-runtime-id",
	async up(): Promise<void> {
		let keepLegacyCredential = false;
		if (existsSync(settingsPath())) {
			const current = readSettings();
			keepLegacyCredential = current.targets.some((target) => target.auth?.apiKeyRef === "ollama-native");
			if (current.targets.some((target) => target.runtime === "ollama-native")) {
				updateSettings((settings) => {
					for (const target of settings.targets) {
						if (target.runtime === "ollama-native") target.runtime = "ollama";
					}
				});
			}
		}
		if (!existsSync(authStoragePath())) return;
		// A credential stored under the runtime id resolved through that id, so it
		// follows the rename. Skip the store entirely when none exists, as the
		// LM Studio rename does, because touching it takes the credentials lock.
		const storage = openAuthStorage();
		if (!storage.hasStored("ollama-native")) return;
		storage.renameProvider("ollama-native", "ollama", { keepSource: keepLegacyCredential });
	},
};

export default migration;
