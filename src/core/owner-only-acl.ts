/**
 * Owner-only access for a secret file on Windows.
 *
 * On win32 chmod(0o600) only clears the read-only attribute: the file keeps the
 * ACL it inherited from its directory, and outside the user profile that grants
 * BUILTIN\Users read and Authenticated Users modify. `applyOwnerOnlyAcl` breaks
 * inheritance, grants only the current account and SYSTEM, removes any explicit
 * grant another tool or a restore left behind, and checks the result; on a
 * directory the two grants are inheritable, so a file created there (a write's
 * temp file included) is owner-only from its first byte. `readWindowsAcl` and
 * `extraAclPrincipals` let doctor say who else holds an ACE.
 *
 * The ACL is read as SDDL (`icacls <path> /save`), which names every principal by
 * SID, because the names `icacls <path>` prints are localized
 * (`VORDEFINIERT\Administratoren`) and written in the OEM code page. Both system
 * tools run by absolute path without a shell, so a PATH entry or a file in the
 * working directory cannot stand in for them. Off win32 nothing runs.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, win32 } from "node:path";

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

/** The DACL as SDDL (`D:PAI(A;;FA;;;SY)...`), or why it could not be read. */
export type WindowsAclRead = { dacl: string } | { error: string };

const ACL_TIMEOUT_MS = 10_000;
const SYSTEM_SID = "S-1-5-18";
const ALWAYS_ALLOWED = new Set([SYSTEM_SID, "S-1-5-32-544"]);

/** Well-known principals by the SDDL alias Windows writes in place of their SID, with the name doctor shows. */
const WELL_KNOWN: ReadonlyArray<readonly [alias: string, sid: string, name: string]> = [
	["SY", SYSTEM_SID, "NT AUTHORITY\\SYSTEM"],
	["BA", "S-1-5-32-544", "BUILTIN\\Administrators"],
	["BU", "S-1-5-32-545", "BUILTIN\\Users"],
	["BG", "S-1-5-32-546", "BUILTIN\\Guests"],
	["PU", "S-1-5-32-547", "BUILTIN\\Power Users"],
	["RD", "S-1-5-32-555", "BUILTIN\\Remote Desktop Users"],
	["AU", "S-1-5-11", "NT AUTHORITY\\Authenticated Users"],
	["IU", "S-1-5-4", "NT AUTHORITY\\INTERACTIVE"],
	["NU", "S-1-5-2", "NT AUTHORITY\\NETWORK"],
	["SU", "S-1-5-6", "NT AUTHORITY\\SERVICE"],
	["AN", "S-1-5-7", "NT AUTHORITY\\ANONYMOUS LOGON"],
	["RC", "S-1-5-12", "NT AUTHORITY\\RESTRICTED"],
	["LS", "S-1-5-19", "NT AUTHORITY\\LOCAL SERVICE"],
	["NS", "S-1-5-20", "NT AUTHORITY\\NETWORK SERVICE"],
	["WD", "S-1-1-0", "Everyone"],
	["CO", "S-1-3-0", "CREATOR OWNER"],
	["OW", "S-1-3-4", "OWNER RIGHTS"],
	["AC", "S-1-15-2-1", "ALL APPLICATION PACKAGES"],
];

/** One ACE of an SDDL DACL: `(type;flags;rights;object;inherit-object;sid)`, a callback ACE's condition after it. */
const SDDL_ACE = /\(([A-Z]{1,2});([A-Z]*);[^;()]*;[^;()]*;[^;()]*;([^;()]+)(?:;[^()]*)?\)/gu;

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

/** A SID or an SDDL alias as one canonical SID; an alias outside the table stays as written. */
function canonicalSid(token: string): string {
	return WELL_KNOWN.find(([alias]) => alias === token)?.[1] ?? token.toUpperCase();
}

/** The name doctor shows for a principal: the English name of a well-known SID, else the SID itself. */
export function aclPrincipalName(sid: string): string {
	return WELL_KNOWN.find(([, known]) => known === sid)?.[2] ?? sid;
}

/** icacls takes a SID only with a `*` prefix. */
function icaclsPrincipal(sid: string): string {
	return /^S-1-[\d-]+$/u.test(sid) ? `*${sid}` : sid;
}

/**
 * Replace the ACL of `path` with full control for the current account and
 * SYSTEM only, inheritable by new children when `directory` is set.
 * `/inheritance:r` drops inherited ACEs and `/grant:r` replaces only the grants
 * it names, so an explicit grant to anyone else survives both and is removed one
 * SID at a time; the DACL is then read back. Returns null when the path is
 * owner-only or the platform is not win32, otherwise why it is not; it never throws.
 */
export function applyOwnerOnlyAcl(
	path: string,
	host: AclHost = {},
	options: { directory?: boolean } = {},
): string | null {
	if ((host.platform ?? process.platform) !== "win32") return null;
	const exec = host.exec ?? runSystemTool;
	try {
		const account = currentWindowsAccount(exec);
		const owner = account.sid !== null ? `*${account.sid}` : account.name;
		if (owner === null) return "could not resolve the current Windows account";
		const rights = options.directory === true ? "(OI)(CI)F" : "F";
		const icacls = systemTool("icacls.exe");
		exec(icacls, [path, "/inheritance:r", "/grant:r", `${owner}:${rights}`, `*${SYSTEM_SID}:${rights}`]);
		// The DACL names the account only by SID, so without one the result cannot be checked.
		if (account.sid === null) return "could not resolve the current Windows account's SID to check the ACL";
		const extras = (): string[] => {
			const acl = readWindowsAcl(path, exec);
			if ("error" in acl) throw new Error(acl.error);
			return extraAclPrincipals(acl.dacl, account);
		};
		const found = extras();
		if (found.length === 0) return null;
		for (const sid of found) exec(icacls, [path, "/remove:g", icaclsPrincipal(sid)]);
		const left = extras();
		return left.length === 0 ? null : `its ACL still grants ${left.map(aclPrincipalName).join(", ")}`;
	} catch (error) {
		return oneLine(error);
	}
}

/** `icacls /save` writes UTF-16LE; a UTF-8 file (no NUL byte) is read as such. */
function decodeAclFile(bytes: Buffer): string {
	const text = bytes.includes(0) ? bytes.toString("utf16le") : bytes.toString("utf8");
	return text.replace(/^\uFEFF/u, "");
}

/** The DACL of `path` as SDDL, saved by `icacls <path> /save` to a scratch file, or why it could not be read. */
export function readWindowsAcl(path: string, exec: AclExec = runSystemTool): WindowsAclRead {
	let dir: string | null = null;
	try {
		dir = mkdtempSync(join(tmpdir(), "clio-acl-"));
		const saved = join(dir, "acl");
		exec(systemTool("icacls.exe"), [path, "/save", saved]);
		const dacl = /D:\S*/u.exec(decodeAclFile(readFileSync(saved)))?.[0];
		return dacl === undefined ? { error: "icacls saved no DACL" } : { dacl };
	} catch (error) {
		return { error: oneLine(error) };
	} finally {
		if (dir !== null) rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * SIDs that hold an allow ACE on the object itself and are not the account,
 * SYSTEM or Administrators. Deny ACEs and inherit-only ones (`IO`, which reach
 * only children) grant nothing here.
 */
export function extraAclPrincipals(dacl: string, account: WindowsAccount): string[] {
	const ownerSid = account.sid?.toUpperCase() ?? null;
	const extras: string[] = [];
	for (const [, type = "", flags = "", token = ""] of dacl.matchAll(SDDL_ACE)) {
		if (type !== "A" && type !== "OA" && type !== "XA") continue;
		// Flags are two-letter tokens, so `IO` counts only on a token boundary.
		if (/^(?:[A-Z]{2})*?IO/u.test(flags)) continue;
		const sid = canonicalSid(token);
		if (ALWAYS_ALLOWED.has(sid) || sid === ownerSid || extras.includes(sid)) continue;
		extras.push(sid);
	}
	return extras;
}
