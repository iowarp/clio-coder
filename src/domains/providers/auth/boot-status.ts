/** Read-only credential presence check for the pre-TUI target preflight. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { clioConfigDir } from "../../../core/xdg.js";
import { findEngineEnvKeys, getEngineEnvApiKey } from "../../../engine/env-api-keys.js";
import type { TargetDescriptor } from "../types/target-descriptor.js";
import type { RuntimeAuthMetadata } from "./storage.js";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function storedCredentialPresent(providerId: string): boolean {
	const path = join(clioConfigDir(), "credentials.yaml");
	if (!existsSync(path)) return false;
	try {
		const root = record(parseYaml(readFileSync(path, "utf8")));
		const entry = record(record(root?.entries)?.[providerId]);
		if (!entry) return false;
		if (entry.type === "api_key") return typeof entry.key === "string" && entry.key.trim().length > 0;
		if (entry.type === "oauth") {
			return typeof entry.access === "string" && typeof entry.refresh === "string" && typeof entry.expires === "number";
		}
		// Version 1 (and the historical version-less form).
		return typeof entry.key === "string" && entry.key.trim().length > 0;
	} catch {
		return false;
	}
}

function environmentCredentialPresent(providerId: string, explicitEnvVar?: string): boolean {
	if (explicitEnvVar && process.env[explicitEnvVar]?.trim()) return true;
	for (const name of findEngineEnvKeys(providerId) ?? []) {
		if (process.env[name]?.trim()) return true;
	}
	return Boolean(getEngineEnvApiKey(providerId)?.trim());
}

export interface BootAuthStatus {
	providerId: string;
	required: boolean;
	available: boolean;
}

export function bootAuthStatus(target: TargetDescriptor, runtime: RuntimeAuthMetadata): BootAuthStatus {
	const required =
		runtime.auth === "oauth" ||
		(runtime.auth === "api-key" &&
			(Boolean(target.auth?.apiKeyEnvVar || target.auth?.apiKeyRef || target.auth?.oauthProfile) ||
				runtime.tier === "cloud" ||
				Boolean(runtime.credentialsEnvVar)));
	const providerId =
		target.auth?.oauthProfile?.trim() || target.auth?.apiKeyRef?.trim() || runtime.oauthProviderId || runtime.id;
	if (!required) return { providerId, required: false, available: true };
	const explicitEnvVar = target.auth?.apiKeyEnvVar ?? runtime.credentialsEnvVar;
	return {
		providerId,
		required: true,
		available: storedCredentialPresent(providerId) || environmentCredentialPresent(providerId, explicitEnvVar),
	};
}
