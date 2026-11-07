import { tmpdir } from "node:os";
import { runCommandVector } from "../core/safe-exec.js";
import { resolveOnPath } from "../domains/interop/detect.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	describeYaziProfile,
	ensureYaziProfile,
	inspectCurrentYaziProfile,
	userYaziConfigDir,
	yaziProfileDir,
} from "../domains/mux/index.js";
import {
	describeResolution,
	resolveToolBinary,
	resolveVendoredBinary,
	type ToolStatus,
	toolStatuses,
} from "../domains/toolchain/index.js";
import { popplerInstallHint } from "../tools/read-documents/pdf.js";

export interface ToolchainFindingOptions {
	filesEnabled?: boolean;
	fix?: boolean;
}

function yaziProfileFinding(enabled: boolean, fix: boolean): DoctorFinding {
	if (!enabled) {
		return {
			ok: true,
			name: "files pane profile",
			detail: "disabled by settings",
		};
	}
	try {
		let profile = inspectCurrentYaziProfile();
		if (fix && profile.state !== "current") {
			const yazi = resolveToolBinary("yazi").binaryPath;
			const ya = resolveToolBinary("ya").binaryPath;
			if (yazi && ya) {
				if (!ensureYaziProfile({ yaziPath: yazi, yaPath: ya })) {
					return {
						ok: true,
						name: "files pane profile",
						level: "warn",
						detail: "managed profile regeneration failed Yazi validation",
					};
				}
				profile = inspectCurrentYaziProfile();
			}
		}
		return {
			ok: true,
			name: "files pane profile",
			detail: describeYaziProfile(profile),
			level: profile.state === "current" ? "ok" : profile.state === "missing" ? "info" : "warn",
		};
	} catch (error) {
		return {
			ok: true,
			name: "files pane profile",
			level: "warn",
			detail: `${yaziProfileDir()} could not be inspected (${error instanceof Error ? error.message : String(error)}); user config ${userYaziConfigDir()} is separate and untouched`,
		};
	}
}

/**
 * One row per pinned external tool: where it resolves, and how the version
 * found compares to the pin.
 *
 * No row is ever an error. herdr hosts Clio's panes and always runs from
 * Clio's own pinned copy, never one on PATH, so its row describes that copy and
 * a missing one is a WARN that the next launch repairs. Every other tool is
 * optional: a missing one is a WARN with the command that installs it only
 * while an enabled integration needs it; otherwise it is INFO. A fresh home used to show a
 * missing croc, which nothing uses yet, as its one warning, above a missing
 * chat target that doctor did not mention at all.
 *
 * A PATH copy Clio rejected for being below the registry floor is never
 * reported as an absent one. The row says which binary was found, what version
 * it reported, and which floor it missed, and adds the install command only
 * when there is no vendored copy already answering for the tool. Doctor is the
 * surface an operator reaches for when a tool they installed themselves is not
 * being used, and a row that only said "not found" would send them looking for
 * a binary that is right there on their PATH.
 */
export function toolchainFindings(options: ToolchainFindingOptions = {}): DoctorFinding[] {
	const filesEnabled = options.filesEnabled ?? true;
	const tools = toolStatuses().map((status) =>
		status.id === "herdr"
			? paneHostFinding(status)
			: {
					ok: true,
					name: `external tool ${status.id}`,
					// Active integrations share the tools-status resolution sentence. Disabled
					// experimental integrations stay neutral and do not advertise setup work.
					detail:
						status.id === "yazi" && !filesEnabled
							? "experimental integration disabled by settings"
							: describeResolution(status),
					level:
						status.id === "yazi" && !filesEnabled
							? ("ok" as const)
							: status.resolution.source === "none"
								? status.id === "yazi"
									? ("warn" as const)
									: ("info" as const)
								: ("ok" as const),
				},
	);
	return [...tools, yaziProfileFinding(filesEnabled, options.fix === true)];
}

/**
 * The pinned herdr the launcher runs (`vendoredHerdr` in workspace-launch.ts),
 * never a herdr on PATH. Shared by the toolchain row and doctor's
 * `panes binary` row, so the two cannot disagree about which binary hosts the panes.
 */
export function paneHostFinding(status: ToolStatus, name = "external tool herdr"): DoctorFinding {
	const vendored = resolveVendoredBinary("herdr");
	if (vendored !== null) {
		return {
			ok: true,
			name,
			level: "ok",
			detail: `pane host ${vendored.version} (Clio's pinned copy) at ${vendored.binaryPath}`,
		};
	}
	if (!status.supported) {
		return { ok: true, name, level: "info", detail: "no pinned pane host for this platform; Clio runs without panes" };
	}
	return {
		ok: true,
		name,
		level: "warn",
		detail: `pane host ${status.version} is not installed; the next \`clio-coder\` installs it, or run \`clio-coder panes install\``,
	};
}

/**
 * Whether `@`-attached PDFs and `read` on a PDF can extract text: poppler's
 * pdftotext and pdfinfo on PATH, with pdftotext answering `-v` (it reads
 * `--version` as a file name). PDFs are optional input, so a missing poppler
 * is INFO with the command that installs it, never a warning (#438).
 */
export async function pdfAttachmentFinding(timeoutMs = 2_000): Promise<DoctorFinding> {
	const name = "pdf attachments";
	const pdftotext = resolveOnPath(["pdftotext"]).binary;
	const pdfinfo = resolveOnPath(["pdfinfo"]).binary;
	const missing = [...(pdftotext ? [] : ["pdftotext"]), ...(pdfinfo ? [] : ["pdfinfo"])];
	const hint = `@-attached PDFs and read on a PDF need poppler (${popplerInstallHint()})`;
	if (pdftotext === undefined || pdfinfo === undefined)
		return { ok: true, name, level: "info", detail: `${missing.join(" and ")} not on PATH; ${hint}` };
	// A scratch cwd, as the HPC version probes use.
	const cwd = tmpdir();
	const probe = await runCommandVector(pdftotext, ["-v"], { cwd, workspaceRoot: cwd, timeoutMs, maxOutputBytes: 4096 });
	const version = `${probe.stdout}\n${probe.stderr}`
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find((line) => /\d+\.\d+/u.test(line));
	if (version === undefined)
		return {
			ok: true,
			name,
			level: "info",
			detail: `${pdftotext} -v printed no version (${probe.timedOut ? `no answer within ${timeoutMs}ms` : `exit ${probe.exitCode ?? "on a signal"}`}); ${hint}`,
		};
	return { ok: true, name, level: "ok", detail: `${pdftotext}: ${version}; pdfinfo ${pdfinfo}` };
}
