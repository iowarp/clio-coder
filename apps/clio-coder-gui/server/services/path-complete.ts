import type { Dirent } from "node:fs";
import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { PathCompletion } from "../../contracts/sessions.js";

/**
 * Where the server runs decides which typed paths mean something. A WSL host also understands the
 * Windows spellings a person copies out of Explorer, because those folders are reachable under the
 * drive mounts and the distro's own UNC share.
 */
export interface PathHost {
	platform: NodeJS.Platform;
	home: string;
	/** Set only inside WSL. `distro` is null when WSL is detected but the distro name is unknown. */
	wsl: { distro: string | null; mountRoot: string } | null;
}

export const PATH_MATCH_LIMIT = 50;

export function detectPathHost(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	osrelease: () => string = () => readFileSync("/proc/sys/kernel/osrelease", "utf8"),
): PathHost {
	let wsl = false;
	if (platform === "linux") {
		if (env.WSL_DISTRO_NAME) wsl = true;
		else {
			try {
				wsl = /microsoft/i.test(osrelease());
			} catch {
				// No procfs entry means no WSL kernel; plain Linux semantics are the safe reading.
			}
		}
	}
	// The drive mount root is configurable in /etc/wsl.conf ([automount] root); /mnt is the default.
	return {
		platform,
		home: homedir(),
		wsl: wsl ? { distro: env.WSL_DISTRO_NAME || null, mountRoot: "/mnt" } : null,
	};
}

type Style = "posix" | "windows";
export interface ParsedPathInput {
	/** Text the user typed up to and including the last separator; matches are rendered after it. */
	parentDisplay: string;
	/** Server path of that parent, or null when the input cannot name a directory on this host. */
	parentPath: string | null;
	/** Server path of the whole input, used to report whether it is itself a directory. */
	inputPath: string | null;
	partial: string;
	separator: "/" | "\\";
	caseInsensitive: boolean;
	style: Style;
}

const DRIVE = /^([A-Za-z]):(?:[\\/]|$)/;
const WSL_UNC = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;

/** Maps one typed path to the path this server opens. Pure: no file system access. */
export function toServerPath(text: string, host: PathHost): string | null {
	if (text.length === 0) return null;
	if (host.platform === "win32") {
		if (text === "~" || text.startsWith("~/") || text.startsWith("~\\"))
			return win32.resolve(host.home, text.slice(2) || ".");
		if (DRIVE.test(text)) return win32.resolve(text.length === 2 ? `${text}\\` : text);
		if (/^[\\/]{2}(?![?.][\\/])[^\\/]+[\\/][^\\/]+/.test(text)) return win32.resolve(text);
		return null;
	}
	if (text === "~" || text.startsWith("~/")) return posix.resolve(host.home, text.slice(2) || ".");
	if (text.startsWith("/") && !text.startsWith("//")) return posix.resolve(text);
	if (!host.wsl) return text.startsWith("/") ? posix.resolve(text) : null;
	const drive = DRIVE.exec(text);
	if (drive?.[1])
		return posix.resolve(
			host.wsl.mountRoot,
			drive[1].toLowerCase(),
			text.slice(2).replaceAll("\\", "/").replace(/^\/+/, ""),
		);
	const unc = WSL_UNC.exec(text);
	if (unc) {
		// Another distro's files are not this server's files; only the running distro maps to "/".
		if (!host.wsl.distro || unc[2]?.toLowerCase() !== host.wsl.distro.toLowerCase()) return null;
		return posix.resolve("/", (unc[3] ?? "").replaceAll("\\", "/"));
	}
	if (text.startsWith("//")) return posix.resolve(text);
	return null;
}

/** Splits the input into its parent directory and the partial last segment. Pure. */
export function parsePathInput(rawInput: string, host: PathHost): ParsedPathInput {
	let input = rawInput;
	const windowsHost = host.platform === "win32";
	const windowsSpelling = windowsHost || (host.wsl !== null && (DRIVE.test(input) || WSL_UNC.test(input)));
	const style: Style = windowsSpelling ? "windows" : "posix";
	// A bare `~`, `C:` or distro share names a directory; complete inside it as a shell would.
	if (input === "~") input = windowsHost ? "~\\" : "~/";
	if (windowsSpelling && /^[A-Za-z]:$/.test(input)) input = `${input}\\`;
	if (windowsSpelling && WSL_UNC.test(input) && !/[\\/]$/.test(input) && WSL_UNC.exec(input)?.[3] === undefined)
		input = `${input}\\`;
	const separator: "/" | "\\" = style === "posix" ? "/" : input.includes("\\") || !input.includes("/") ? "\\" : "/";
	// On a POSIX file system a backslash is an ordinary file name character, never a separator.
	const cut = style === "posix" ? input.lastIndexOf("/") : Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
	const parentDisplay = cut < 0 ? "" : input.slice(0, cut + 1);
	const partial = cut < 0 ? input : input.slice(cut + 1);
	const parentPath = parentDisplay ? toServerPath(parentDisplay, host) : null;
	const inputPath = toServerPath(input, host);
	const mountRoot = host.wsl?.mountRoot;
	const onWindowsDrive =
		windowsHost ||
		style === "windows" ||
		(mountRoot !== undefined && parentPath !== null && new RegExp(`^${mountRoot}/[a-z](/|$)`).test(parentPath));
	return { parentDisplay, parentPath, inputPath, partial, separator, caseInsensitive: onWindowsDrive, style };
}

/** Longest shared prefix, compared case-insensitively when the file system is, taking the first name's case. */
export function commonNamePrefix(names: string[], caseInsensitive: boolean) {
	const first = names[0];
	if (first === undefined) return "";
	const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
	let length = first.length;
	for (const name of names.slice(1)) {
		let index = 0;
		while (index < length && index < name.length && fold(first[index] ?? "") === fold(name[index] ?? "")) index++;
		length = index;
	}
	return first.slice(0, length);
}

export interface PathCompleteIo {
	readdir: (path: string) => Promise<Dirent[]>;
	isDirectory: (path: string) => Promise<boolean>;
}
const realIo: PathCompleteIo = {
	readdir: (path) => readdir(path, { withFileTypes: true }),
	isDirectory: async (path) => {
		try {
			return (await stat(path)).isDirectory();
		} catch {
			return false;
		}
	},
};

/**
 * WSL drive mounts resolve any spelling of a name, and realpath keeps the typed one, so `c:/users` and
 * `C:\Users` would become two workspace identities. Each segment takes the name the directory lists.
 */
async function canonicalCase(path: string, io: PathCompleteIo) {
	let current = "/";
	for (const segment of path.split("/").filter(Boolean)) {
		let entries: Dirent[];
		try {
			entries = await io.readdir(current);
		} catch {
			return path;
		}
		const lower = segment.toLowerCase();
		const name =
			entries.find((entry) => entry.name === segment)?.name ??
			entries.find((entry) => entry.name.toLowerCase() === lower)?.name ??
			segment;
		current = posix.join(current, name);
	}
	return current;
}

export async function completePath(
	input: string,
	hidden: boolean,
	host: PathHost,
	io: PathCompleteIo = realIo,
): Promise<PathCompletion> {
	const parsed = parsePathInput(input, host);
	const join = host.platform === "win32" ? win32.join : posix.join;
	const empty: PathCompletion = {
		input,
		resolvedParent: parsed.parentPath,
		matches: [],
		commonPrefix: input,
		isDirectory: parsed.inputPath ? await io.isDirectory(parsed.inputPath) : false,
		separator: parsed.separator,
		truncated: false,
	};
	if (!parsed.parentPath) return empty;
	const parentPath =
		parsed.caseInsensitive && host.platform !== "win32" ? await canonicalCase(parsed.parentPath, io) : parsed.parentPath;
	let entries: Dirent[];
	try {
		entries = await io.readdir(parentPath);
	} catch {
		// A missing or unreadable parent is an ordinary state while typing, not an error.
		return empty;
	}
	const fold = (value: string) => (parsed.caseInsensitive ? value.toLowerCase() : value);
	const prefix = fold(parsed.partial);
	const showHidden = hidden || parsed.partial.startsWith(".") || parsed.partial.startsWith("$");
	// Windows keeps its system folders ($Recycle.Bin, $WinREAgent) out of Explorer; a dot is the POSIX equivalent.
	const concealed = (name: string) => name.startsWith(".") || (parsed.caseInsensitive && name.startsWith("$"));
	const candidates = entries.filter(
		(entry) =>
			(entry.isDirectory() || entry.isSymbolicLink()) &&
			(showHidden || !concealed(entry.name)) &&
			fold(entry.name).startsWith(prefix),
	);
	const names = (
		await Promise.all(
			candidates.map(async (entry) =>
				entry.isDirectory() || (await io.isDirectory(join(parentPath, entry.name))) ? entry.name : null,
			),
		)
	)
		.filter((name): name is string => name !== null && join(parentPath, name).length <= 4096)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : 1));
	const shown = names.slice(0, PATH_MATCH_LIMIT);
	const matches = shown.map((name) => ({
		name,
		path: join(parentPath, name),
		display: `${parsed.parentDisplay}${name}${parsed.separator}`,
	}));
	// Tab inserts the whole match, separator included, when it is the only one, as a shell does.
	const only = names.length === 1 ? matches[0] : undefined;
	const commonPrefix = only
		? only.display
		: names.length > 1
			? `${parsed.parentDisplay}${commonNamePrefix(names, parsed.caseInsensitive)}`
			: input;
	return {
		...empty,
		resolvedParent: parentPath,
		matches,
		commonPrefix: commonPrefix.length >= input.length ? commonPrefix : input,
		truncated: names.length > shown.length,
	};
}
