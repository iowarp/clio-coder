/**
 * Bootstrap Clio's config/data/cache directories on first install. Creates the
 * full directory tree required by subsequent domains and writes defaults when
 * absent. Idempotent.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_SETTINGS_YAML } from "./defaults.js";
import { readClioVersion } from "./package-root.js";
import { clioCacheDir, clioConfigDir, clioDataDir } from "./xdg.js";

export interface InitReport {
	configDir: string;
	dataDir: string;
	cacheDir: string;
	createdPaths: string[];
	touchedSettings: boolean;
}

const SUBDIRS = ["sessions", "audit", "state", "agents", "prompts", "receipts", "evidence", "evals", "memory"] as const;

export function initializeClioHome(): InitReport {
	const configDir = clioConfigDir();
	const dataDir = clioDataDir();
	const cacheDir = clioCacheDir();

	const created: string[] = [];

	for (const dir of [configDir, dataDir, cacheDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			created.push(dir);
		}
	}

	for (const sub of SUBDIRS) {
		const full = join(dataDir, sub);
		if (!existsSync(full)) {
			mkdirSync(full, { recursive: true });
			created.push(full);
		}
	}

	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, DEFAULT_SETTINGS_YAML, { encoding: "utf8", mode: 0o644 });
		created.push(settingsPath);
		touched = true;
	} else {
		// Sanity check: parse to catch broken edits; leave the file untouched.
		parseYaml(readFileSync(settingsPath, "utf8"));
	}

	const credentialsPath = join(configDir, "credentials.yaml");
	if (!existsSync(credentialsPath)) {
		writeFileSync(
			credentialsPath,
			"# Managed via `clio auth`. Do not edit manually unless you know what you are doing.\n{}\n",
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		chmodSync(credentialsPath, 0o600);
		created.push(credentialsPath);
	}

	const installPath = join(dataDir, "install.json");
	if (!existsSync(installPath)) {
		const payload = {
			version: readClioVersion(),
			installedAt: new Date().toISOString(),
			platform: process.platform,
			nodeVersion: process.version,
		};
		writeFileSync(installPath, JSON.stringify(payload, null, 2), "utf8");
		created.push(installPath);
	}

	return { configDir, dataDir, cacheDir, createdPaths: created, touchedSettings: touched };
}
