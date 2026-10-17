import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runningBuildId } from "./build-info.js";
import { resolvePackageRoot } from "./package-root.js";
import { processAlive, processBirthToken, processStartedAtMs } from "./process-identity.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { resolveClioDirs } from "./xdg.js";

function diskBuild(root: string): { id: string; files: string[] } | null {
	try {
		const value = JSON.parse(readFileSync(join(root, "dist/build.json"), "utf8"));
		if (
			typeof value.id !== "string" ||
			!Array.isArray(value.files) ||
			!value.files.every(
				(file: unknown) => typeof file === "string" && !isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
			)
		)
			return null;
		return value;
	} catch {
		return null;
	}
}

/** The currently activated package for a managed version, or the same checkout/package. */
export function activatedPackageRoot(root: string): string {
	const suffix = join("lib", "node_modules", "@iowarp", "clio-coder");
	if (!root.endsWith(`${sep}${suffix}`)) return root;
	const prefix = root.slice(0, -(suffix.length + 1));
	const versions = dirname(prefix);
	try {
		const record = JSON.parse(readFileSync(join(dirname(versions), "install.json"), "utf8"));
		if (
			record.kind === "clio-coder-installer" &&
			typeof record.current === "string" &&
			dirname(record.current) === versions &&
			existsSync(join(record.current, suffix, "package.json"))
		)
			return join(record.current, suffix);
	} catch {
		/* An unreadable record cannot establish another active package. */
	}
	return root;
}

/** Read on every status request, so an already running GUI sees upgrade and rollback activation. */
export function pendingInstalledVersion(root = resolvePackageRoot()): string | null {
	const current = activatedPackageRoot(root);
	if (current === root) return null;
	try {
		const pkg = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

/** An interrupted clean build either loses its completion record or one of the recorded outputs. */
export function missingBuildFiles(root: string): string[] {
	const build = diskBuild(root);
	if (!build) return ["dist/build.json"];
	return build.files.filter((file) => !existsSync(join(root, "dist", file))).map((file) => `dist/${file}`);
}

interface RunningBuild {
	pid: number;
	birth: string | null;
	host: string;
	root: string;
	build: string;
	surface: string;
}

/** Only long-lived Clio processes register; read-only CLI commands never create state. */
export function registerRunningBuild(surface: "gui" | "tui" | "acp" | "run"): void {
	if (!runningBuildId) return;
	const directory = join(resolveClioDirs().state, "running-builds");
	const file = join(directory, `${process.pid}.json`);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const record: RunningBuild = {
			pid: process.pid,
			birth: processBirthToken(),
			host: hostname(),
			root: resolvePackageRoot(),
			build: runningBuildId,
			surface,
		};
		safeResourceWrite(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		process.once("exit", () => {
			try {
				rmSync(file, { force: true });
			} catch {
				/* Reset may already have removed the state directory. */
			}
		});
	} catch {
		// Diagnostics must not prevent an otherwise healthy session from starting.
	}
}

/**
 * The Linux state dir a process resolves from its NUL-separated environment,
 * by the same precedence as resolveClioDirs, so the /proc scan reports only
 * processes of the home being diagnosed and not another home's GUI server.
 */
export function stateDirOfEnviron(environ: string): string {
	const env = new Map<string, string>();
	for (const pair of environ.split("\0")) {
		const at = pair.indexOf("=");
		if (at > 0) env.set(pair.slice(0, at), pair.slice(at + 1));
	}
	const set = (key: string): string | null => {
		const value = env.get(key)?.trim();
		return value ? value : null;
	};
	const specific = set("CLIO_CODER_STATE_DIR");
	if (specific) return specific;
	const home = set("CLIO_CODER_HOME");
	if (home) return join(home, "state");
	return join(env.get("XDG_STATE_HOME") ?? join(env.get("HOME") ?? userInfo().homedir, ".local", "state"), "clio-coder");
}

export function staleRunningBuilds(state = resolveClioDirs().state): RunningBuild[] {
	const directory = join(state, "running-builds");
	const records: RunningBuild[] = [];
	const seen = new Set<number>();
	for (const name of existsSync(directory) ? readdirSync(directory) : []) {
		if (!/^\d+\.json$/.test(name)) continue;
		try {
			const value = JSON.parse(readFileSync(join(directory, name), "utf8")) as RunningBuild;
			if (
				value.host !== hostname() ||
				!Number.isInteger(value.pid) ||
				!processAlive(value.pid) ||
				value.birth !== processBirthToken(value.pid) ||
				typeof value.root !== "string" ||
				!isAbsolute(value.root) ||
				typeof value.build !== "string"
			)
				continue;
			const currentRoot = activatedPackageRoot(value.root);
			const disk = diskBuild(currentRoot);
			seen.add(value.pid);
			if (currentRoot !== value.root || !disk || disk.id !== value.build) records.push(value);
		} catch {
			// A dead process or an incomplete record grants no authority and is ignored.
		}
	}
	// Pre-patch checkout processes have no receipt. Linux exposes their executable arguments and birth time.
	if (process.platform === "linux")
		for (const name of readdirSync("/proc")) {
			const pid = Number(name);
			if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || seen.has(pid)) continue;
			try {
				if (statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
				const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
				const entry = args.find((arg) => /\/dist\/(?:cli\/index|gui\/server)\.js$/.test(arg));
				if (!entry || !isAbsolute(entry)) continue;
				if (resolve(stateDirOfEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"))) !== resolve(state)) continue;
				const root = entry.replace(/\/dist\/(?:cli\/index|gui\/server)\.js$/, "");
				if (
					!existsSync(join(root, ".git")) ||
					JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== "@iowarp/clio-coder"
				)
					continue;
				const started = processStartedAtMs(pid);
				const built = statSync(existsSync(join(root, "dist/build.json")) ? join(root, "dist/build.json") : entry).mtimeMs;
				if (started !== null && built > started + 2000)
					records.push({
						pid,
						birth: processBirthToken(pid),
						host: hostname(),
						root,
						build: "before the last checkout rebuild",
						surface: entry.endsWith("gui/server.js") || args.includes("gui") ? "gui" : "tui",
					});
			} catch {
				// Processes can exit while /proc is being read; inaccessible processes stay outside the report.
			}
		}
	return records;
}
