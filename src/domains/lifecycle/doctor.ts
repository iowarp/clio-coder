import { constants, accessSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { settingsPath } from "../../core/config.js";
import { clioConfigDir, clioDataDir } from "../../core/xdg.js";
import { readInstallInfo } from "./install.js";
import { getVersionInfo } from "./version.js";

export interface DoctorFinding {
	ok: boolean;
	name: string;
	detail: string;
}

export function runDoctor(): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const version = getVersionInfo();
	findings.push({ ok: true, name: "clio version", detail: version.clio });
	findings.push({ ok: true, name: "node version", detail: version.node });
	findings.push({ ok: true, name: "platform", detail: version.platform });
	findings.push({ ok: Boolean(version.piAgentCore), name: "pi-agent-core", detail: version.piAgentCore ?? "missing" });
	findings.push({ ok: Boolean(version.piAi), name: "pi-ai", detail: version.piAi ?? "missing" });
	findings.push({ ok: Boolean(version.piTui), name: "pi-tui", detail: version.piTui ?? "missing" });

	const config = clioConfigDir();
	findings.push({ ok: existsSync(config), name: "config dir", detail: config });

	const data = clioDataDir();
	findings.push({ ok: existsSync(data), name: "data dir", detail: data });

	const settings = settingsPath();
	const settingsOk = existsSync(settings);
	findings.push({
		ok: settingsOk,
		name: "settings.yaml",
		detail: settingsOk ? settings : "missing (run `clio install`)",
	});

	const creds = join(clioConfigDir(), "credentials.yaml");
	if (existsSync(creds)) {
		try {
			accessSync(creds, constants.R_OK);
			const st = statSync(creds);
			const mode = st.mode & 0o777;
			findings.push({
				ok: mode === 0o600,
				name: "credentials mode",
				detail: `${mode.toString(8)}`,
			});
		} catch (err) {
			findings.push({ ok: false, name: "credentials", detail: String(err) });
		}
	}

	const install = readInstallInfo();
	findings.push({
		ok: Boolean(install),
		name: "install metadata",
		detail: install ? `${install.version} @ ${install.installedAt}` : "missing",
	});

	return findings;
}

export function formatDoctorReport(findings: DoctorFinding[]): string {
	const lines = findings.map((f) => {
		const badge = f.ok ? "OK" : "!! ";
		return `${badge} ${f.name.padEnd(22)} ${f.detail}`;
	});
	return lines.join("\n");
}
