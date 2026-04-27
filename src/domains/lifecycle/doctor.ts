import { accessSync, chmodSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readSettings } from "../../core/config.js";
import { initializeClioHome } from "../../core/init.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { fingerprintNativeRuntime } from "../providers/probe/fingerprint.js";
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
	if (options.fix) {
		initializeClioHome();
		const credentialsPath = join(resolveClioDirs().config, "credentials.yaml");
		if (existsSync(credentialsPath)) {
			chmodSync(credentialsPath, 0o600);
		}
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

	const cache = dirs.cache;
	findings.push({ ok: existsSync(cache), name: "cache dir", detail: cache });

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
			const raw = readFileSync(settings, "utf8");
			parseYaml(raw);
			findings.push({ ok: true, name: "settings.yaml", detail: settings });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			findings.push({ ok: false, name: "settings.yaml", detail: `unreadable or invalid: ${msg}` });
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
	findings.push({
		ok: Boolean(state),
		name: "state metadata",
		detail: state ? `${state.version} @ ${state.installedAt}` : "missing",
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
 * Asynchronous doctor sweep: walks settings.endpoints and fingerprints any
 * `openai-compat` URL that responds as a known native server (LM Studio,
 * Ollama). Emits a WARN finding so the user knows to switch to the native
 * runtime for proper resident-model lifecycle management. Network-bound and
 * therefore not part of the synchronous `runDoctor()` core; CI calls the
 * core, the CLI optionally invokes this on top.
 */
export async function runDoctorRuntimeChecks(): Promise<DoctorFinding[]> {
	let settings: ReturnType<typeof readSettings>;
	try {
		settings = readSettings();
	} catch {
		return [];
	}
	const candidates = settings.endpoints.filter((entry) => entry.runtime === "openai-compat" && Boolean(entry.url));
	if (candidates.length === 0) return [];
	const results = await Promise.all(
		candidates.map(async (endpoint): Promise<DoctorFinding | null> => {
			const url = endpoint.url;
			if (!url) return null;
			const fingerprint = await fingerprintNativeRuntime(url);
			if (!fingerprint) return null;
			return {
				ok: true,
				level: "warn",
				name: `target ${endpoint.id}`,
				detail: `${fingerprint.displayName} detected at ${url}; run \`clio targets convert ${endpoint.id} --runtime ${fingerprint.runtimeId}\` for proper resident-model lifecycle`,
			};
		}),
	);
	return results.filter((finding): finding is DoctorFinding => finding !== null);
}
