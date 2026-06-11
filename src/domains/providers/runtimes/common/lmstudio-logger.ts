/**
 * Quiet logger for @lmstudio/sdk clients.
 *
 * The SDK's default logger is `console`, which writes transport diagnostics
 * (WebSocket reconnect errors, channel teardown warnings) straight over the
 * interactive TUI frame. Real failures still reach the operator as thrown
 * errors through Clio's own error rendering, so SDK logging stays silent
 * unless CLIO_DEBUG_LMSTUDIO=1 routes it to stderr for diagnosis.
 */
import type { LoggerInterface } from "@lmstudio/sdk";

function formatMessage(message: unknown): string {
	if (message instanceof Error) return message.stack ?? message.message;
	if (typeof message === "string") return message;
	try {
		return JSON.stringify(message);
	} catch {
		return String(message);
	}
}

function write(level: string, messages: ReadonlyArray<unknown>): void {
	if (process.env.CLIO_DEBUG_LMSTUDIO !== "1") return;
	process.stderr.write(`[clio:lmstudio] ${level} ${messages.map(formatMessage).join(" ")}\n`);
}

export const lmStudioQuietLogger: LoggerInterface = {
	info: (...messages) => write("info", messages),
	error: (...messages) => write("error", messages),
	warn: (...messages) => write("warn", messages),
	debug: (...messages) => write("debug", messages),
};
