import { stripVTControlCharacters } from "node:util";
import type { ContextActivityKind } from "../core/bus-events.js";
import { createContextOperation } from "../core/context-operation.js";
import type { BootstrapProgressEvent } from "../domains/context/index.js";

function plain(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: filenames and provider errors are untrusted terminal text.
	const cleaned = stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return cleaned.replace(/\s+/g, " ").trim();
}

/** stderr remains useful under --json and in redirected unattended jobs. */
export function createContextCliProgress(
	operation: string,
	options: { liveness?: boolean } = {},
): {
	update(event: BootstrapProgressEvent): void;
	stop(): void;
} {
	const started = performance.now();
	let last: BootstrapProgressEvent | undefined;
	let printedAt = 0;
	const print = (event: BootstrapProgressEvent): void => {
		const count = event.total !== undefined && event.current !== undefined ? ` ${event.current}/${event.total}` : "";
		const detail = event.detail ? ` · ${plain(event.detail)}` : "";
		process.stderr.write(
			`context ${operation} · ${event.phase}${count} · ${plain(event.message)}${detail} · ${Math.round((performance.now() - started) / 1000)}s\n`,
		);
		printedAt = performance.now();
	};
	const timer = setInterval(() => {
		if (options.liveness !== false && last && performance.now() - printedAt >= 10_000) print(last);
	}, 10_000);
	timer.unref();
	return {
		update(event) {
			const phaseChanged = event.phase !== last?.phase;
			last = event;
			if (phaseChanged || event.status !== "running" || performance.now() - printedAt >= 2000) print(event);
		},
		stop: () => clearInterval(timer),
	};
}

/** CLI operations have workspace identity but do not create a conversation session. */
export function createContextCliOperation(kind: ContextActivityKind, update?: (event: BootstrapProgressEvent) => void) {
	const operation = createContextOperation(
		{ kind, sessionId: null, cwd: process.cwd(), origin: "operator", reason: "CLI command" },
		(event) => update?.(event),
	);
	operation.start(
		kind === "context-init" ? "scan" : kind === "context-refresh" ? "codewiki" : "state",
		"Preparing project context",
	);
	return operation;
}
