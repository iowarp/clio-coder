import { homedir } from "node:os";
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
	/** A read of Clio's own provider credential store, at every autonomy level. */
	clioCredentials: "yolo-floor-clio-credentials",
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

/** Home and its real path, read once per judgment. */
function homeForms(): string[] {
	const home = path.resolve(homedir());
	const real = canonicalizePath(home);
	return real === null || real === home ? [home] : [home, real];
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

/** `~`, `$HOME` and `${HOME}` at the start of a word, expanded; null for any other run-time word. */
function expandHomeWord(word: string): string | null {
	const home = homedir();
	const expanded = word.replace(/^(?:~(?=\/|$)|\$\{HOME\}|\$HOME(?![\w]))/u, home);
	return /[$`]/u.test(expanded) ? null : expanded;
}

/** Most directories one walk keeps for its relative deletes. */
const MAX_FLOOR_BASES = 32;

/**
 * Deletes and overwrites a command makes whose target is `/`, the home
 * directory or an ancestor of it, or a system tree: rm, rmdir and unlink
 * however wrapped, `find -delete` and `find -exec rm` by their roots,
 * `rsync --delete` by its operands, and shred. A glob is judged by the
 * directory it expands in. A relative target resolves from the call's cwd
 * and every directory a literal cd can leave the shell in; a target or cd
 * named only at run time is not placed and is not a floor hit.
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
		for (const abs of place(target, bases)) {
			const reason = hit(abs);
			if (reason !== null) return reason;
		}
		return null;
	};
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
				if (target === null || event.unmodeled) {
					bases = null;
					continue;
				}
				// A cd may fail, so the shell may still be where it was.
				const landed = place(target, bases);
				if (!path.isAbsolute(target) && bases === null) continue;
				const merged = [...new Set([...(bases ?? []), ...landed])];
				bases = merged.length > MAX_FLOOR_BASES ? null : merged;
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
			const reason = judge(operand, [cwd]);
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
