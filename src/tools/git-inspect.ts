/**
 * Field validation and the fixed inspection argv for the typed git tool. Pure,
 * so the loop guard can key a git call on the argv it will run. A field an op
 * does not take is refused before anything runs: log once ignored a nested
 * `args` array and ran the default 20-commit log twice, green both times
 * (DF-9), and a reviewer with no way to name a revision repeated that one
 * call until the loop guard blocked it (DF-4).
 */

export const GIT_OPS = ["status", "diff", "log", "show", "add", "commit"] as const;
export type GitOp = (typeof GIT_OPS)[number];
type GitInspectOp = "status" | "diff" | "log" | "show";

const OP_ALIASES = ["op", "mode", "action"] as const;
const COMMON_FIELDS = new Set<string>([...OP_ALIASES, "cwd", "timeout_ms", "max_output_bytes"]);
const OP_FIELDS: Record<GitOp, ReadonlyArray<string>> = {
	status: ["path"],
	diff: ["rev", "cached", "stat", "name_only", "path"],
	log: ["rev", "limit", "stat", "path"],
	show: ["rev", "stat", "name_only", "path"],
	add: ["paths"],
	commit: ["message"],
};
const OP_EXAMPLES: Record<GitOp, Record<string, unknown>> = {
	status: { op: "status" },
	diff: { op: "diff", rev: "HEAD~1..HEAD", stat: true },
	log: { op: "log", rev: "main", limit: 5, stat: true },
	show: { op: "show", rev: "HEAD~1" },
	add: { op: "add", paths: ["src/index.ts"] },
	commit: { op: "commit", message: "fix: correct retry handling" },
};

const REV_MAX_CHARS = 200;
// Ref names, abbreviated or full hashes, and the ~ ^ @{n} suffixes. No
// whitespace, ":" (rev:path), globs, or pathspec magic.
const REV_PART = /^[A-Za-z0-9._/@^~{}+-]+$/;

function example(op: GitOp): string {
	return `gateway({op:"call",capability:"git",args:${JSON.stringify(OP_EXAMPLES[op])}})`;
}

function opList(): string {
	return `${GIT_OPS.slice(0, -1).join(", ")}, or ${GIT_OPS[GIT_OPS.length - 1]}`;
}

function revPartError(part: string): string | null {
	if (part.startsWith("-")) return "starts with -";
	if (!REV_PART.test(part)) return "has a character outside a ref name, hash, ~, ^ or @{n}";
	return null;
}

/** Why `rev` is refused, or null. A range is `a..b` or `a...b`; show takes one revision. */
function gitRevError(rev: unknown, op: GitOp): string | null {
	if (typeof rev !== "string" || rev.length === 0) return "must be a non-empty string";
	if (rev.length > REV_MAX_CHARS) return `exceeds ${REV_MAX_CHARS} characters`;
	if (rev.startsWith("-")) return "starts with -";
	const range = /^(.*?)\.\.\.?(.*)$/.exec(rev);
	if (range === null) return revPartError(rev);
	if (op === "show") return "is a range; show takes one revision (use op log or diff for a range)";
	const sides = [range[1] ?? "", range[2] ?? ""];
	if (sides.every((side) => side.length === 0)) return "names no revision";
	for (const side of sides) {
		if (side.length === 0) continue;
		if (side.includes("..")) return "has more than one range operator";
		const error = revPartError(side);
		if (error !== null) return error;
	}
	return null;
}

export type GitFieldCheck = { ok: true; op: GitOp } | { ok: false; op: string; error: string };

/** The op the call names, and every field checked against what that op takes. */
export function checkGitFields(args: Record<string, unknown>): GitFieldCheck {
	const named = OP_ALIASES.flatMap((key) => (typeof args[key] === "string" ? [args[key] as string] : []));
	const op = named[0] ?? "";
	const unexpected = Object.keys(args).find(
		(key) => !COMMON_FIELDS.has(key) && !Object.values(OP_FIELDS).some((fields) => fields.includes(key)),
	);
	if (!(GIT_OPS as ReadonlyArray<string>).includes(op)) {
		return {
			ok: false,
			op,
			error: `git: expected args.op to be ${opList()}; got ${JSON.stringify(op)}${unexpected ? `; unrecognized field ${JSON.stringify(unexpected)}` : ""}. Example: ${example("log")}`,
		};
	}
	const gitOp = op as GitOp;
	if (new Set(named).size > 1) {
		return { ok: false, op, error: `git: op, mode and action name different ops (${named.join(", ")}); nothing ran` };
	}
	const accepted = OP_FIELDS[gitOp];
	const refused = Object.keys(args).find((key) => !COMMON_FIELDS.has(key) && !accepted.includes(key));
	if (refused !== undefined) {
		const hint = gitOp === "log" || gitOp === "diff" ? ` For one commit's header and patch use op show with rev.` : "";
		return {
			ok: false,
			op,
			error: `git: op ${gitOp} does not take field ${JSON.stringify(refused)}; nothing ran. ${gitOp} takes ${accepted.join(", ")}, plus cwd, timeout_ms, max_output_bytes.${hint} Example: ${example(gitOp)}`,
		};
	}
	if (args.rev !== undefined) {
		const error = gitRevError(args.rev, gitOp);
		if (error !== null) {
			return {
				ok: false,
				op,
				error: `git: rev ${JSON.stringify(args.rev)} ${error}; nothing ran. Example: ${example(gitOp)}`,
			};
		}
	}
	return { ok: true, op: gitOp };
}

export function isGitInspectOp(op: GitOp): op is GitInspectOp {
	return op === "status" || op === "diff" || op === "log" || op === "show";
}

/**
 * The argv an inspection op runs, for fields checkGitFields admitted. A
 * revision always follows --end-of-options, so it can never be read as an
 * option even if validation were bypassed.
 */
export function gitInspectArgv(op: GitInspectOp, args: Record<string, unknown>): string[] {
	const path = typeof args.path === "string" && args.path.length > 0 ? args.path : null;
	const rev = typeof args.rev === "string" ? args.rev : null;
	const tail = [...(rev !== null ? ["--end-of-options", rev] : []), ...(path !== null ? ["--", path] : [])];
	if (op === "status") return ["status", "--short", "--branch", ...(path !== null ? ["--", path] : [])];
	if (op === "diff") {
		const vector = ["diff", "--no-ext-diff", "--no-textconv"];
		if (args.cached === true) vector.push("--cached");
		if (args.stat === true) vector.push("--stat");
		if (args.name_only === true) vector.push("--name-only");
		return [...vector, ...tail];
	}
	if (op === "log") {
		const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(200, Math.floor(args.limit)) : 20;
		const vector = ["log", "--no-ext-diff", "--no-textconv", "--oneline", "-n", String(limit)];
		// A merge has no stat by default, and the newest commits of a branch are
		// often merges; the first-parent diff is what the merge brought in.
		if (args.stat === true) vector.push("--stat", "--diff-merges=first-parent");
		return [...vector, ...tail];
	}
	const vector = ["show", "--no-ext-diff", "--no-textconv"];
	if (args.stat === true) vector.push("--stat");
	if (args.name_only === true) vector.push("--name-only");
	if (args.stat !== true && args.name_only !== true) vector.push("--stat", "--patch");
	vector.push("--diff-merges=first-parent");
	return [...vector, ...(rev === null ? ["--end-of-options", "HEAD"] : []), ...tail];
}

/**
 * What a git call will actually run, for repeat detection: the inspection
 * argv and cwd. Null for a mutation or a refused call, whose raw arguments
 * already are its identity.
 */
export function gitCallIdentity(args: Record<string, unknown>): Record<string, unknown> | null {
	const check = checkGitFields(args);
	if (!check.ok || !isGitInspectOp(check.op)) return null;
	const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
	return { argv: gitInspectArgv(check.op, args), ...(cwd !== undefined ? { cwd } : {}) };
}
