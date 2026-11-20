/**
 * Owner-only access for a secret file on Windows.
 *
 * On win32 chmod(0o600) only clears the read-only attribute: the file keeps the
 * ACL it inherited from its directory, and outside the user profile that grants
 * BUILTIN\Users read and Authenticated Users modify. `applyOwnerOnlyAcl` breaks
 * inheritance and grants only the current account and SYSTEM; `readWindowsAcl`
 * and `extraAclPrincipals` let doctor say who else holds an ACE. Both system
 * tools run by absolute path without a shell, so a PATH entry or a file in the
 * working directory cannot stand in for them. Off win32 nothing runs.
 */
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { win32 } from "node:path";

/** Runs one program with argv and returns its stdout; throws on failure or timeout. */
export type AclExec = (program: string, args: readonly string[]) => string;

/** The platform and process seam; tests inject both, production passes nothing. */
export interface AclHost {
	platform?: NodeJS.Platform;
	exec?: AclExec;
}

export interface WindowsAccount {
	/** `DOMAIN\user` from whoami, or the bare user name when whoami failed. */
	name: string | null;
	sid: string | null;
}

export type WindowsAclRead = { output: string } | { error: string };

const ACL_TIMEOUT_MS = 10_000;
const SYSTEM_SID = "S-1-5-18";
const ALWAYS_ALLOWED = new Set(["nt authority\\system", "builtin\\administrators", "s-1-5-18", "s-1-5-32-544"]);

function systemTool(name: string): string {
	const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
	return win32.join(win32.isAbsolute(root) ? root : "C:\\Windows", "System32", name);
}

function runSystemTool(program: string, args: readonly string[]): string {
	return execFileSync(program, [...args], {
		encoding: "utf8",
		timeout: ACL_TIMEOUT_MS,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function oneLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s*\r?\n\s*/gu, " ").trim();
}

/** The account this process runs as, preferring the SID whoami reports. */
export function currentWindowsAccount(exec: AclExec = runSystemTool): WindowsAccount {
	try {
		const line = exec(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).trim();
		const match = /^"([^"]+)","(S-1-[\d-]+)"$/u.exec(line);
		if (match?.[1] && match[2]) return { name: match[1], sid: match[2] };
	} catch {
		// Fall back to the user name; icacls resolves it like the SID.
	}
	try {
		return { name: userInfo().username || null, sid: null };
	} catch {
		return { name: null, sid: null };
	}
}

/**
 * Replace the ACL of `path` with full control for the current account and
 * SYSTEM only, dropping every inherited ACE. Returns null when that worked or
 * the platform is not win32, otherwise why it failed; it never throws.
 */
export function applyOwnerOnlyAcl(path: string, host: AclHost = {}): string | null {
	if ((host.platform ?? process.platform) !== "win32") return null;
	const exec = host.exec ?? runSystemTool;
	try {
		const account = currentWindowsAccount(exec);
		const owner = account.sid !== null ? `*${account.sid}` : account.name;
		if (owner === null) return "could not resolve the current Windows account";
		exec(systemTool("icacls.exe"), [path, "/inheritance:r", "/grant:r", `${owner}:F`, `*${SYSTEM_SID}:F`]);
		return null;
	} catch (error) {
		return oneLine(error);
	}
}

/** The raw `icacls <path>` listing, or why it could not be read. */
export function readWindowsAcl(path: string, exec: AclExec = runSystemTool): WindowsAclRead {
	try {
		return { output: exec(systemTool("icacls.exe"), [path]) };
	} catch (error) {
		return { error: oneLine(error) };
	}
}

/**
 * Principals in an `icacls` listing that hold an allow ACE and are not the
 * account, SYSTEM or Administrators. The first line carries the path before its
 * first ACE; the summary line has no `name:(rights)` shape and is skipped.
 */
export function extraAclPrincipals(output: string, path: string, account: WindowsAccount): string[] {
	const ownerName = account.name?.toLowerCase() ?? null;
	const ownerSid = account.sid?.toLowerCase() ?? null;
	const extras: string[] = [];
	for (const raw of output.split(/\r?\n/u)) {
		const line = (raw.startsWith(path) ? raw.slice(path.length) : raw).trim();
		const at = line.indexOf(":(");
		if (at <= 0 || !line.endsWith(")")) continue;
		if (/\(DENY\)/iu.test(line.slice(at))) continue;
		const principal = line.slice(0, at);
		const key = principal.toLowerCase();
		if (ALWAYS_ALLOWED.has(key) || key === ownerSid) continue;
		if (ownerName !== null && (key === ownerName || (!ownerName.includes("\\") && key.endsWith(`\\${ownerName}`))))
			continue;
		if (!extras.includes(principal)) extras.push(principal);
	}
	return extras;
}
