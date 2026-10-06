/**
 * The operator's remembered answer to "open Clio Coder in a workspace?".
 *
 * It lives in Clio's state directory, never in settings.yaml: the settings file
 * is the operator's own and nothing here writes it. The answer is given once at
 * the first interactive launch and changed afterwards only by
 * `clio-coder panes workspace on|off|ask`, so it is always visible
 * (`panes workspace status`) and always revocable.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export type WorkspaceDecision = "accepted" | "declined";

export interface WorkspaceConsent {
	decision: WorkspaceDecision;
	/** The effective `interface.panes.enabled` value when the operator answered. */
	setting: string;
	decidedAt?: string;
}

const CONSENT_FILE = "workspace-consent.json";

/** The remembered answer, or null when the question was never answered. Creates nothing. */
export async function readWorkspaceConsent(): Promise<WorkspaceConsent | null> {
	const { resolveClioDirs } = await import("../core/xdg.js");
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(resolveClioDirs().state, CONSENT_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (record.decision !== "accepted" && record.decision !== "declined") return null;
		return {
			decision: record.decision,
			setting: typeof record.setting === "string" ? record.setting : "",
			...(typeof record.decidedAt === "string" ? { decidedAt: record.decidedAt } : {}),
		};
	} catch {
		// Absent or unreadable reads as never answered, so the question is asked again rather than guessed.
		return null;
	}
}

async function consentPath(): Promise<string> {
	const { clioStateDir } = await import("../core/xdg.js");
	return join(clioStateDir(), CONSENT_FILE);
}

export async function writeWorkspaceConsent(decision: WorkspaceDecision, setting: string): Promise<void> {
	const { withStateFileLock } = await import("../core/state-file-lock.js");
	const { safeResourceWrite } = await import("../core/safe-resource-write.js");
	const path = await consentPath();
	await withStateFileLock(path, () => {
		safeResourceWrite(
			path,
			`${JSON.stringify({ version: 1, decision, setting, decidedAt: new Date().toISOString() }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	});
}

/** Forget the answer, under the same lock a write takes, so the invitation is offered again. */
export async function clearWorkspaceConsent(): Promise<void> {
	const { withStateFileLock } = await import("../core/state-file-lock.js");
	const path = await consentPath();
	await withStateFileLock(path, () => {
		rmSync(path, { force: true });
	});
}

export type WorkspaceOutcome =
	/** Bare `clio-coder` opens the project's workspace. */
	| { kind: "open"; reason: string }
	/** It stays in the plain terminal and does not ask. */
	| { kind: "plain"; reason: string }
	/** It asks the one-time question first. */
	| { kind: "ask"; reason: string };

/**
 * What the setting and the remembered answer add up to, before the per-run
 * exclusions (`--no-panes`, no terminal, already inside a pane host or tmux,
 * Windows) that always mean the plain terminal.
 *
 * `off` in settings with no remembered answer never asks. `off` in settings and a yes
 * can disagree, and which one is later decides. A
 * yes given while the setting was `embedded` is overruled by the operator
 * turning the setting off afterwards. A yes given while the setting was already
 * `off`, at the invitation or with `panes workspace on`, is the later word and
 * stands until `panes workspace off` revokes it.
 */
export function workspaceOutcome(setting: string, consent: WorkspaceConsent | null): WorkspaceOutcome {
	if (setting === "auto") {
		return {
			kind: "plain",
			reason:
				"interface.panes.enabled is auto: Clio joins a pane host it is started inside and never starts one, whatever is remembered here",
		};
	}
	if (consent === null) {
		// An `off` in the operator's settings is an answer already. The invitation is for homes that never
		// said, which read `embedded` from the default.
		if (setting === "off") {
			return {
				kind: "plain",
				reason:
					"interface.panes.enabled is off, so Clio never invites; `clio-coder panes workspace on` or setting it to embedded turns workspaces on",
			};
		}
		return { kind: "ask", reason: "no answer is remembered, so the next interactive launch asks once" };
	}
	if (consent.decision === "declined") {
		return { kind: "plain", reason: "you declined; `clio-coder panes workspace on` turns workspaces on" };
	}
	if (setting === "off" && consent.setting !== "off") {
		return {
			kind: "plain",
			reason:
				"you accepted while interface.panes.enabled was embedded and it is now off, which is the later choice; `clio-coder panes workspace on` accepts over off",
		};
	}
	return { kind: "open", reason: "you accepted; `clio-coder panes workspace off` revokes it" };
}
