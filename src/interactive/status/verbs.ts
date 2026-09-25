import { ToolNames } from "../../core/tool-names.js";
import { formatCompactMs, GLYPH, spinnerFrame as themeSpinnerFrame } from "../theme/index.js";
import type { AgentStatus } from "./types.js";

export interface VerbRender {
	text: string;
	toneHint: "normal" | "warn" | "ok" | "error" | "muted";
}

export function spinnerFrame(frameIndex: number): string {
	return themeSpinnerFrame(frameIndex);
}

/**
 * Elapsed time in the footer and inline status verbs. Kept as a named export
 * because several call sites reference it, but the body is now a thin delegate
 * to formatCompactMs so status durations share the one duration formatter:
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
		status.phase === "tool_running" && status.toolStartedAt !== undefined ? status.toolStartedAt : status.since;
	return formatLiveElapsed(Math.max(0, now - from));
}

function coreVerb(status: AgentStatus): { text: string; toneHint: VerbRender["toneHint"] } | null {
	const tier = status.watchdogTier;
	switch (status.phase) {
		case "idle":
			return null;
		case "preparing":
			return { text: "Preparing", toneHint: "normal" };
		case "waiting_model":
			return {
				text: tier >= 2 ? "Waiting for model" : status.localRuntime ? "Waiting for local model" : "Waiting for model",
				toneHint: "normal",
			};
		case "thinking":
			return { text: "Thinking", toneHint: "normal" };
		case "writing":
			return { text: status.preparingToolCall ? "Preparing tool call" : "Writing", toneHint: "normal" };
		case "tool_running": {
			const name = status.tool?.toolName ?? "tool";
			if (name === ToolNames.Dispatch) return { text: "Waiting for worker", toneHint: "normal" };
			if (name === ToolNames.AskUser) return { text: "Needs input", toneHint: "normal" };
			return { text: `Running ${name}`, toneHint: "normal" };
		}
		case "tool_blocked":
			return { text: "Needs approval", toneHint: "warn" };
		case "retrying": {
			const retry = status.retry;
			const wait = retry && retry.waitMs > 0 ? ` · ${formatStatusElapsed(retry.waitMs)}` : "";
			return { text: `retrying ${retry?.attempt ?? 0}/${retry?.maxAttempts ?? 0}${wait}`, toneHint: "warn" };
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
		case "ended": {
			const stop = status.summary?.stopReason ?? "stop";
			const elapsed = status.summary ? ` · ${formatStatusElapsed(status.summary.elapsedMs)}` : "";
			if (stop === "cancelled" || stop === "aborted")
				return { text: `${GLYPH.cancelled} cancelled${elapsed}`, toneHint: "muted" };
			if (stop === "error") return { text: `${GLYPH.error} failed${elapsed}`, toneHint: "error" };
			return { text: `${GLYPH.ok} done${elapsed}`, toneHint: "ok" };
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
	const elapsed = elapsedSince(status, now);
	return elapsed === null ? core : { text: `${core.text} · ${elapsed}`, toneHint: core.toneHint };
}
