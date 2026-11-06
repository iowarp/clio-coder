import type { ModelAdmissionWait } from "../../core/model-admission.js";
import { ToolNames } from "../../core/tool-names.js";
import type { AgentStatus, RetryOverlay } from "../../session-control/status-types.js";
import { formatCompactMs, GLYPH, spinnerFrame as themeSpinnerFrame } from "../theme/index.js";

export interface VerbRender {
	text: string;
	toneHint: "normal" | "warn" | "ok" | "error" | "muted";
}

/** `3rd`, `11th`, `22nd`: how a count of waits reads, since a stated wait has no limit to count against. */
export function ordinal(n: number): string {
	const teens = n % 100 >= 11 && n % 100 <= 13;
	const tail = !teens && n % 10 === 1 ? "st" : !teens && n % 10 === 2 ? "nd" : !teens && n % 10 === 3 ? "rd" : "th";
	return `${n}${tail}`;
}

/**
 * Where a retry stands, as the count that means something. Clio's own retries read against the limit they spend; a
 * wait the provider asked for spends none and no limit applies, so it counts up alone, and the first says nothing.
 */
export function retryCountLabel(retry: RetryOverlay | undefined): string | null {
	if (retry?.onProviderWait === true) {
		const waits = retry.providerWaits ?? 1;
		return waits > 1 ? `${ordinal(waits)} wait` : null;
	}
	return `${(retry?.attempt ?? 0) - (retry?.providerWaits ?? 0)}/${retry?.maxAttempts ?? 0}`;
}

export function spinnerFrame(frameIndex: number): string {
	return themeSpinnerFrame(frameIndex);
}

/**
 * Elapsed time in the footer and inline status verbs. This delegates to
 * formatCompactMs so status durations share the one duration formatter:
 * `4.2s` under ten seconds, `42s`, then `1m5s` with no space and no zero pad
 * (the previous body emitted `1m 5s`).
 */
function formatStatusElapsed(elapsedMs: number): string {
	return formatCompactMs(elapsedMs);
}

/**
 * A counter that keeps running, in whole seconds, and nothing under one
 * second. A live `578ms` or `4.2s` changed on every refresh, so the footer row
 * was rewritten several times a second for a digit nobody reads; a whole
 * second changes once a second and a sub-second wait needs no number at all.
 */
function formatLiveElapsed(elapsedMs: number): string | null {
	if (elapsedMs < 1_000) return null;
	const seconds = Math.floor(elapsedMs / 1_000);
	return seconds < 10 ? `${seconds}s` : formatCompactMs(seconds * 1_000);
}

function elapsedSince(status: AgentStatus, now: number): string | null {
	// A running tool times from its own start, not from turn start, so the
	// footer never shows turn-elapsed as tool-elapsed.
	const from =
		status.phase === "tool_running" && status.toolStartedAt !== undefined
			? status.toolStartedAt
			: status.phase === "waiting_model" && status.waitingSince !== undefined
				? status.waitingSince
				: status.phase === "cancelling" && status.cancelRequestedAt !== undefined
					? status.cancelRequestedAt
					: status.since;
	return formatLiveElapsed(Math.max(0, now - from));
}

const ADMISSION_VERB: Readonly<Record<ModelAdmissionWait["stage"], string>> = {
	lock: "Waiting for another model load",
	unloading: "Unloading model",
	switching: "Switching model",
	loading: "Loading model",
	restoring: "Restoring model",
	ceiling: "Held at cost ceiling",
};

function coreVerb(status: AgentStatus): { text: string; toneHint: VerbRender["toneHint"] } | null {
	const tier = status.watchdogTier;
	switch (status.phase) {
		case "idle":
			return null;
		case "preparing":
			return { text: "Preparing", toneHint: "normal" };
		case "waiting_model":
			if (status.modelRequest?.admission) {
				return { text: ADMISSION_VERB[status.modelRequest.admission.stage], toneHint: "normal" };
			}
			return {
				text: tier >= 2 ? "Waiting for model" : status.localRuntime ? "Waiting for local model" : "Waiting for model",
				toneHint: "normal",
			};
		case "thinking":
			return { text: "Thinking", toneHint: "normal" };
		case "writing":
			return {
				text: status.preparingToolCall
					? "Preparing tool call"
					: status.writingCallAsText
						? "Writing a tool call as text"
						: "Writing",
				toneHint: "normal",
			};
		case "tool_running": {
			const name = status.tool?.toolName ?? "tool";
			if (name === ToolNames.Dispatch) return { text: "Waiting for worker", toneHint: "normal" };
			if (name === ToolNames.AskUser) return { text: "Needs input", toneHint: "normal" };
			if (status.tool?.judging === true) return { text: "Waiting for the safety judge", toneHint: "normal" };
			return { text: `Running ${name}`, toneHint: "normal" };
		}
		case "tool_blocked":
			return { text: "Needs approval", toneHint: "warn" };
		case "retrying": {
			const count = retryCountLabel(status.retry);
			const shown = count === null ? "" : status.retry?.onProviderWait === true ? ` (${count})` : ` ${count}`;
			return { text: `Retrying${shown}`, toneHint: "warn" };
		}
		case "compacting":
			return { text: "Compacting context", toneHint: "normal" };
		case "dispatching": {
			const agent = status.dispatch?.agentName;
			if (tier >= 2)
				return { text: agent ? `awaiting agent result: ${agent}` : "awaiting agent result", toneHint: "normal" };
			return { text: agent ? `dispatching agent: ${agent}` : "dispatching agent", toneHint: "normal" };
		}
		case "stuck":
			return { text: "No output", toneHint: "error" };
		case "cancelling":
			return { text: "Cancelling", toneHint: "muted" };
		case "ended": {
			const stop = status.summary?.stopReason ?? "stop";
			const elapsed = status.summary
				? ` · ${formatStatusElapsed(Math.max(0, status.summary.elapsedMs - (status.summary.humanWaitMs ?? 0)))}`
				: "";
			if (stop === "generation_guard") return { text: `${GLYPH.warn} Generation stopped${elapsed}`, toneHint: "warn" };
			if (stop === "cancelled" || stop === "aborted")
				return { text: `${GLYPH.cancelled} Cancelled${elapsed}`, toneHint: "muted" };
			if (stop === "error") return { text: `${GLYPH.error} Failed${elapsed}`, toneHint: "error" };
			if (stop === "length") return { text: `${GLYPH.warn} Output limit${elapsed}`, toneHint: "warn" };
			if (stop === "no_answer") return { text: `${GLYPH.warn} No answer${elapsed}`, toneHint: "warn" };
			return { text: `${GLYPH.ok} Done${elapsed}`, toneHint: "ok" };
		}
		default:
			return null;
	}
}

export function resolveFooterVerb(status: AgentStatus, now: number, terminalCols: number): VerbRender | null {
	const core = coreVerb(status);
	if (!core) return null;
	if (status.phase === "ended") return core;
	if (status.phase === "tool_blocked") return core;
	if (status.phase === "stuck") {
		const elapsed = elapsedSince(status, now);
		return {
			text: terminalCols < 60 ? "No output" : `No output${elapsed === null ? "" : ` · ${elapsed}`} · Esc to cancel`,
			toneHint: "error",
		};
	}
	const showElapsed = terminalCols >= 60;
	if (!showElapsed) return core;
	// A backoff reads as what is left, and the attempt it leads to as its own time, not the turn's.
	if (status.phase === "retrying") {
		const retry = status.retry;
		if (retry?.dueAt !== undefined) {
			return { ...core, text: `${core.text} · next in ${Math.max(0, Math.ceil((retry.dueAt - now) / 1000))}s` };
		}
		const attempt = retry?.attemptStartedAt !== undefined ? formatLiveElapsed(now - retry.attemptStartedAt) : null;
		return attempt === null ? core : { ...core, text: `${core.text} · ${attempt}` };
	}
	const elapsed = elapsedSince(status, now);
	return elapsed === null ? core : { text: `${core.text} · ${elapsed}`, toneHint: core.toneHint };
}
