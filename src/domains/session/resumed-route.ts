import type { ClioSettings } from "../../core/config.js";
import { THINKING_LEVELS, type ThinkingLevel } from "../../core/defaults.js";
import { planResumedRouting, type ResumedRoute, type RoutingPatch } from "../../core/session-routing.js";
import type { SessionContract } from "./contract.js";
import type { SessionEntry } from "./entries.js";

/**
 * The route a session last ran on, read from its own ledger: the header's
 * target and model, then every `modelChange` and `thinkingLevelChange` row in
 * file order, so the newest one wins. File order rather than the active path
 * because the question is which model the session most recently used, and a
 * `/tree` switch does not change that.
 *
 * A `modelChange` row without a target predates the field and names only a
 * runtime, which cannot say which target the model belonged to; it is skipped
 * rather than paired with a guess. Legacy sessions without a thinking row leave
 * that field unset so the caller can use the configured default (AUD-3 finding 2).
 */
export function resumedSessionRoute(
	meta: { target: string | null; model: string | null },
	entries: ReadonlyArray<SessionEntry>,
): ResumedRoute {
	let target = meta.target ?? null;
	let model = meta.model ?? null;
	let thinkingLevel: ThinkingLevel | undefined;
	for (const entry of entries) {
		if (entry.kind === "modelChange") {
			if (typeof entry.target !== "string" || entry.target.length === 0) continue;
			if (typeof entry.modelId !== "string" || entry.modelId.length === 0) continue;
			target = entry.target;
			model = entry.modelId;
			continue;
		}
		if (entry.kind === "thinkingLevelChange") {
			const level = THINKING_LEVELS.find((candidate) => candidate === entry.thinkingLevel);
			if (level !== undefined) thinkingLevel = level;
		}
	}
	return thinkingLevel === undefined ? { target, model } : { target, model, thinkingLevel };
}

/** What restoring a resumed session's route reads and writes; the composition root supplies each. */
export interface ResumedRouteRestorePorts {
	session: Pick<SessionContract, "current" | "readEntries" | "tree" | "appendEntry"> | null;
	/** The live effective settings, re-read after `applyPatch`. */
	currentSettings(): Readonly<ClioSettings>;
	/** The configured thinking level a legacy ledger without a thinking row falls back to. */
	defaultThinkingLevel(): ThinkingLevel;
	/** Apply a session-scoped routing patch to the live route. */
	applyPatch(patch: RoutingPatch): void;
	/** Record the live thinking level on the session ledger. */
	persistThinkingLevel(): void;
}

/**
 * Put the live route back on the one the current, just-resumed session last
 * ran on (planResumedRouting), at session scope: settings.yaml keeps
 * whatever default some session saved, possibly in another project. When
 * the session is going to run on a different route anyway (an explicit CLI
 * flag, a recorded target that is gone), record that route immediately so
 * the next resume keeps the accepted choice (AUD-3 findings 2 and 3).
 * Returns the operator notice, if any; the caller knows where it can go.
 */
export function restoreResumedSessionRoute(
	ports: ResumedRouteRestorePorts,
	pinned?: { route?: boolean; thinking?: boolean },
): string | null {
	const session = ports.session;
	const meta = session?.current();
	if (!session || !meta) return null;
	let recorded: ResumedRoute;
	try {
		recorded = resumedSessionRoute(meta, session.readEntries());
	} catch {
		// An unreadable ledger has no route to offer; the session keeps the
		// current one, which is what resume did before it looked.
		return null;
	}
	const plan = planResumedRouting(recorded, ports.currentSettings(), pinned, ports.defaultThinkingLevel());
	if (plan.patch) ports.applyPatch(plan.patch);
	const settings = ports.currentSettings();
	const effective = settings.chat;
	const parentTurnId = (() => {
		try {
			return session.tree(meta.id).leafId;
		} catch {
			return null;
		}
	})();
	try {
		const runtimeId = effective.target
			? (settings.targets.find((entry) => entry.id === effective.target)?.runtime ?? null)
			: null;
		if (
			effective.target &&
			effective.model &&
			runtimeId &&
			(effective.target !== recorded.target || effective.model !== recorded.model)
		) {
			session.appendEntry({
				kind: "modelChange",
				parentTurnId,
				provider: runtimeId,
				modelId: effective.model,
				target: effective.target,
			});
		}
		ports.persistThinkingLevel();
	} catch {
		// Best effort, like the chat loop's own markers: a lost row only means
		// the next resume restores the older route.
	}
	return plan.notice;
}
