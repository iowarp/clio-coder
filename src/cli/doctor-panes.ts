import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { readSettings } from "../core/config.js";
import { resolveClioDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { detectMux, MUX_METHOD_MIN_PROTOCOL, resolveSocketCandidates } from "../domains/mux/index.js";
import { describeResolution, findPinnedTool, toolStatus } from "../domains/toolchain/index.js";

/**
 * The panes section of `clio-coder doctor`.
 *
 * Five rows, in the order an operator debugs them: what mode the pane layer
 * resolved to, whether the socket answered, whether the server is new enough
 * for the methods phase 3 uses, where the pane host binary resolves, and
 * whether the journal directory the viewer reads is writable.
 *
 * No row is an error. Panes are optional: an operator who never wanted them has
 * a healthy install without them, and doctor's exit code answers "is this
 * install healthy". The rows that would be errors elsewhere are warnings that
 * name the next step instead.
 */

const PANE_HOST_TOOL_ID = "herdr";

/** Highest protocol any method Clio drives requires, for the version row. */
const REQUIRED_PROTOCOL = Math.max(...Object.values(MUX_METHOD_MIN_PROTOCOL));

function journalWritabilityFinding(root = join(resolveClioDirs().state, "runs")): DoctorFinding {
	try {
		accessSync(root, constants.W_OK);
		return { ok: true, name: "panes journal dir", detail: `${root} is writable` };
	} catch (error) {
		return {
			ok: true,
			level: "warn",
			name: "panes journal dir",
			detail: `${root} is absent or not writable (${error instanceof Error ? error.message : String(error)}); \`clio-coder fleet view\` will have no transcript to follow`,
		};
	}
}

export async function panesFindings(env: NodeJS.ProcessEnv = process.env): Promise<DoctorFinding[]> {
	let enabled: "auto" | "embedded" | "off" = "off";
	try {
		enabled = readSettings().interface.panes.enabled;
	} catch {
		// An unreadable settings file is already reported by the settings row;
		// this section answers on the shipped default (off) rather than throwing.
	}

	// Inactive by choice is a different answer from unavailable. With the
	// setting off, detection is skipped the same way the boot skips it, and the
	// row names the two ways to turn the extension on instead of warning about
	// a socket nobody asked for.
	if (enabled === "off") {
		return [
			{
				ok: true,
				name: "panes mode",
				detail:
					"off by choice (panes.enabled=off); start `clio-coder --with-panes` for one session, or set panes.enabled=auto",
			},
			journalWritabilityFinding(),
		];
	}

	// Detection is the same ladder the interactive boot runs, so this row is the
	// answer that boot would get. It opens a socket and nothing else: no file is
	// created and no pane is touched.
	const { detection, client } = await detectMux({ enabled, env });
	await client?.close().catch(() => undefined);

	const candidates = detection.candidates.length > 0 ? detection.candidates : resolveSocketCandidates(env);
	const findings: DoctorFinding[] = [
		{
			ok: true,
			level: detection.mode === "none" ? "warn" : "ok",
			name: "panes mode",
			detail: `${detection.mode} (panes.enabled=${enabled}); ${detection.reason}`,
		},
		{
			ok: true,
			level: detection.socketPath === null ? "warn" : "ok",
			name: "panes socket",
			detail:
				detection.socketPath === null
					? `no socket answered; tried ${candidates.length > 0 ? candidates.join(", ") : "no candidates"}`
					: `${detection.socketPath} answered a ping`,
		},
	];

	const server = detection.server;
	findings.push({
		ok: true,
		level: server === null || server.protocol < REQUIRED_PROTOCOL ? "warn" : "ok",
		name: "panes protocol",
		detail:
			server === null
				? `unknown; Clio's optional methods need protocol ${REQUIRED_PROTOCOL} or newer`
				: `server ${server.version}, protocol ${server.protocol}; Clio's optional methods need ${REQUIRED_PROTOCOL} (${server.protocol >= REQUIRED_PROTOCOL ? "satisfied" : "toasts and agent focus fall back"})`,
	});

	const entry = findPinnedTool(PANE_HOST_TOOL_ID);
	findings.push(
		entry === null
			? {
					ok: true,
					level: "warn",
					name: "panes binary",
					detail: `${PANE_HOST_TOOL_ID} is not in the pinned tool registry`,
				}
			: {
					ok: true,
					level: toolStatus(entry).resolution.source === "none" ? "warn" : "ok",
					name: "panes binary",
					detail: describeResolution(toolStatus(entry)),
				},
	);

	findings.push(journalWritabilityFinding());
	return findings;
}
