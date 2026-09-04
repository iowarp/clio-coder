/**
 * An isolated Clio home for the lifecycle command contracts.
 *
 * `reset` and `uninstall` delete whole roots, so their tests must never resolve
 * a real one. Every root is pinned with its own `CLIO_CODER_*_DIR` variable
 * rather than by HOME alone, because `CLIO_CODER_HOME` and the XDG variables
 * inherited from the developer's shell would otherwise still be consulted, and
 * a test that leaks one of those deletes the machine's actual Clio state.
 *
 * The commands write their transcript with `process.stdout.write`, so the
 * capture replaces that for the duration of the call. Both the environment and
 * stdout are restored in a finally, including when the command throws.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LifecycleHome {
	root: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	binDir: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

export interface LifecycleHomeOptions {
	/** Seed the roots with recognizable files. Defaults to true. */
	populate?: boolean;
}

export function createLifecycleHome(prefix: string, options: LifecycleHomeOptions = {}): LifecycleHome {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const stateDir = join(root, ".local", "state", "clio-coder");
	const cacheDir = join(root, ".cache", "clio-coder");
	const binDir = join(root, ".local", "bin");

	if (options.populate ?? true) {
		for (const dir of [configDir, dataDir, stateDir, cacheDir, binDir]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(configDir, "settings.yaml"), "theme: custom-theme\n", "utf8");
		writeFileSync(join(configDir, "credentials.yaml"), "key: test-secret\n", "utf8");
		writeFileSync(join(dataDir, "records.json"), '["memory"]\n', "utf8");
		writeFileSync(join(stateDir, "install.json"), '{"version":"0.4.2"}\n', "utf8");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		writeFileSync(join(cacheDir, "derived.bin"), "0123456789", "utf8");
	}

	return {
		root,
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		binDir,
		env: {
			HOME: root,
			CLIO_CODER_HOME: "",
			CLIO_CODER_CONFIG_DIR: configDir,
			CLIO_CODER_DATA_DIR: dataDir,
			CLIO_CODER_STATE_DIR: stateDir,
			CLIO_CODER_CACHE_DIR: cacheDir,
			CLIO_CODER_BIN_DIR: binDir,
			XDG_CONFIG_HOME: join(root, ".config"),
			XDG_DATA_HOME: join(root, ".local", "share"),
			XDG_STATE_HOME: join(root, ".local", "state"),
			XDG_CACHE_HOME: join(root, ".cache"),
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/**
 * Run one lifecycle command against `home`, returning its exit code and stdout.
 *
 * The environment is restored key by key, never by `process.env = saved`.
 * Assigning a plain object to `process.env` detaches Node's env proxy: the
 * native environment stops tracking later writes, so `os.homedir()` freezes at
 * whatever it read last. Every test that ran after such a restore then resolved
 * the developer's real home instead of the temp one, which is how a shell-rc
 * probe under test came to read the machine's own ~/.bashrc.
 */
export async function runInHome(
	home: LifecycleHome,
	run: () => Promise<number>,
): Promise<{ code: number; stdout: string }> {
	const keys = Object.keys(home.env);
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	const savedWrite = process.stdout.write.bind(process.stdout);
	const savedIsTty = process.stdout.isTTY;
	let stdout = "";

	for (const key of keys) {
		const value = home.env[key];
		if (value === undefined || value === "") delete process.env[key];
		else process.env[key] = value;
	}
	// Non-TTY, so the presenter degrades to plain text and the assertions read
	// the words rather than the rail. NO_COLOR is cleared by the tmp-root
	// harness, so this is the only thing choosing the lane.
	process.stdout.isTTY = false;
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;

	try {
		return { code: await run(), stdout };
	} finally {
		process.stdout.write = savedWrite;
		process.stdout.isTTY = savedIsTty;
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
