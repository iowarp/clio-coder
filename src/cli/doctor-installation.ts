import { existsSync } from "node:fs";
import { join } from "node:path";
import { missingBuildFiles, staleRunningBuilds } from "../core/running-build.js";
import { runCommandVector } from "../core/safe-exec.js";
import { shellQuote } from "../core/shell-quote.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { inspectInstallation } from "../domains/lifecycle/install-method.js";
import { inspectGuiBackground } from "./gui.js";

export async function installationFindings(fix: boolean): Promise<DoctorFinding[]> {
	const installation = inspectInstallation();
	const rows: DoctorFinding[] = [];
	if (existsSync(join(resolveClioDirs().state, "gui/background"))) {
		try {
			rows.push(...(await inspectGuiBackground(fix)));
		} catch (error) {
			rows.push({
				ok: false,
				name: "GUI background",
				detail: `${error instanceof Error ? error.message : String(error)}; run \`clio-coder gui background status\``,
			});
		}
	}
	// Old release packages have no completion record; source checkouts can always rebuild one.
	if (installation.kind === "source" || existsSync(join(installation.root, "dist/build.json"))) {
		let missing = missingBuildFiles(installation.root);
		const command =
			installation.kind === "source" ? `pnpm --dir ${shellQuote(installation.root)} run build` : "clio-coder upgrade";
		let repair = "";
		let rebuildFailed = false;
		if (fix && missing.length && installation.kind === "source") {
			try {
				const result = await runCommandVector("pnpm", ["run", "build"], {
					cwd: installation.root,
					workspaceRoot: installation.root,
					timeoutMs: 300_000,
					maxOutputBytes: 16_384,
				});
				missing = missingBuildFiles(installation.root);
				rebuildFailed = result.exitCode !== 0;
				repair = rebuildFailed ? "rebuild failed. " : "rebuilt; restart existing Clio sessions. ";
			} catch (error) {
				rebuildFailed = true;
				repair = `rebuild failed: ${error instanceof Error ? error.message : String(error)}. `;
			}
		}
		rows.push({
			ok: missing.length === 0 && !rebuildFailed,
			name: "installation files",
			detail: `${repair}${missing.length ? `missing ${missing.slice(0, 8).join(", ")}` : "build outputs present"}${missing.length || rebuildFailed ? `; run \`${command}\` (\`clio-coder doctor --fix\` rebuilds a checkout)` : ""}`,
		});
	}
	for (const process of staleRunningBuilds()) {
		const command = process.surface === "gui" ? "clio-coder gui background restart --if-idle" : "clio-coder";
		rows.push({
			ok: true,
			level: "warn",
			name: `running ${process.surface} ${process.pid}`,
			detail: `loaded build ${process.build} at ${process.root} is no longer the activated build; finish active work and restart this process; run \`${command}\``,
		});
	}

	return rows;
}
