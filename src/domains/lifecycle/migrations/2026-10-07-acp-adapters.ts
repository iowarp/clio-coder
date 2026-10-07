import { existsSync, readFileSync } from "node:fs";
import { isMap, isSeq, parseDocument } from "yaml";
import { settingsPath, withSettingsLock } from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration, MigrationReport } from "./index.js";

const REPLACEMENTS: Record<string, { previous: string; current: string }> = {
	codex: {
		previous: "@agentclientprotocol/codex-acp@1.10.0",
		current: "@agentclientprotocol/codex-acp@2.1.1",
	},
	"claude-code": {
		previous: "@agentclientprotocol/claude-agent-acp@0.85.1",
		current: "@agentclientprotocol/claude-agent-acp@0.86.0",
	},
};

const migration: Migration = {
	id: "2026-10-07-acp-adapters",
	async up(): Promise<MigrationReport> {
		return withSettingsLock(() => {
			const report: MigrationReport = { changed: [], attention: [] };
			const file = settingsPath();
			if (!existsSync(file)) return report;
			const document = parseDocument(readFileSync(file, "utf8"));
			if (document.errors.length > 0) throw new Error(`ACP adapter migration: ${document.errors[0]?.message}`);
			const entries = document.getIn(["integrations", "externalAgents", "entries"]);
			if (!isSeq(entries)) return report;
			for (const entry of entries.items) {
				if (!isMap(entry)) continue;
				const id = entry.get("id");
				const replacement = typeof id === "string" ? REPLACEMENTS[id] : undefined;
				const args = entry.get("args");
				// Only replace recipes Clio previously offered unchanged. Operator
				// launch overrides and all other version pins remain their choice.
				if (
					!replacement ||
					entry.get("command") !== "npx" ||
					entry.has("cwd") ||
					entry.has("env") ||
					!isSeq(args) ||
					args.items.length !== 2 ||
					args.toJSON()[0] !== "-y" ||
					args.toJSON()[1] !== replacement.previous
				)
					continue;
				entry.set("args", document.createNode(["-y", replacement.current]));
				report.changed.push(`${id}: ${replacement.previous} → ${replacement.current}`);
			}
			if (report.changed.length > 0)
				safeResourceWrite(file, document.toString(), { encoding: "utf8", mode: SETTINGS_FILE_MODE });
			return report;
		});
	},
};

export default migration;
