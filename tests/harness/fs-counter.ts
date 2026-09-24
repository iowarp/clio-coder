/**
 * Deterministic filesystem call counter.
 *
 * Install before the modules under test load. Each listed function on
 * `node:fs`, `node:fs/promises`, and the FileHandle prototype is replaced by a
 * wrapper that bumps a counter while counting is on and then calls the
 * original. `syncBuiltinESMExports` pushes the wrappers into the ESM named
 * exports, so `import { stat } from "node:fs/promises"` sees them too. The
 * count is calls, not bytes or syscalls: a readFile of 100 MB is one call, and
 * work Node does inside one call is not counted again.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const SYNC = [
	...["access", "appendFile", "chmod", "chown", "close", "copyFile", "cp", "exists", "fchmod", "fdatasync"],
	...["fstat", "fsync", "ftruncate", "futimes", "link", "lstat", "mkdir", "mkdtemp", "open", "opendir"],
	...["readFile", "read", "readdir", "readlink", "readv", "realpath", "rename", "rm", "rmdir", "stat"],
	...["statfs", "symlink", "truncate", "unlink", "utimes", "writeFile", "write", "writev"],
].map((name) => `${name}Sync`);

const CALLBACK = [
	...["access", "appendFile", "chmod", "close", "copyFile", "cp", "createReadStream", "createWriteStream"],
	...["exists", "fchmod", "fdatasync", "fstat", "fsync", "ftruncate", "futimes", "link", "lstat", "mkdir"],
	...["mkdtemp", "open", "opendir", "read", "readFile", "readdir", "readlink", "readv", "realpath", "rename"],
	...["rm", "rmdir", "stat", "statfs", "symlink", "truncate", "unlink", "utimes", "watch", "watchFile"],
	...["write", "writeFile", "writev"],
];

const PROMISES = [
	...["access", "appendFile", "chmod", "copyFile", "cp", "link", "lstat", "mkdir", "mkdtemp", "open"],
	...["opendir", "readFile", "readdir", "readlink", "realpath", "rename", "rm", "rmdir", "stat", "statfs"],
	...["symlink", "truncate", "unlink", "utimes", "writeFile"],
];

const FILE_HANDLE = [
	...["appendFile", "chmod", "close", "datasync", "read", "readFile", "readv", "stat", "sync", "truncate"],
	...["utimes", "write", "writeFile", "writev"],
];

const state = { installed: false, counting: false, byName: new Map<string, number>() };

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;

function wrap(owner: Record<string, unknown>, name: string, label: string): void {
	const original = owner[name];
	if (typeof original !== "function") return;
	const wrapped = function (this: unknown, ...args: unknown[]): unknown {
		if (state.counting) state.byName.set(label, (state.byName.get(label) ?? 0) + 1);
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
	// realpathSync.native and realpath.native are separate functions that the
	// copy above carries over unwrapped. Wrap them under their own label.
	if (typeof (original as { native?: unknown }).native === "function")
		wrap(wrapped as unknown as Record<string, unknown>, "native", `${label}.native`);
}

/** Idempotent. Wraps every listed function once for the life of the process. */
export async function installFsCounters(): Promise<void> {
	if (state.installed) return;
	const handle = await fs.promises.open(process.execPath, "r");
	const fileHandle = Object.getPrototypeOf(handle) as Record<string, unknown>;
	await handle.close();
	for (const name of [...SYNC, ...CALLBACK]) wrap(fs as unknown as Record<string, unknown>, name, `fs.${name}`);
	for (const name of PROMISES) wrap(fs.promises as unknown as Record<string, unknown>, name, `fs/promises.${name}`);
	for (const name of FILE_HANDLE) wrap(fileHandle, name, `FileHandle.${name}`);
	syncBuiltinESMExports();
	state.installed = true;
}

/** Counts the listed fs calls made while `body` runs, by function. */
export async function countFsCalls<T>(
	body: () => Promise<T>,
): Promise<{ value: T; total: number; byName: Record<string, number> }> {
	if (!state.installed) throw new Error("fs counters are not installed");
	state.byName.clear();
	state.counting = true;
	let value: T;
	try {
		value = await body();
	} finally {
		state.counting = false;
	}
	const byName = Object.fromEntries([...state.byName].sort(([left], [right]) => left.localeCompare(right)));
	const total = Object.values(byName).reduce((sum, count) => sum + count, 0);
	return { value, total, byName };
}
