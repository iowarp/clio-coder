/**
 * Keeps npm's cache, debug logs and update-notifier stamp out of the operator's
 * real `~/.npm`. A test that makes the verify tool or host verification run
 * `npm run <script>` spawns npm with the safe tool environment, an allowlist
 * that keeps HOME and the XDG directories but drops every `npm_config_*` key, so
 * npm writes `_logs` (rotating, so deleting older operator logs) and
 * `_update-notifier-last-checked` under `$HOME/.npm`. Call once at a test file's
 * top level: each test runs with HOME and XDG_CACHE_HOME inside a scratch
 * directory (and the npm keys set for any path that does pass them), and the
 * previous values come back after it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

const KEYS = [
	"HOME",
	"XDG_CACHE_HOME",
	"npm_config_cache",
	"npm_config_logs_dir",
	"npm_config_update_notifier",
] as const;

export function isolateNpmCache(): void {
	let root: string | undefined;
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "clio-coder-npm-"));
		for (const key of KEYS) saved.set(key, process.env[key]);
		process.env.HOME = join(root, "home");
		process.env.XDG_CACHE_HOME = join(root, "home", ".cache");
		process.env.npm_config_cache = join(root, "cache");
		process.env.npm_config_logs_dir = join(root, "logs");
		process.env.npm_config_update_notifier = "false";
	});
	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) Reflect.deleteProperty(process.env, key);
			else process.env[key] = value;
		}
		saved.clear();
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});
}
