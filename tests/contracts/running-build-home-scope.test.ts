/**
 * Doctor's /proc fallback reported every same-user checkout process, so a
 * doctor run in an isolated home warned about the real home's GUI server.
 * The scan now keeps a process only when its environment resolves to the
 * state dir being diagnosed.
 */
import { strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runningBuildIsStale, stateDirOfEnviron } from "../../src/core/running-build.js";

const environ = (pairs: Record<string, string>): string =>
	`${Object.entries(pairs)
		.map(([key, value]) => `${key}=${value}`)
		.join("\0")}\0`;

it("resolves a process's state dir from its environment by Clio's precedence", () => {
	const scratch = "/scratch/isolated";
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real" })), "/home/real/.local/state/clio-coder");
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real", XDG_STATE_HOME: "/xdg/state" })), "/xdg/state/clio-coder");
	strictEqual(
		stateDirOfEnviron(environ({ HOME: "/home/real", XDG_STATE_HOME: "" })),
		"/home/real/.local/state/clio-coder",
	);
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real", CLIO_CODER_HOME: scratch })), join(scratch, "state"));
	strictEqual(
		stateDirOfEnviron(
			environ({ HOME: "/home/real", CLIO_CODER_HOME: scratch, CLIO_CODER_STATE_DIR: join(scratch, "s") }),
		),
		join(scratch, "s"),
	);
});

it("a build replaced on disk reads as stale only when both ids exist and differ", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-stale-build-"));
	try {
		mkdirSync(join(root, "dist"));
		const loaded = "11111111-1111-4111-8111-111111111111";
		const write = (id: string) => writeFileSync(join(root, "dist/build.json"), JSON.stringify({ id, files: [] }));
		write(loaded);
		strictEqual(runningBuildIsStale(root, loaded).stale, false);
		write("22222222-2222-4222-8222-222222222222");
		strictEqual(runningBuildIsStale(root, loaded).stale, true);
		strictEqual(runningBuildIsStale(root, null).stale, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
