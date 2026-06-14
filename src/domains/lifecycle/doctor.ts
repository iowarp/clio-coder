import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSettings, validateSettingsFile } from "../../core/config.js";
import { initializeClioHome } from "../../core/init.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { fingerprintNativeRuntime } from "../providers/probe/fingerprint.js";
import { repairLegacySettingsFile, type SettingsRepairOutcome } from "./settings-repair.js";
import { readStateInfo } from "./state.js";
import { getVersionInfo } from "./version.js";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorFinding {
	ok: boolean;
	name: string;
	detail: string;
	level?: DoctorLevel;
}

export interface DoctorOptions {
	fix?: boolean;
}

export function runDoctor(options: DoctorOptions = {}): DoctorFinding[] {
	let repair: SettingsRepairOutcome | undefined;
	if (options.fix) {
		initializeClioHome();
		const credentialsPath = join(resolveClioDirs().config, "credentials.yaml");
		if (existsSync(credentialsPath)) {
			chmodSync(credentialsPath, 0o600);
		}
		// Repair legacy keys older Clio versions wrote so an upgraded install
		// boots instead of failing strict validation. Scoped to known
		// removed/renamed keys; a valid file is left untouched.
		repair = repairLegacySettingsFile();
	}
	const findings: DoctorFinding[] = [];
	const version = getVersionInfo();
	findings.push({ ok: true, name: "Clio Coder version", detail: version.clio });
	findings.push({ ok: true, name: "node version", detail: version.node });
	findings.push({ ok: true, name: "platform", detail: version.platform });
	const engineReady = Boolean(version.piAgentCore && version.piAi && version.piTui);
	findings.push({
		ok: engineReady,
		name: "engine runtime",
		detail: engineReady ? "ready" : "missing required packages",
	});

	const dirs = resolveClioDirs();
	const config = dirs.config;
	findings.push({ ok: existsSync(config), name: "config dir", detail: config });

	const data = dirs.data;
	findings.push({ ok: existsSync(data), name: "data dir", detail: data });

	const stateDir = dirs.state;
	findings.push({ ok: existsSync(stateDir), name: "state dir", detail: stateDir });

	const cache = dirs.cache;
	findings.push({ ok: existsSync(cache), name: "cache dir", detail: cache });

	// The settings row runs the same strict schema validation as the loader,
	// so anything readSettings would refuse to start on shows up here with the
	// exact key paths, read-only.
	const settings = join(config, "settings.yaml");
	if (!existsSync(settings)) {
		findings.push({
			ok: false,
			name: "settings.yaml",
			detail: "missing (run `clio doctor --fix` or `clio configure`)",
		});
	} else {
		try {
			accessSync(settings, constants.R_OK);
			const validation = validateSettingsFile();
			if (validation.issues.length === 0) {
				const repaired = repair?.status === "repaired" ? ` (repaired legacy keys: ${repair.transforms.join("; ")})` : "";
				findings.push({ ok: true, name: "settings.yaml", detail: `${settings}${repaired}` });
			} else {
				const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
				// After --fix the legacy keys are gone, so anything left is a typo or
				// an unsupported key the user must remove by hand; without --fix point
				// at the repair that fixes settings written by older Clio versions.
				const hint = options.fix
					? " (remaining keys are unrecognized; remove them by hand)"
					: " (run `clio doctor --fix` to repair settings written by older Clio versions)";
				findings.push({ ok: false, name: "settings.yaml", detail: `invalid: ${detail}${hint}` });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			findings.push({ ok: false, name: "settings.yaml", detail: `unreadable: ${msg}` });
		}
	}

	// Single "credentials" row covers all three states (missing / wrong mode /
	// correct mode / read error) so external assertions can grep one stable
	// row name instead of branching on state.
	const creds = join(config, "credentials.yaml");
	if (!existsSync(creds)) {
		findings.push({ ok: false, name: "credentials", detail: "missing (run `clio doctor --fix`)" });
	} else {
		try {
			accessSync(creds, constants.R_OK);
			const st = statSync(creds);
			const mode = st.mode & 0o777;
			findings.push({
				ok: mode === 0o600,
				name: "credentials",
				detail: mode.toString(8),
			});
		} catch (err) {
			findings.push({ ok: false, name: "credentials", detail: String(err) });
		}
	}

	const state = readStateInfo();
	const stateCurrent = Boolean(state && state.version === version.clio);
	const stateStamp = state
		? `installed ${state.installedAt}${state.upgradedAt ? `, upgraded ${state.upgradedAt}` : ""}`
		: "";
	findings.push({
		ok: stateCurrent,
		name: "state metadata",
		detail: state
			? stateCurrent
				? `${state.version} (${stateStamp})`
				: `stale ${state.version} (${stateStamp}); current ${version.clio} (run \`clio doctor --fix\`)`
			: "missing",
	});

	return findings;
}

export function formatDoctorReport(findings: DoctorFinding[]): string {
	const lines = findings.map((f) => {
		const level = f.level ?? (f.ok ? "ok" : "error");
		const badge = level === "ok" ? "OK" : level === "warn" ? "WARN" : "!! ";
		return `${badge.padEnd(4)} ${f.name.padEnd(22)} ${f.detail}`;
	});
	return lines.join("\n");
}

/**
 * Asynchronous doctor sweep: walks settings.targets and fingerprints any
 * protocol-compatible URL that responds as a known native server (LM Studio,
 * Ollama). Emits a WARN finding so the user knows to switch to the native
 * runtime for proper resident-model lifecycle management. Network-bound and
 * therefore not part of the synchronous `runDoctor()` core; CI calls the core,
 * the CLI optionally invokes this on top.
 */
export async function runDoctorRuntimeChecks(): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	const candidates = settings.targets.filter(
		(entry) => (entry.runtime === "openai-compat" || entry.runtime === "anthropic-compat") && Boolean(entry.url),
	);
	if (candidates.length === 0) return [];
	const results = await Promise.all(
		candidates.map(async (target): Promise<DoctorFinding | null> => {
			const url = target.url;
			if (!url) return null;
			const fingerprint = await fingerprintNativeRuntime(url);
			if (!fingerprint) return null;
			return {
				ok: true,
				level: "warn",
				name: `target ${target.id}`,
				detail: `${fingerprint.displayName} detected at ${url}; run \`clio targets convert ${target.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle`,
			};
		}),
	);
	return results.filter((finding): finding is DoctorFinding => finding !== null);
}
