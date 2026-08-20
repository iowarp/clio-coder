import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	getTerminationCoordinator,
	runWithBudget,
	wrapToWidth,
	writeShutdownNotice,
} from "../../src/core/termination.js";

/**
 * Shutdown diagnostics land after the TUI has stopped, on the terminal the TUI
 * just handed back. They must fit the width of that terminal, because a line
 * wider than the frame is what an operator on a 40-column terminal sees as a
 * mangled screen on the way out. Widening the hook budget is not a fix: the
 * budget bounds shutdown so a hung hook cannot hold the terminal hostage.
 */
describe("contracts/termination shutdown notice", () => {
	it("wraps a budget overrun so every line fits a 40-column terminal", () => {
		const text = "[clio:termination] persist[0] exceeded 500ms budget; shutdown continues";
		for (const width of [40, 60, 80]) {
			const lines = wrapToWidth(text, width);
			ok(lines.length >= 1);
			for (const line of lines) ok(line.length <= width, `${JSON.stringify(line)} exceeds ${width}`);
			strictEqual(lines.join(" "), text, "wrapping keeps every word, in order");
		}
	});

	it("splits a single token wider than the terminal instead of overrunning it", () => {
		const long = "x".repeat(95);
		const lines = wrapToWidth(`hook failed: ${long}`, 40);
		for (const line of lines) ok(line.length <= 40, `${JSON.stringify(line)} exceeds 40`);
		strictEqual(lines.join("").replace(/\s/g, ""), `hookfailed:${long}`);
	});

	it("leaves text alone when there is no usable width", () => {
		deepStrictEqual(wrapToWidth("a b c", 0), ["a b c"]);
		deepStrictEqual(wrapToWidth("a b c", Number.NaN), ["a b c"]);
		deepStrictEqual(wrapToWidth("", 40), [""]);
	});

	it("writes the notice to stderr wrapped to the reported column count", () => {
		const stderr = process.stderr as unknown as { columns?: number; write: (chunk: string) => boolean };
		const stdout = process.stdout as unknown as { columns?: number };
		const priorStderrColumns = stderr.columns;
		const priorStdoutColumns = stdout.columns;
		const priorWrite = stderr.write;
		const captured: string[] = [];
		try {
			Object.defineProperty(process.stderr, "columns", { value: 40, configurable: true, writable: true });
			Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true, writable: true });
			stderr.write = (chunk: string): boolean => {
				captured.push(chunk);
				return true;
			};
			writeShutdownNotice("[clio:termination] persist[0] exceeded 500ms budget; shutdown continues");
		} finally {
			stderr.write = priorWrite;
			Object.defineProperty(process.stderr, "columns", { value: priorStderrColumns, configurable: true, writable: true });
			Object.defineProperty(process.stdout, "columns", { value: priorStdoutColumns, configurable: true, writable: true });
		}
		strictEqual(captured.length, 1);
		const lines = captured[0]?.replace(/\n$/, "").split("\n") ?? [];
		ok(lines.length >= 2, "a 70-character notice needs more than one 40-column line");
		for (const line of lines) ok(line.length <= 40, `${JSON.stringify(line)} exceeds 40`);
	});

	it("still reports a hook that blows its budget: the cap fires and the run continues", async () => {
		let resolveHook: (() => void) | undefined;
		const completed = await runWithBudget(
			() =>
				new Promise<void>((resolve) => {
					resolveHook = resolve;
				}),
			5,
		);
		strictEqual(completed, false, "the budget, not the hook, decided the outcome");
		resolveHook?.();
	});
});

/**
 * The signal notice used to be written the instant the signal arrived, which
 * on a TUI session is while the frame is still painting. The terminal teardown
 * is a drain hook, so the coordinator holds the notice until drain has ended
 * and writes it onto the terminal the TUI just handed back.
 *
 * These cases drive the process-wide coordinator through a real shutdown with
 * process.exit stubbed, so they run last in this file and nowhere else.
 */
describe("contracts/termination signal notice ordering", () => {
	it("holds a notice through drain and writes it after the terminal teardown hook", async () => {
		const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
		const priorWrite = stderr.write;
		const priorExit = process.exit;
		const events: string[] = [];
		const coordinator = getTerminationCoordinator();
		coordinator.onDrain(() => {
			events.push("teardown");
		});
		coordinator.onPersist(() => {
			events.push("persist");
		});
		try {
			stderr.write = (chunk: string): boolean => {
				if (chunk.includes("received SIGTERM")) events.push("notice");
				return true;
			};
			process.exit = ((code?: number): never => {
				events.push(`exit:${code}`);
				return undefined as never;
			}) as typeof process.exit;
			coordinator.notice("Clio Coder: received SIGTERM, shutting down...");
			strictEqual(events.length, 0, "the notice is held while the TUI may still be painting");
			await coordinator.shutdown(143);
		} finally {
			stderr.write = priorWrite;
			process.exit = priorExit;
		}
		deepStrictEqual(events, ["teardown", "notice", "persist", "exit:143"]);
	});

	it("writes a notice at once when drain is already over, as for a re-armed SIGINT mid-shutdown", () => {
		const stderr = process.stderr as unknown as { write: (chunk: string) => boolean };
		const priorWrite = stderr.write;
		const captured: string[] = [];
		try {
			stderr.write = (chunk: string): boolean => {
				captured.push(chunk);
				return true;
			};
			getTerminationCoordinator().notice("Clio Coder: received SIGINT, shutting down...");
		} finally {
			stderr.write = priorWrite;
		}
		strictEqual(captured.length, 1);
		ok(captured[0]?.includes("received SIGINT"));
	});
});
