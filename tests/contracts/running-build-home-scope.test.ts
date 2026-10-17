/**
 * Doctor's /proc fallback reported every same-user checkout process, so a
 * doctor run in an isolated home warned about the real home's GUI server.
 * The scan now keeps a process only when its environment resolves to the
 * state dir being diagnosed.
 */
import { strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { stateDirOfEnviron } from "../../src/core/running-build.js";

const environ = (pairs: Record<string, string>): string =>
	`${Object.entries(pairs)
		.map(([key, value]) => `${key}=${value}`)
		.join("\0")}\0`;

it("resolves a process's state dir from its environment by Clio's precedence", () => {
	const scratch = "/scratch/isolated";
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real" })), "/home/real/.local/state/clio-coder");
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real", XDG_STATE_HOME: "/xdg/state" })), "/xdg/state/clio-coder");
	strictEqual(stateDirOfEnviron(environ({ HOME: "/home/real", CLIO_CODER_HOME: scratch })), join(scratch, "state"));
	strictEqual(
		stateDirOfEnviron(
			environ({ HOME: "/home/real", CLIO_CODER_HOME: scratch, CLIO_CODER_STATE_DIR: join(scratch, "s") }),
		),
		join(scratch, "s"),
	);
});
