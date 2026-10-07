import { existsSync, readFileSync } from "node:fs";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { settingsPath, withSettingsLock } from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { authStoragePath, FileAuthStorageBackend } from "../../providers/auth/index.js";
import type { Migration, MigrationReport } from "./index.js";

const migration: Migration = {
	id: "2026-10-07-claude-subscription",
	async up(): Promise<MigrationReport> {
		const report: MigrationReport = { changed: [], attention: [] };
		let movedSubscription = false;
		const credentials = authStoragePath();
		if (existsSync(credentials)) {
			new FileAuthStorageBackend(credentials).withLock((current) => {
				const document = parseDocument(current ?? "");
				if (document.errors.length > 0) throw new Error("Claude subscription migration: credentials could not be parsed");
				const entries = document.get("entries");
				if (!isMap(entries)) return { result: undefined };
				const previous = entries.get("anthropic");
				if (!previous) {
					const subscription = entries.get("anthropic-max");
					// Resume a migration interrupted after the credential rename committed.
					movedSubscription = isMap(subscription) && subscription.get("type") === "oauth";
					return { result: undefined };
				}
				if (!isMap(previous) || previous.get("type") !== "oauth") return { result: undefined };
				if (entries.has("anthropic-max")) {
					report.attention.push(
						"An older Anthropic OAuth login remains under 'anthropic' because 'anthropic-max' already exists. Review the two logins; neither was overwritten.",
					);
					return { result: undefined };
				}
				const entry = entries.items.find((item) => isScalar(item.key) && item.key.value === "anthropic");
				if (!entry || !isScalar(entry.key)) throw new Error("Claude subscription migration: invalid credential key");
				entry.key.value = "anthropic-max";
				movedSubscription = true;
				report.changed.push("Moved the Claude subscription login to 'anthropic-max'; Anthropic API keys use 'anthropic'.");
				return { result: undefined, next: document.toString() };
			});
		}
		if (!movedSubscription) return report;
		return withSettingsLock(() => {
			const file = settingsPath();
			if (!existsSync(file)) return report;
			const document = parseDocument(readFileSync(file, "utf8"));
			if (document.errors.length > 0) throw new Error("Claude subscription migration: settings could not be parsed");
			const targets = document.get("targets");
			let changed = false;
			if (isSeq(targets)) {
				for (const target of targets.items) {
					if (!isMap(target) || target.get("runtime") !== "anthropic-max") continue;
					const auth = target.get("auth");
					if (!isMap(auth) || auth.get("oauthProfile") !== "anthropic") continue;
					auth.set("oauthProfile", "anthropic-max");
					changed = true;
				}
			}
			if (changed) {
				safeResourceWrite(file, document.toString(), { encoding: "utf8", mode: SETTINGS_FILE_MODE });
				report.changed.push("Updated Claude subscription targets to the separate OAuth credential.");
			}
			return report;
		});
	},
};

export default migration;
