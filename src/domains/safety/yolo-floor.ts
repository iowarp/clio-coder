import { homedir, userInfo } from "node:os";
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import type { DamageControlRule } from "./damage-control.js";
import { isSameOrDescendant } from "./path-policy.js";
import { extractCommandPathWalks, shellCommandSteps } from "./protected-artifacts.js";

/**
 * The yolo floor (#407, #419, #421). Yolo is the operator's
 * skip-permissions mode: no approval stops and no built-in rail. What still
 * blocks is this short list of actions nothing in a coding task needs and
 * nobody can undo, plus Clio's own state and credential store,
 * operator-authored rules and the run's explicit ceilings, which the policy
 * engine applies beside it. The operator's own session at autonomy default
 * meets the same floor before anything else, so no judge can allow it.
 *
 * A floor hit is a hard block returned to the model with its reason; it never
 * parks. The floor reads command text and literal paths only: an interpreter
 * that deletes through its own API, or a path built at run time, is not seen,
 * which is the same reach as any skip-permissions mode.
 */

/** Damage-control pack rules the floor keeps at yolo, by their pack ids. */
export const YOLO_FLOOR_PACK_RULE_IDS: ReadonlySet<string> = new Set([
	"rm-home-or-root",
	"mkfs-any",
	"dd-of-dev",
	"fork-bomb",
]);

/** Floor rule ids for the judgments below and for Clio's own state. */
export const YOLO_FLOOR_RULE_IDS = {
	deleteTarget: "yolo-floor-delete-target",
	mkfs: "yolo-floor-mkfs",
	wipefs: "yolo-floor-wipefs",
	blockDevice: "yolo-floor-block-device",
	forkBomb: "yolo-floor-fork-bomb",
	/** Existing rail id: a write or delete into Clio's config, data, state or cache trees. */
	clioOwned: "clio-owned-state",
	/** Existing rail id: a workspace trust grant made from a tool call. */
	trustAuthority: "trust-authority",
	/** Clio's settings, credential or trust CLI run from a tool call, at every autonomy level. */
	settingsAuthority: "settings-authority",
	/** A read of Clio's own provider credential store, at every autonomy level. */
	clioCredentials: "yolo-floor-clio-credentials",
	/** A floor command found in a line read as raw text, or a line whose raw-text pieces hold more than the floor reads. */
	rawText: "yolo-floor-raw-text",
} as const;

/** Every reason code a floor block carries starts with this. */
export const YOLO_FLOOR_REASON_PREFIX = "yolo-floor:";

/** Block devices a write must never reach, by their /dev names on Linux and macOS. */
const BLOCK_DEVICE = "/dev/(?:sd|hd|vd|xvd|nvme|mmcblk|loop|dm-|md|nbd|rbd|zram|sr|r?disk|mapper/)";

/**
 * Text rules the floor adds to the kept pack rules. They run through the same
 * matcher, so a match inside an inert quoted argument (a commit message, an
 * echo) does not count.
 */
export const YOLO_FLOOR_TEXT_RULES: ReadonlyArray<DamageControlRule> = [
	{
		id: YOLO_FLOOR_RULE_IDS.blockDevice,
		description: "writes straight to a block device through dd, a redirect or tee",
		pattern: new RegExp(
			String.raw`(?:\bdd\b[^;&|\n]*\bof=["']?${BLOCK_DEVICE}|>>?\|?\s*["']?${BLOCK_DEVICE}|\btee\s+(?:-[A-Za-z]+\s+)*["']?${BLOCK_DEVICE})`,
			"i",
		),
		class: "system_modify",
		block: true,
	},
	{
		id: YOLO_FLOOR_RULE_IDS.forkBomb,
		description: "defines a function that pipes itself into itself in the background (a fork bomb)",
		pattern: /(?:^|[\s;&|({])([\w:.-]+)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&/u,
		class: "execute",
		block: true,
	},
];

/** Commands whose every run formats or erases a filesystem signature. */
const FLOOR_EXECUTABLES: ReadonlyArray<{ id: string; description: string; matches: (name: string) => boolean }> = [
	{
		id: YOLO_FLOOR_RULE_IDS.mkfs,
		description: "creates a filesystem (mkfs and its variants)",
		matches: (name) => /^(?:mkfs(?:\.[\w.-]+)?|mke2fs|newfs(?:_[\w]+)?)$/u.test(name),
	},
	{
		id: YOLO_FLOOR_RULE_IDS.wipefs,
		description: "erases filesystem signatures (wipefs)",
		matches: (name) => name === "wipefs",
	},
];

export interface YoloFloorHit {
	ruleId: string;
	reason: string;
}

/** The floor rule a command's steps run, by executable name: mkfs and wipefs. */
export function yoloFloorExecutableHit(command: string): YoloFloorHit | null {
	for (const step of shellCommandSteps(command)) {
		for (const entry of FLOOR_EXECUTABLES) {
			if (entry.matches(step.executable)) {
				return { ruleId: entry.id, reason: `matched ${entry.id}: ${entry.description}` };
			}
		}
	}
	return null;
}

/** Words a raw-text candidate starts at: the floor's executables and the commands that delete, overwrite or archive. */
const RAW_TEXT_START_WORD =
	/^(?:rm|rmdir|unlink|shred|find|rsync|dd|tee|tar|cp|mv|ln|install|truncate|wipefs|mkfs(?:\.[\w.-]+)?|mke2fs|newfs(?:_\w+)?)$/u;

/**
 * Most text the raw-text candidates of one line may hold together. Every candidate runs through the floor's
 * judgments, so the work grows with this sum; a line whose candidates exceed it is blocked.
 */
const MAX_RAW_TEXT_BYTES = 32 * 1024;

/** What each raw-text candidate costs the budget beyond its text: the floor's judgments have a fixed cost per call. */
const RAW_TEXT_CANDIDATE_BYTES = 64;

const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
};

/** The text of a `$'...'` body as bash decodes it. */
function decodeAnsiCBody(body: string): string {
	return body.replace(
		/\\(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c(.)|([\s\S]))/gu,
		(_all, hex: string, u4: string, u8: string, octal: string, control: string, other: string) => {
			const code =
				hex !== undefined
					? Number.parseInt(hex, 16)
					: u4 !== undefined
						? Number.parseInt(u4, 16)
						: u8 !== undefined
							? Number.parseInt(u8, 16)
							: octal !== undefined
								? Number.parseInt(octal, 8)
								: control !== undefined
									? control.charCodeAt(0) & 0x1f
									: null;
			if (code !== null) return code <= 0x10ffff ? String.fromCodePoint(code) : "";
			return ANSI_C_ESCAPES[other] ?? other;
		},
	);
}

/**
 * Whether a `$(` or backtick in the command is one the shell runs: outside single quotes, `$'...'`, a backslash
 * escape and a comment. Inside double quotes it runs. A here-document body is not told apart, so a quote in one
 * can hide a later substitution; the caller also reads any substitution beside `<<` for that reason.
 */
function holdsSubstitution(command: string): boolean {
	let doubleQuoted = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		const next = command[index + 1];
		// `\x` is a literal character and `$$` the shell's PID, so neither starts a quote or a substitution.
		if (char === "\\" || (char === "$" && next === "$")) {
			index += 1;
			continue;
		}
		if (char === "`" || (char === "$" && next === "(")) return true;
		if (doubleQuoted) {
			if (char === '"') doubleQuoted = false;
			continue;
		}
		if (char === '"') {
			doubleQuoted = true;
		} else if (char === "'" || (char === "$" && next === "'")) {
			const ansiC = char === "$";
			index += ansiC ? 2 : 1;
			while (index < command.length && command[index] !== "'") index += ansiC && command[index] === "\\" ? 2 : 1;
		} else if (char === "#" && (index === 0 || /[\s;&|()<>]/u.test(command[index - 1] ?? ""))) {
			while (index < command.length && command[index] !== "\n") index += 1;
		}
	}
	return false;
}

/** A cd operand the floor's walk cannot place, standing for a cd whose directory the raw text does not say. */
const RAW_TEXT_UNPLACED_CD = "$UNPLACED_CD";

/** Most directories the byte budget charges a raw-text candidate for; the floor's walk keeps no more. */
const RAW_TEXT_MAX_FANOUT = 32;

/** Most directories a line's cds may place a raw-text candidate in before its relative cds count as unplaced. */
const RAW_TEXT_RELATIVE_FANOUT = 8;

/**
 * The directory operand of the `cd` or `pushd` at `at` in a raw-text piece, after its options; `~` when it names
 * none. Null when the text does not say where it leaves the shell: run through `eval`, `cd -`, a `pushd` stack
 * rotation or an option the floor does not know.
 */
function rawCdOperand(words: ReadonlyArray<string>, at: number): string | null {
	if (words.slice(0, at).includes("eval")) return null;
	const options = words[at] === "cd" ? /^-[LPe@]+$/u : /^-n$/u;
	let index = at + 1;
	while (index < words.length) {
		const word = words[index] ?? "";
		if (word === "--") {
			index += 1;
			break;
		}
		if (!options.test(word)) break;
		index += 1;
	}
	const operand = words[index];
	if (operand === undefined) return "~";
	return operand === "-" || /^[-+]/u.test(operand) ? null : operand;
}

/**
 * The raw-text reading of a line the shared scanners may not follow into every command: one holding a command
 * substitution the shell runs, or any `$(` or backtick beside a here-document, a here-string or (for `$(`) a `#`,
 * where the quote context cannot be told from the text. The scanners place a here-document's end, a comment and a
 * substitution's close by bash's rules, and where they read a step as data the floor never judges it. This reading
 * does not parse: it joins backslash-newlines, decodes `$'...'` and `$"..."`, drops every quote, cuts the text at
 * newlines, operators, parentheses, braces and backticks, and yields each piece, the piece without its first word (a
 * here-document delimiter bash reads as the end), and the piece from every floor command word on, for the floor's
 * judgments to read like commands. Every cd on the line is put in front of each candidate, so a relative delete is
 * placed where such a cd can leave the shell; a cd whose directory the text does not say adds a variant judged from
 * an unknown directory. Each candidate counts once per directory its cds can place it in. Fail-closed: a floor command quoted as data in such a line blocks
 * too. Null when the line has no such shape; `overflow` when its candidates hold more text than the floor reads.
 */
export function yoloFloorRawCandidates(command: string): { candidates: string[]; overflow: boolean } | null {
	const substitution = /\$\(/u.test(command);
	const beside =
		(substitution || command.includes("`")) && (command.includes("<<") || (substitution && command.includes("#")));
	if (!beside && !holdsSubstitution(command)) return null;
	const decoded = command
		.replace(/\\\r?\n/gu, "")
		.replace(/\$\$|\$'((?:[^'\\]|\\[\s\S])*)'/gu, (all, body?: string) =>
			body === undefined ? all : decodeAnsiCBody(body),
		)
		.replace(/\$\$|\$"/gu, (all) => (all === "$$" ? all : '"'));
	const stripped = decoded.replace(/["']/gu, "");
	const pieces = stripped.split(/[\n\r;&|(){}`]/u).map((piece) =>
		piece
			.trim()
			.split(/\s+/u)
			.filter((word) => word !== ""),
	);
	const cds = new Set<string>();
	let unplacedCd = false;
	for (const words of pieces) {
		words.forEach((word, at) => {
			if (word !== "cd" && word !== "pushd") return;
			const operand = rawCdOperand(words, at);
			if (operand === null) unplacedCd = true;
			else cds.add(`cd ${operand}`);
		});
	}
	// A cd may or may not run: an absolute one adds a directory, a relative one doubles them. Past a few relative cds
	// they are judged as one cd the text does not say, so the work stays linear in the line.
	let placed = [...cds];
	const fanoutOf = (list: ReadonlyArray<string>) =>
		list.reduce((count, cd) => (/^cd [/~$]/u.test(cd) ? count + 1 : count * 2), 1);
	if (fanoutOf(placed) > RAW_TEXT_RELATIVE_FANOUT) {
		placed = placed.filter((cd) => /^cd [/~$]/u.test(cd));
		unplacedCd = true;
	}
	const fanout = Math.min(fanoutOf(placed), RAW_TEXT_MAX_FANOUT);
	const literal = placed.length === 0 ? "" : `${placed.join(" && ")} && `;
	const prefixes = unplacedCd ? [literal, `${literal}cd ${RAW_TEXT_UNPLACED_CD} && `] : [literal];
	const candidates = new Set<string>([stripped]);
	let bytes = stripped.length;
	for (const words of pieces) {
		if (words.length === 0) continue;
		const starts = words.flatMap((word, index) => (RAW_TEXT_START_WORD.test(word) ? [index] : []));
		if (starts.length === 0 && !words.some((word) => /[/~$>]/u.test(word))) continue;
		for (const start of new Set([0, 1, ...starts])) {
			if (start >= words.length) continue;
			for (const prefix of prefixes) {
				const candidate = `${prefix}${words.slice(start).join(" ")}`;
				if (candidates.has(candidate)) continue;
				candidates.add(candidate);
				bytes += (candidate.length + RAW_TEXT_CANDIDATE_BYTES) * fanout;
				if (bytes > MAX_RAW_TEXT_BYTES) return { candidates: [], overflow: true };
			}
		}
	}
	return { candidates: [...candidates], overflow: false };
}

/**
 * System trees a delete may never reach at yolo. `/var/tmp` and `/var/folders`
 * are scratch space, as the classifier already treats them.
 */
const SYSTEM_TREES: ReadonlyArray<string> = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/proc",
	"/sbin",
	"/sys",
	"/usr",
	"/var",
	"/private/etc",
	"/private/var",
];
const SYSTEM_TREE_EXEMPT: ReadonlyArray<string> = [
	"/var/tmp",
	"/var/folders",
	"/private/var/tmp",
	"/private/var/folders",
];

function inSystemTree(abs: string): boolean {
	if (SYSTEM_TREE_EXEMPT.some((exempt) => isSameOrDescendant(abs, exempt))) return false;
	if (SYSTEM_TREES.some((tree) => isSameOrDescendant(abs, tree))) return true;
	// `/lib*`: /lib, /lib32, /lib64, /libx32 and their kin.
	const top = abs.split("/")[1] ?? "";
	return abs.startsWith("/") && top.startsWith("lib");
}

/** The operator's account name and passwd home, which `~name` expands to; null when the host has none. */
function ownAccount(): { name: string; home: string } | null {
	try {
		const info = userInfo();
		return info.username.length > 0 && info.homedir.length > 0 ? { name: info.username, home: info.homedir } : null;
	} catch {
		return null;
	}
}

/** Home, the account's passwd home, and their real paths, read once per judgment. */
function homeForms(): string[] {
	const forms = new Set<string>();
	const account = ownAccount();
	for (const spelled of [homedir(), ...(account !== null ? [account.home] : [])]) {
		const home = path.resolve(spelled);
		forms.add(home);
		const real = canonicalizePath(home);
		if (real !== null) forms.add(real);
	}
	return [...forms];
}

/**
 * Why a delete landing at `abs` is a floor hit, or null. `/`, the home
 * directory or any ancestor of it, and anything in a system tree are floor.
 * A workspace that is not itself one of those keeps everything strictly
 * inside it out of the system-tree judgment, so a container workspace under
 * /usr/src or /var/www cleans its own build output.
 */
function floorTargetReason(abs: string, homes: ReadonlyArray<string>, workspace: string): string | null {
	if (abs === "/") return "the filesystem root";
	if (homes.some((home) => isSameOrDescendant(home, abs))) {
		return homes.some((home) => home === abs) ? `the home directory ${abs}` : `${abs}, which holds the home directory`;
	}
	const workspaceIsFloor = workspace === "/" || homes.some((home) => isSameOrDescendant(home, workspace));
	if (!workspaceIsFloor && abs !== workspace && isSameOrDescendant(abs, workspace)) return null;
	return inSystemTree(abs) ? `${abs} in a system tree` : null;
}

/**
 * `~`, `~name` for the operator's own account, `$HOME` and `${HOME}` at the start of a word, expanded; null for any
 * other run-time word.
 */
function expandHomeWord(word: string): string | null {
	const home = homedir();
	const account = ownAccount();
	const named =
		account !== null && (word === `~${account.name}` || word.startsWith(`~${account.name}/`))
			? `${account.home}${word.slice(account.name.length + 1)}`
			: word;
	const expanded = named.replace(/^(?:~(?=\/|$)|\$\{HOME\}|\$HOME(?![\w]))/u, home);
	return /[$`]/u.test(expanded) ? null : expanded;
}

/** A directory and every directory above it, the root excluded. */
function ancestors(dir: string): string[] {
	const found: string[] = [];
	for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) found.push(at);
	return found;
}

/** Most directories one walk keeps for its relative deletes. */
const MAX_FLOOR_BASES = 32;

/**
 * Deletes and overwrites a command makes whose target is `/`, the home
 * directory or an ancestor of it, or a system tree: rm, rmdir and unlink
 * however wrapped, `find -delete` and `find -exec rm` by their roots,
 * `rsync --delete` by its operands, and shred. A glob is judged by the
 * directory it expands in. A relative target resolves from the call's cwd
 * and every directory a literal cd can leave the shell in, shred's from every
 * directory any cd of the command can. After a cd the floor cannot place (one
 * naming a variable, a substitution, `~user` or a glob, or one in a loop) a
 * relative target is a hit when it could name a protected root from some
 * directory: `.`, `..`, `*`, `lib`, `etc` or the home directory's own name. A
 * target named only at run time is not placed and is not a floor hit.
 */
export function yoloFloorDeleteHit(command: string, cwd: string, workspace: string): YoloFloorHit | null {
	const homes = homeForms();
	const hit = (abs: string): string | null => floorTargetReason(abs, homes, workspace);
	const place = (target: string, bases: ReadonlyArray<string> | null): string[] => {
		if (path.isAbsolute(target)) {
			const lexical = path.resolve(target);
			const real = canonicalizeRawPath(target, "/");
			return real === null || real === lexical ? [lexical] : [lexical, real];
		}
		if (bases === null) return [];
		return bases.flatMap((base) => {
			const lexical = path.resolve(base, target);
			const real = canonicalizeRawPath(target, base);
			return real === null || real === lexical ? [lexical] : [lexical, real];
		});
	};
	const roots = [...homes.flatMap(ancestors), ...SYSTEM_TREES];
	/** Why a relative target is a hit from a directory the floor cannot place: it may name a protected root. */
	const unplaced = (target: string): string | null => {
		const rest = path.posix
			.normalize(target)
			.split("/")
			.filter((part) => part !== "" && part !== "." && part !== "..")
			.join("/");
		if (rest === "") return `${target} from a directory the floor cannot place, which may be the filesystem root`;
		const named = hit(`/${rest}`) ?? (roots.some((root) => root.endsWith(`/${rest}`)) ? rest : null);
		return named === null
			? null
			: `${target} from a directory the floor cannot place, which may name a protected root (${named})`;
	};
	const judge = (raw: string, bases: ReadonlyArray<string> | null): string | null => {
		const expanded = expandHomeWord(raw);
		if (expanded === null) return null;
		let target = expanded;
		const wildcard = target.search(/[*?[{]/u);
		if (wildcard >= 0) {
			// A glob expands to entries of the directory before its first wildcard.
			const slash = target.lastIndexOf("/", wildcard);
			target = slash < 0 ? "." : slash === 0 ? "/" : target.slice(0, slash);
		}
		if (bases === null && !path.isAbsolute(target)) return unplaced(target);
		for (const abs of place(target, bases)) {
			const reason = hit(abs);
			if (reason !== null) return reason;
		}
		return null;
	};
	const reached = new Set<string>([cwd]);
	let unknown = false;
	for (const walk of extractCommandPathWalks(command)) {
		let bases: string[] | null = [cwd];
		const saved: Array<string[] | null> = [];
		for (const event of walk) {
			if (event.kind === "subshell") {
				if (event.open) saved.push(bases === null ? null : [...bases]);
				else if (saved.length > 0) bases = saved.pop() ?? null;
				continue;
			}
			if (event.kind === "cd") {
				const target = expandHomeWord(event.target);
				if (target === null || event.unmodeled || target.startsWith("~") || /[*?[{]/u.test(target)) {
					bases = null;
					unknown = true;
					continue;
				}
				// A cd may fail, so the shell may still be where it was.
				const landed = place(target, bases);
				if (!path.isAbsolute(target) && bases === null) continue;
				const merged = [...new Set([...(bases ?? []), ...landed])];
				bases = merged.length > MAX_FLOOR_BASES ? null : merged;
				if (bases === null) unknown = true;
				else for (const base of bases) reached.add(base);
				continue;
			}
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			const reason = judge(event.target, bases);
			if (reason !== null) return deleteHit(event.target, reason);
		}
	}
	for (const step of shellCommandSteps(command, homedir())) {
		if (step.executable !== "shred") continue;
		for (const operand of step.args.filter((arg) => !arg.startsWith("-"))) {
			const reason = judge(operand, [...reached]) ?? (unknown ? judge(operand, null) : null);
			if (reason !== null) return deleteHit(operand, reason);
		}
	}
	return null;
}

function deleteHit(target: string, reason: string): YoloFloorHit {
	const id = YOLO_FLOOR_RULE_IDS.deleteTarget;
	return {
		ruleId: id,
		reason: `matched ${id}: deletes or overwrites ${reason} (${target}); yolo never deletes the filesystem root, the home directory or an ancestor of it, or a system tree`,
	};
}
