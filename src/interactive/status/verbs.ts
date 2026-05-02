import type { AgentStatus } from "./types.js";

export interface VerbRender {
	text: string;
	toneHint: "normal" | "warn" | "ok" | "error" | "muted";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(frameIndex: number): string {
	return SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "⠋";
}

export function formatStatusElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${rest}s`;
}

function elapsedSince(status: AgentStatus, now: number): string {
	return formatStatusElapsed(Math.max(0, now - status.since));
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
			return { text: tier >= 2 && status.localRuntime ? "waiting on model" : "preparing", toneHint: "normal" };
		case "thinking":
			return { text: tier >= 2 ? "still thinking" : "thinking", toneHint: "normal" };
		case "writing":
			return { text: "writing", toneHint: "normal" };
		case "tool_running": {
			const name = status.tool?.toolName ?? "tool";
			return { text: tier >= 2 ? `still running ${name}` : `tool: ${name}`, toneHint: "normal" };
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
			return { text: agent ? `dispatching ${agent}` : "dispatching", toneHint: "normal" };
		}
		case "stuck":
			return { text: "stuck", toneHint: "error" };
		case "ended": {
			const stop = status.summary?.stopReason ?? "stop";
			const elapsed = status.summary ? ` · ${formatStatusElapsed(status.summary.elapsedMs)}` : "";
			if (stop === "cancelled" || stop === "aborted") return { text: `⊘ cancelled${elapsed}`, toneHint: "muted" };
			if (stop === "error") return { text: `✗ failed${elapsed}`, toneHint: "error" };
			return { text: `✓ done${elapsed}`, toneHint: "ok" };
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
