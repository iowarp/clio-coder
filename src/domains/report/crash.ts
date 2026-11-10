import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { readClioVersion, resolvePackageRoot } from "../../core/package-root.js";
import { clioStateDir } from "../../core/xdg.js";
import { reportFingerprint } from "./fingerprint.js";

/**
 * A crash the next session can offer to report. Loaded by the Stage 0 fault handler, so it imports only node
 * built-ins and the two core path helpers; the fingerprint module it uses is as small.
 */

export interface CrashFrame {
	fn: string;
	module: string;
}

export interface CrashRecord {
	v: 1;
	at: string;
	clioCoder: string;
	surface: string;
	name: string;
	frames: CrashFrame[];
	/** The error message clipped to 200 characters and stored raw; a draft built from it scrubs it. */
	message: string;
}

export const CRASH_RECORD_LIMIT = 20;
const MESSAGE_LIMIT = 200;
const FRAME_LIMIT = 8;
const CRASH_FILE = /^\d+-\d+\.json$/u;

export function crashesDirectory(stateDir: string): string {
	return join(stateDir, "reports", "crashes");
}

/** The package a `node_modules` path belongs to, scoped names included. */
function packageName(path: string): string | null {
	const parts = path.split("/");
	const at = parts.lastIndexOf("node_modules");
	if (at < 0 || at + 1 >= parts.length) return null;
	const first = parts[at + 1] ?? "";
	if (first.startsWith("@")) return parts[at + 2] ? `${first}/${parts[at + 2]}` : null;
	return first || null;
}

/**
 * The frames of a stack as function name and module. A module inside the package is its package-relative path; a
 * dependency keeps only its package name; `node:` modules stay; anything else reads `external`. No line numbers and
 * no path of the machine's survive.
 */
function crashRecordFrames(stack: string, packageRoot: string, limit = FRAME_LIMIT): CrashFrame[] {
	const frames: CrashFrame[] = [];
	for (const line of stack.split("\n")) {
		const match = /^\s*at (?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/u.exec(line);
		if (!match) continue;
		const fn = (match[1] ?? "<anonymous>").replace(/^async /u, "").trim() || "<anonymous>";
		let location = (match[2] ?? "")
			.replace(/^file:\/\//u, "")
			.split("\\")
			.join("/");
		if (location.startsWith("node:")) location = location.replace(/:\d+(?::\d+)?$/u, "");
		else if (isAbsolute(location) || /^[A-Za-z]:\//u.test(location)) {
			const dependency = packageName(location);
			if (dependency !== null) location = dependency;
			else {
				const rel = relative(packageRoot, location).split("\\").join("/");
				location = rel.startsWith("..") || isAbsolute(rel) ? "external" : rel;
			}
		} else location = "external";
		frames.push({ fn, module: location });
		if (frames.length >= limit) break;
	}
	return frames;
}

function describeError(error: unknown): { name: string; message: string; stack: string } {
	if (error instanceof Error) {
		return { name: error.name || "Error", message: error.message, stack: error.stack ?? "" };
	}
	return { name: typeof error, message: String(error), stack: "" };
}

/**
 * Write `<stateDir>/reports/crashes/<ms>-<pid>.json` at 0600 and keep the newest {@link CRASH_RECORD_LIMIT}.
 * Synchronous, so a fault handler can call it before shutdown, and it never throws: a crash record that cannot be
 * written is not worth a second fault. Returns the file written, or null.
 */
export function writeCrashRecord(
	error: unknown,
	surface: string,
	options: { stateDir?: string; packageRoot?: string; now?: Date } = {},
): string | null {
	try {
		const stateDir = options.stateDir ?? clioStateDir();
		const now = options.now ?? new Date();
		const described = describeError(error);
		let packageRoot = options.packageRoot;
		let version = "0.0.0";
		try {
			packageRoot ??= resolvePackageRoot();
			version = readClioVersion();
		} catch {
			packageRoot ??= "/nonexistent";
		}
		const record: CrashRecord = {
			v: 1,
			at: now.toISOString(),
			clioCoder: version,
			surface,
			name: described.name.slice(0, 80),
			frames: crashRecordFrames(described.stack, packageRoot),
			message: described.message.slice(0, MESSAGE_LIMIT),
		};
		const dir = crashesDirectory(stateDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = join(dir, `${now.getTime()}-${process.pid}.json`);
		writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		pruneCrashRecords(dir);
		return file;
	} catch {
		return null;
	}
}

function pruneCrashRecords(dir: string): void {
	try {
		const files = readdirSync(dir)
			.filter((name) => CRASH_FILE.test(name))
			.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
		for (const name of files.slice(0, Math.max(0, files.length - CRASH_RECORD_LIMIT))) {
			try {
				unlinkSync(join(dir, name));
			} catch {
				// Another process pruned it.
			}
		}
	} catch {
		// Pruning is best effort.
	}
}

function parseCrashRecord(text: string): CrashRecord | null {
	try {
		const value = JSON.parse(text) as Partial<CrashRecord>;
		if (value.v !== 1 || typeof value.at !== "string" || typeof value.name !== "string") return null;
		if (!Array.isArray(value.frames)) return null;
		const frames = value.frames.filter(
			(frame): frame is CrashFrame =>
				typeof frame === "object" && frame !== null && typeof frame.fn === "string" && typeof frame.module === "string",
		);
		return {
			v: 1,
			at: value.at,
			clioCoder: typeof value.clioCoder === "string" ? value.clioCoder : "0.0.0",
			surface: typeof value.surface === "string" ? value.surface : "unknown",
			name: value.name,
			frames,
			message: typeof value.message === "string" ? value.message.slice(0, MESSAGE_LIMIT) : "",
		};
	} catch {
		return null;
	}
}

/** The newest crash written after `sinceMs`, or null. */
export function latestCrashSince(stateDir: string, sinceMs: number): CrashRecord | null {
	let names: string[];
	try {
		names = readdirSync(crashesDirectory(stateDir)).filter((name) => CRASH_FILE.test(name));
	} catch {
		return null;
	}
	const newest = names
		.filter((name) => Number.parseInt(name, 10) > sinceMs)
		.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0];
	if (newest === undefined) return null;
	try {
		return parseCrashRecord(readFileSync(join(crashesDirectory(stateDir), newest), "utf8"));
	} catch {
		return null;
	}
}

/** The dedup key of a crash: its error name and top frames under the minor version. */
export function crashFingerprint(record: CrashRecord): string {
	return reportFingerprint({
		trigger: "crash",
		cause: record.name,
		version: record.clioCoder,
		frames: record.frames.map((frame) => `${frame.fn}@${frame.module}`),
	});
}

/** Where a crash happened in words fit for the offer: the first frame inside the package, else the first. */
export function crashSite(record: CrashRecord): string {
	const inside = record.frames.find((frame) => frame.module !== "external" && !frame.module.startsWith("node:"));
	return (inside ?? record.frames[0])?.module ?? "an unknown module";
}
