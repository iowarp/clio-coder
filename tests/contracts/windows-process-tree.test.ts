import { deepStrictEqual, equal } from "node:assert/strict";
import { ChildProcess, type spawn } from "node:child_process";
import { it } from "node:test";
import { createProcessTreeTerminator } from "../../src/engine/external-subprocess.js";

it("cancels Windows trees without a shell and escalates once after the grace period", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const launches: unknown[][] = [];
	const signals: unknown[] = [];
	const runner = ((...args: unknown[]) => {
		launches.push(args);
		return new ChildProcess();
	}) as typeof spawn;
	const terminator = createProcessTreeTerminator(
		{
			pid: 2_147_483_647,
			exitCode: null,
			kill: (signal) => {
				signals.push(signal);
				return true;
			},
		},
		25,
		{ platform: "win32", spawn: runner },
	);
	terminator.terminate();
	terminator.terminate();
	deepStrictEqual(launches, [["taskkill.exe", ["/PID", "2147483647", "/T"], { stdio: "ignore", windowsHide: true }]]);
	t.mock.timers.tick(24);
	equal(launches.length, 1);
	t.mock.timers.tick(1);
	deepStrictEqual(launches[1], [
		"taskkill.exe",
		["/PID", "2147483647", "/T", "/F"],
		{ stdio: "ignore", windowsHide: true },
	]);
	terminator.cleanup();
	t.mock.timers.tick(100);
	equal(launches.length, 2);
	deepStrictEqual(signals, []);
});

it("falls back to the direct child when taskkill cannot start and cleanup forces pending cancellation", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const killers: ChildProcess[] = [];
	const signals: unknown[] = [];
	const runner = (() => {
		const child = new ChildProcess();
		killers.push(child);
		return child;
	}) as typeof spawn;
	const terminator = createProcessTreeTerminator(
		{
			pid: 2_147_483_647,
			exitCode: null,
			kill: (signal) => {
				signals.push(signal);
				return true;
			},
		},
		25,
		{ platform: "win32", spawn: runner },
	);
	terminator.terminate();
	killers[0]?.emit("error", new Error("taskkill missing"));
	terminator.cleanup();
	killers[1]?.emit("error", new Error("taskkill missing"));
	deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
	t.mock.timers.tick(100);
	equal(killers.length, 2);
});

it("never launches taskkill on POSIX or for a missing Windows pid", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const platform of ["linux", "win32"] as const) {
		const signals: unknown[] = [];
		const terminator = createProcessTreeTerminator(
			{
				exitCode: null,
				kill: (signal) => {
					signals.push(signal);
					return true;
				},
			},
			25,
			{
				platform,
				spawn: (() => {
					throw new Error("unexpected taskkill");
				}) as typeof spawn,
			},
		);
		terminator.terminate();
		t.mock.timers.tick(25);
		terminator.cleanup();
		deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
	}
});
