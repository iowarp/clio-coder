/**
 * Deterministic filesystem call counter for the tool bench.
 *
 * Install before the tool modules load. Each listed function on `node:fs`
 * and `node:fs/promises`, and each listed FileHandle method, is replaced by a
 * wrapper that bumps a counter while counting is on and then calls the
 * original. `syncBuiltinESMExports` pushes the wrappers into the ESM named
 * exports, so `import { stat } from "node:fs/promises"` in the tool code sees
 * them too. The count is calls, not bytes or syscalls: a readFile of 100 MB is
 * one operation, and work Node does inside one call is not counted again.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

export const COUNTED_FS_SYNC = [
	"accessSync",
	"appendFileSync",
	"chmodSync",
	"chownSync",
	"closeSync",
	"copyFileSync",
	"cpSync",
	"existsSync",
	"fchmodSync",
	"fdatasyncSync",
	"fstatSync",
	"fsyncSync",
	"ftruncateSync",
	"futimesSync",
	"linkSync",
	"lstatSync",
	"mkdirSync",
	"mkdtempSync",
	"openSync",
	"opendirSync",
	"readFileSync",
	"readSync",
	"readdirSync",
	"readlinkSync",
	"readvSync",
	"realpathSync",
	"renameSync",
	"rmSync",
	"rmdirSync",
	"statSync",
	"statfsSync",
	"symlinkSync",
	"truncateSync",
	"unlinkSync",
	"utimesSync",
	"writeFileSync",
	"writeSync",
	"writevSync",
] as const;

export const COUNTED_FS_CALLBACK = [
	"access",
	"appendFile",
	"chmod",
	"close",
	"copyFile",
	"cp",
	"createReadStream",
	"createWriteStream",
	"exists",
	"fchmod",
	"fdatasync",
	"fstat",
	"fsync",
	"ftruncate",
	"futimes",
	"link",
	"lstat",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"read",
	"readFile",
	"readdir",
	"readlink",
	"readv",
	"realpath",
	"rename",
	"rm",
	"rmdir",
	"stat",
	"statfs",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"watch",
	"watchFile",
	"write",
	"writeFile",
	"writev",
] as const;

export const COUNTED_FS_PROMISES = [
	"access",
	"appendFile",
	"chmod",
	"copyFile",
	"cp",
	"link",
	"lstat",
	"mkdir",
	"mkdtemp",
	"open",
	"opendir",
	"readFile",
	"readdir",
	"readlink",
	"realpath",
	"rename",
	"rm",
	"rmdir",
	"stat",
	"statfs",
	"symlink",
	"truncate",
	"unlink",
	"utimes",
	"writeFile",
] as const;

export const COUNTED_FILE_HANDLE = [
	"appendFile",
	"chmod",
	"close",
	"datasync",
	"read",
	"readFile",
	"readv",
	"stat",
	"sync",
	"truncate",
	"utimes",
	"write",
	"writeFile",
	"writev",
] as const;

interface CounterState {
	installed: boolean;
	counting: boolean;
	total: number;
	byName: Map<string, number>;
}

const state: CounterState = { installed: false, counting: false, total: 0, byName: new Map() };

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

function wrap(owner: Record<string, unknown>, name: string, label: string): void {
	const original = owner[name];
	if (typeof original !== "function") return;
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		if (state.counting) {
			state.total += 1;
			state.byName.set(label, (state.byName.get(label) ?? 0) + 1);
		}
		return (original as AnyFunction).apply(this, args);
	};
	// Keep attached properties such as realpathSync.native and the promisify
	// custom symbol on exists, so callers that reach for them still work.
	for (const key of Reflect.ownKeys(original)) {
		if (key === "length" || key === "name" || key === "prototype") continue;
		const descriptor = Object.getOwnPropertyDescriptor(original, key);
		if (descriptor !== undefined) Object.defineProperty(wrapped, key, descriptor);
	}
	Object.defineProperty(wrapped, "name", { value: (original as AnyFunction).name });
	owner[name] = wrapped;
}

/** Idempotent. Returns the labels of every function actually wrapped. */
export async function installFsCounters(): Promise<string[]> {
	if (state.installed) return countedLabels();
	const handle = await fs.promises.open(process.execPath, "r");
	const fileHandleProto = Object.getPrototypeOf(handle) as Record<string, unknown>;
	await handle.close();
	const fsRecord = fs as unknown as Record<string, unknown>;
	const promisesRecord = fs.promises as unknown as Record<string, unknown>;
	for (const name of COUNTED_FS_SYNC) wrap(fsRecord, name, `fs.${name}`);
	for (const name of COUNTED_FS_CALLBACK) wrap(fsRecord, name, `fs.${name}`);
	for (const name of COUNTED_FS_PROMISES) wrap(promisesRecord, name, `fs/promises.${name}`);
	for (const name of COUNTED_FILE_HANDLE) wrap(fileHandleProto, name, `FileHandle.${name}`);
	syncBuiltinESMExports();
	state.installed = true;
	return countedLabels();
}

function countedLabels(): string[] {
	return [
		...COUNTED_FS_SYNC.map((name) => `fs.${name}`),
		...COUNTED_FS_CALLBACK.map((name) => `fs.${name}`),
		...COUNTED_FS_PROMISES.map((name) => `fs/promises.${name}`),
		...COUNTED_FILE_HANDLE.map((name) => `FileHandle.${name}`),
	];
}

export function startCounting(): void {
	if (!state.installed) throw new Error("fs counters are not installed");
	state.total = 0;
	state.byName.clear();
	state.counting = true;
}

export function stopCounting(): { total: number; byName: Record<string, number> } {
	state.counting = false;
	const byName = Object.fromEntries([...state.byName.entries()].sort(([left], [right]) => left.localeCompare(right)));
	return { total: state.total, byName };
}
