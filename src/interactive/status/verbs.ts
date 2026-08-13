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

function elapsedSince(status: AgentStatus, now: number): string {
	// A running tool times from its own start, not from turn start, so the
	// footer never shows turn-elapsed as tool-elapsed.
	const from =
		status.phase === "tool_running" && status.toolStartedAt !== undefined ? status.toolStartedAt : status.since;
	return formatStatusElapsed(Math.max(0, now - from));
}

function noProgressSince(status: AgentStatus, now: number): string {
	return formatStatusElapsed(Math.max(0, now - status.lastMeaningfulAt));
}

function coreVerb(status: AgentStatus): { text: string; toneHint: VerbRender["toneHint"] } | null {
	const tier = status.watchdogTier;
	switch (status.phase) {
		case "idle":
			return null;
		case "preparing":
			return { text: tier >= 2 ? "still preparing harness" : "preparing harness", toneHint: "normal" };
		case "waiting_model":
			return {
				text: tier >= 2 ? "still waiting on model" : status.localRuntime ? "waiting on local model" : "waiting on model",
				toneHint: "normal",
			};
		case "thinking":
			return { text: tier >= 2 ? "still receiving thinking" : "receiving thinking", toneHint: "normal" };
		case "writing":
			return { text: "streaming response", toneHint: "normal" };
		case "tool_running": {
			const name = status.tool?.toolName ?? "tool";
			if (name === ToolNames.AskUser) return { text: "waiting for user input", toneHint: "normal" };
			return { text: tier >= 2 ? `still running tool: ${name}` : `running tool: ${name}`, toneHint: "normal" };
		}
		case "tool_blocked":
			return { text: "awaiting confirmation", toneHint: "warn" };
		case "retrying": {
			const retry = status.retry;
			const wait = retry && retry.waitMs > 0 ? ` · ${formatStatusElapsed(retry.waitMs)}` : "";
			return { text: `retrying ${retry?.attempt ?? 0}/${retry?.maxAttempts ?? 0}${wait}`, toneHint: "warn" };
		}
		case "compacting":
			return { text: "compacting context", toneHint: "normal" };
		case "dispatching": {
			const agent = status.dispatch?.agentName;
			if (tier >= 2)
				return { text: agent ? `awaiting agent result: ${agent}` : "awaiting agent result", toneHint: "normal" };
			return { text: agent ? `dispatching agent: ${agent}` : "dispatching agent", toneHint: "normal" };
		}
		case "stuck":
			return { text: "stuck", toneHint: "error" };
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
			text: terminalCols < 60 ? "stuck" : `stuck · ${elapsed} · Esc to cancel`,
			toneHint: "error",
		};
	}
	const showElapsed = terminalCols >= 60;
	if (!showElapsed) return core;
	const elapsed = elapsedSince(status, now);
	return { text: `${core.text} · ${elapsed}`, toneHint: core.toneHint };
}

export function resolveInlineVerb(status: AgentStatus, now: number, terminalCols: number): VerbRender | null {
	if (status.phase === "idle" || status.phase === "ended") return null;
	if (status.phase === "stuck") {
		return { text: `Stuck for ${elapsedSince(status, now)}. Press Esc to cancel.`, toneHint: "error" };
	}
	const core = coreVerb(status);
	if (!core) return null;
	const text = core.text.replace(/^[a-z]/, (c) => c.toUpperCase());
	if (status.watchdogTier >= 3) {
		const hint = `(no progress for ${noProgressSince(status, now)}; press Esc to cancel)`;
		return { text: terminalCols < 50 ? text : `${text} ${hint}`, toneHint: core.toneHint };
	}
	if (terminalCols < 50 || status.phase === "tool_blocked") return { text, toneHint: core.toneHint };
	return { text: `${text} · ${elapsedSince(status, now)}`, toneHint: core.toneHint };
}
