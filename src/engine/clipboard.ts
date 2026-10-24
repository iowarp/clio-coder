import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The fullscreen TUI's copy path (#437). pi-tui writes a bare OSC 52 sequence
 * and flashes "Copied!" unless the host injects `copySelection`, and many
 * terminals ignore OSC 52, so the flash lied while the system clipboard stayed
 * unchanged. This tries tools whose exit status confirms delivery, in platform
 * order, and reports OSC 52 as unconfirmed when none of them succeeds.
 * The interactive shell and the fullscreen CLI views import it dynamically on
 * the first copy, so it stays off the Stage 0 graph and nothing runs at startup.
 * It lives in src/engine because boundaries rule1 keeps the pi-tui import here.
 */

interface ClipboardTool {
	name: string;
	file: string;
	args: string[];
	timeoutMs: number;
	encode(text: string): Buffer;
	/** Why this tool cannot carry `text`, when it cannot. */
	refuse?(text: string): string | undefined;
}

interface ClipboardPlan {
	tools: ClipboardTool[];
	/** Tool names the platform calls for that are not installed. */
	missing: string[];
	/** Display environment the platform needs and does not have, for the failure flash. */
	missingDisplay?: string;
}

const TOOL_TIMEOUT_MS = 2_000;
// powershell.exe takes about a second to start cold under WSL.
const POWERSHELL_TIMEOUT_MS = 5_000;
const WSL_SYSTEM32 = "/mnt/c/Windows/System32";
const POWERSHELL_SET_CLIPBOARD =
	"[Console]::InputEncoding=(New-Object Text.UTF8Encoding $false); Set-Clipboard -Value ([Console]::In.ReadToEnd())";

let plan: { key: string; value: ClipboardPlan } | undefined;
let copySeq = 0;
let activeChild: ChildProcess | undefined;
let previousCopy: Promise<unknown> = Promise.resolve();

/**
 * True for an executable regular file. stat still throws EACCES or ELOOP for a
 * PATH entry under an untraversable directory, and that entry is skipped.
 */
function isExecutableFile(file: string): boolean {
	try {
		if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function which(name: string, fallbacks: readonly string[] = []): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
	for (const dir of dirs) {
		const file = path.join(dir, name);
		if (isExecutableFile(file)) return file;
	}
	return fallbacks.find(isExecutableFile);
}

/**
 * WSL interop runs Windows executables through a binfmt_misc entry, so it is
 * the signal that clip.exe can run at all. WSL registers it again as
 * WSLInterop-late when systemd-binfmt clears the original. /proc/version is
 * the fallback for a WSL kernel without either entry visible. Environment
 * variables such as WSL_DISTRO_NAME are dropped by sudo, systemd units and
 * env -i while interop keeps working, so none is consulted.
 */
function isWsl(): boolean {
	if (process.platform !== "linux") return false;
	if (existsQuietly("/proc/sys/fs/binfmt_misc/WSLInterop") || existsQuietly("/proc/sys/fs/binfmt_misc/WSLInterop-late"))
		return true;
	try {
		return /microsoft/iu.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

function existsQuietly(file: string): boolean {
	try {
		return statSync(file, { throwIfNoEntry: false }) !== undefined;
	} catch {
		return false;
	}
}

function isSsh(): boolean {
	return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/** `ssh -X` sets DISPLAY=localhost:N, an X server on the operator's own machine. */
function hasForwardedX11(): boolean {
	return process.env.DISPLAY?.startsWith("localhost:") === true;
}

const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");

function resolvePlan(): ClipboardPlan {
	const tools: ClipboardTool[] = [];
	const missing: string[] = [];
	const add = (name: string, found: string | undefined, tool: Omit<ClipboardTool, "name" | "file">): void => {
		if (found === undefined) missing.push(name);
		else tools.push({ name, file: found, ...tool });
	};
	// Over SSH every local tool writes the remote machine's clipboard, which
	// would confirm a copy the operator never receives. Only a forwarded X11
	// display reaches the operator's side.
	if (isSsh()) {
		if (hasForwardedX11()) {
			add("xclip", which("xclip"), { args: ["-selection", "clipboard", "-in"], timeoutMs: TOOL_TIMEOUT_MS, encode: utf8 });
			add("xsel", which("xsel"), { args: ["--clipboard", "--input"], timeoutMs: TOOL_TIMEOUT_MS, encode: utf8 });
		}
		return { tools, missing, missingDisplay: "SSH session, local tools skipped" };
	}
	const wsl = isWsl();
	if (process.platform === "win32" || wsl) {
		// clip.exe reads stdin in the OEM code page, mangles UTF-16 without a BOM
		// for CJK text and keeps a BOM as a literal U+FEFF, so it only takes ASCII.
		// It also rewrites LF to CRLF, so multi-line text goes to powershell.exe,
		// which keeps the bytes.
		add("clip.exe", which("clip.exe", wsl ? [`${WSL_SYSTEM32}/clip.exe`] : []), {
			args: [],
			timeoutMs: TOOL_TIMEOUT_MS,
			encode: utf8,
			refuse: (text) =>
				text.includes("\n") ? "multi-line" : [...text].every((char) => char.charCodeAt(0) < 0x80) ? undefined : "non-ASCII",
		});
		add("powershell.exe", which("powershell.exe", wsl ? [`${WSL_SYSTEM32}/WindowsPowerShell/v1.0/powershell.exe`] : []), {
			args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SET_CLIPBOARD],
			timeoutMs: POWERSHELL_TIMEOUT_MS,
			encode: utf8,
		});
	}
	if (process.platform === "darwin")
		add("pbcopy", which("pbcopy"), { args: [], timeoutMs: TOOL_TIMEOUT_MS, encode: utf8 });
	let missingDisplay: string | undefined;
	if (process.platform !== "darwin" && process.platform !== "win32") {
		if (process.env.WAYLAND_DISPLAY) {
			add("wl-copy", which("wl-copy"), { args: [], timeoutMs: TOOL_TIMEOUT_MS, encode: utf8 });
		}
		if (process.env.DISPLAY) {
			add("xclip", which("xclip"), {
				args: ["-selection", "clipboard", "-in"],
				timeoutMs: TOOL_TIMEOUT_MS,
				encode: utf8,
			});
			add("xsel", which("xsel"), { args: ["--clipboard", "--input"], timeoutMs: TOOL_TIMEOUT_MS, encode: utf8 });
		}
		if (!wsl && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) missingDisplay = "no DISPLAY or WAYLAND_DISPLAY";
	}
	return { tools, missing, ...(missingDisplay === undefined ? {} : { missingDisplay }) };
}

/**
 * Pipe `text` to a tool and resolve undefined on exit 0, else the reason.
 * stdout and stderr are ignored because wl-copy, xclip and xsel fork a
 * daemon that keeps inherited pipes open; the parent's exit is the signal.
 */
function runTool(tool: ClipboardTool, text: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reason: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (activeChild === child) activeChild = undefined;
			resolve(reason);
		};
		const child = spawn(tool.file, tool.args, {
			stdio: ["pipe", "ignore", "ignore"],
			// Windows tools started from a Linux cwd print a UNC path warning.
			...(tool.file.startsWith("/mnt/") ? { cwd: path.dirname(tool.file) } : {}),
			windowsHide: true,
		});
		activeChild = child;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(`${tool.name} timed out`);
		}, tool.timeoutMs);
		child.once("error", (error: NodeJS.ErrnoException) => finish(`${tool.name} ${error.code ?? "failed"}`));
		child.once("exit", (code, signal) =>
			finish(code === 0 ? undefined : `${tool.name} ${code === null ? `killed by ${signal}` : `exit ${code}`}`),
		);
		// A tool that exits or is killed before draining stdin raises EPIPE here;
		// the exit handler already reports that outcome.
		child.stdin.once("error", () => {});
		child.stdin.end(tool.encode(text));
	});
}

async function tryNative(text: string): Promise<string | undefined> {
	// Linux's helper has no setText; it keeps clipboard ownership through the tools above.
	// Loaded here, on darwin and win32 only, so this module has no static value
	// import and stays a leaf seam the CLI views can reach.
	const { getNativeClipboard } = await import("@earendil-works/pi-tui");
	const native = getNativeClipboard();
	if (native?.setText === undefined) return "skip";
	try {
		await native.setText(text);
		return undefined;
	} catch {
		return "native clipboard failed";
	}
}

const SUPERSEDED = "Copy superseded by a newer selection";

function currentPlan(): ClipboardPlan {
	const key = [process.env.PATH, process.env.DISPLAY, process.env.WAYLAND_DISPLAY, isSsh()].join("\0");
	if (plan?.key !== key) plan = { key, value: resolvePlan() };
	return plan.value;
}

async function copyInOrder(
	id: number,
	text: string,
	writeOsc52: (sequence: string) => void,
): Promise<boolean | string> {
	const current = currentPlan();
	const failures: string[] = [];
	if (!isSsh() && (process.platform === "darwin" || process.platform === "win32")) {
		const reason = await tryNative(text);
		if (id !== copySeq) return SUPERSEDED;
		if (reason === undefined) return true;
		if (reason !== "skip") failures.push(reason);
	}
	for (const tool of current.tools) {
		const refused = tool.refuse?.(text);
		if (refused !== undefined) {
			failures.push(`${tool.name} skipped (${refused})`);
			continue;
		}
		const reason = await runTool(tool, text);
		if (id !== copySeq) return SUPERSEDED;
		if (reason === undefined) return true;
		failures.push(reason);
	}
	// A tool may appear or a display come back; resolve again on the next copy.
	plan = undefined;
	writeOsc52(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
	if (current.missing.length > 0) failures.push(`not found: ${current.missing.join(", ")}`);
	if (current.missingDisplay !== undefined) failures.push(current.missingDisplay);
	if (failures.length === 0) failures.push("no clipboard tool");
	// The flash truncates at the terminal width, so the actionable reason leads.
	return `Copy unconfirmed: ${failures.join("; ")}; OSC 52 sent`;
}

/**
 * pi-tui's `copySelection`: true once a backend confirms the copy, otherwise
 * the flash text. OSC 52 still goes out as a last resort, but the flash says
 * it is unconfirmed because no terminal acknowledges it. pi-tui calls this
 * without a catch, so it never rejects. A newer copy kills the older one's
 * tool and runs after it, so a slow older tool cannot overwrite a newer
 * confirmed copy; the older result reports superseded, never success.
 */
export async function copyToSystemClipboard(
	text: string,
	writeOsc52: (sequence: string) => void,
): Promise<boolean | string> {
	const id = ++copySeq;
	activeChild?.kill("SIGKILL");
	const previous = previousCopy;
	const run = (async (): Promise<boolean | string> => {
		await previous.catch(() => {});
		if (id !== copySeq) return SUPERSEDED;
		try {
			return await copyInOrder(id, text, writeOsc52);
		} catch (error) {
			return `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	})();
	previousCopy = run;
	return run;
}
