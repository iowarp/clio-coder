import type { NoticeLevel } from "./command-output.js";

export type CommandNotice = (level: NoticeLevel, text: string) => void;

export function emitCommandNotice(notice: CommandNotice, level: NoticeLevel, command: string, message: string): void {
	notice(level, `[/${command}] ${message}`);
}

export function runCompactWithNotice(
	onCompact: ((instructions: string | undefined) => Promise<void>) | undefined,
	notice: CommandNotice,
	instructions: string | undefined,
): void {
	if (!onCompact) {
		emitCommandNotice(notice, "error", "compact", "compaction not wired; pass onCompact to startInteractive");
		return;
	}
	const task = onCompact(instructions);
	void task.catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		emitCommandNotice(notice, "error", "compact", msg);
	});
}
