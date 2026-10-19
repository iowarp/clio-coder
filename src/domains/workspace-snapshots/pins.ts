import { shellQuote } from "../../core/shell-quote.js";
import { runGit, splitNul } from "./git.js";

/**
 * Ref pins: what a snapshot keeps reachable besides the work tree. A
 * destructive Git command can lose a commit without touching a file: a stash
 * drop or clear leaves the stash commit dangling, a branch delete removes the
 * branch and its reflog, and a hard reset moves the branch tip. Each snapshot
 * points refs at HEAD, every stash entry and the branches a call is about to
 * delete, under `refs/clio-coder/snapshots/<session>/pins/<n>/`, so `git gc`
 * keeps those commits and `/rewind` can name the command that brings each
 * ref back. Pins live beside the snapshot ref rather than under it because
 * Git cannot hold `<n>` as a ref and as a directory of refs at once.
 */

export type SnapshotPin =
	/** HEAD's commit, and the branch it was on (absent when detached). */
	| { kind: "head"; ref: string; sha: string; branch?: string }
	/** `stash@{index}` with its reflog subject, which `git stash store -m` takes back. */
	| { kind: "stash"; ref: string; sha: string; index: number; message: string }
	/** A local branch named by a branch delete, pinned at its tip. */
	| { kind: "branch"; ref: string; sha: string; name: string };

export interface RewindRef {
	pin: SnapshotPin;
	/** Where the ref stands now; `unknown` when Git could not be read. */
	state: "in-place" | "moved" | "gone" | "unknown";
	/** The command that brings the ref back, for the operator to run; null while it is in place. */
	recover: string | null;
}

/**
 * Refs a call is about to destroy or move. Its snapshot pins them, and a call
 * admitted only because the snapshot undoes it is refused when they could not
 * be pinned.
 */
export interface RefsAtRisk {
	/** HEAD's branch tip, moved by a reset that names a commit. */
	head: boolean;
	/** Stash entries, lost to a drop, clear or pop. */
	stash: boolean;
	/** Local branches a branch delete names. */
	branches: ReadonlyArray<string>;
}

/** Refs as Git reports them now. */
export interface RefState {
	head: { sha: string; branch?: string } | null;
	/** Newest first, as `stash@{0}`, `stash@{1}` and so on. */
	stash: Array<{ sha: string; message: string }>;
	/** Tips of the local branches asked for that exist. */
	branches: Map<string, string>;
}

/** A long stash is pinned up to here; the rest are named in the snapshot's note. */
export const STASH_PIN_LIMIT = 64;

const HEADS = "refs/heads/";

export async function readRefState(root: string, deadline: number, branches: ReadonlyArray<string>): Promise<RefState> {
	const names = [...new Set(branches)].filter((name) => name.length > 0);
	const [head, symbolic, stash, heads] = await Promise.all([
		runGit(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: root, deadline, allowExit: [1, 128] }),
		runGit(["symbolic-ref", "-q", "HEAD"], { cwd: root, deadline, allowExit: [1, 128] }),
		// The log under `stash list` would verify signatures if the operator's
		// config asked it to, and that runs gpg.
		runGit(["stash", "list", "-z", "--format=%H%x09%gs"], { cwd: root, deadline, config: ["log.showSignature=false"] }),
		names.length === 0
			? null
			: runGit(["for-each-ref", "--format=%(refname)%09%(objectname)", ...names.map((name) => `${HEADS}${name}`)], {
					cwd: root,
					deadline,
				}),
	]);
	const sha = head.exitCode === 0 ? head.stdout.trim() : "";
	const symbolicRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : "";
	const tips = new Map<string, string>();
	for (const line of (heads?.stdout ?? "").split("\n")) {
		const [ref = "", tip = ""] = line.trim().split("\t");
		// A pattern also matches refs below it (`x` matches `x/y`), so only exact names count.
		const name = ref.slice(HEADS.length);
		if (ref.startsWith(HEADS) && names.includes(name) && tip.length > 0) tips.set(name, tip);
	}
	return {
		head:
			sha.length === 0
				? null
				: { sha, ...(symbolicRef.startsWith(HEADS) ? { branch: symbolicRef.slice(HEADS.length) } : {}) },
		stash: splitNul(stash.stdout).flatMap((entry) => {
			const tab = entry.indexOf("\t");
			const entrySha = (tab < 0 ? entry : entry.slice(0, tab)).trim();
			return entrySha.length > 0 ? [{ sha: entrySha, message: tab < 0 ? "" : entry.slice(tab + 1) }] : [];
		}),
		branches: tips,
	};
}

/** The pins snapshot `n` of `session` takes for `state`, under `<prefix>/<session>/pins/<n>/`. */
export function snapshotPins(prefix: string, session: string, n: number, state: RefState): SnapshotPin[] {
	const base = `${prefix}/${session}/pins/${n}`;
	const pins: SnapshotPin[] = [];
	if (state.head !== null)
		pins.push({
			kind: "head",
			ref: `${base}/head`,
			sha: state.head.sha,
			...(state.head.branch !== undefined ? { branch: state.head.branch } : {}),
		});
	state.stash.slice(0, STASH_PIN_LIMIT).forEach((entry, index) => {
		pins.push({ kind: "stash", ref: `${base}/stash/${index}`, sha: entry.sha, index, message: entry.message });
	});
	for (const [name, sha] of [...state.branches].sort(([left], [right]) => left.localeCompare(right)))
		pins.push({ kind: "branch", ref: `${base}/branch/${name}`, sha, name });
	return pins;
}

export function pinIdentity(pin: SnapshotPin): string {
	return `${pin.ref} ${pin.sha}`;
}

/**
 * The refs at risk that a record's `held` pins do not cover, named for the
 * operator. `wanted` is what that record would pin for the refs as they
 * stand; with no reading of the refs, every ref at risk counts as unpinned.
 */
export function unpinnedRefs(
	risk: RefsAtRisk | undefined,
	state: RefState | null,
	wanted: ReadonlyArray<SnapshotPin>,
	held: ReadonlyArray<SnapshotPin>,
): string[] {
	if (risk === undefined) return [];
	if (state === null)
		return [
			...(risk.head ? ["HEAD"] : []),
			...(risk.stash ? ["the stash"] : []),
			...risk.branches.map((name) => `branch ${name}`),
		];
	const holds = new Set(held.map(pinIdentity));
	const lost = wanted.filter((pin) => !holds.has(pinIdentity(pin)));
	return [
		...(risk.head && lost.some((pin) => pin.kind === "head") ? ["HEAD"] : []),
		...(risk.stash && lost.some((pin) => pin.kind === "stash") ? ["the stash"] : []),
		...(risk.stash && state.stash.length > STASH_PIN_LIMIT ? [`stash entries after the first ${STASH_PIN_LIMIT}`] : []),
		...lost.flatMap((pin) => (pin.kind === "branch" && risk.branches.includes(pin.name) ? [`branch ${pin.name}`] : [])),
	];
}

/** Local branches whose current tips the rewind preview needs to place each pin. */
export function pinnedBranchNames(pins: ReadonlyArray<SnapshotPin>): string[] {
	return pins.flatMap((pin) =>
		pin.kind === "branch" ? [pin.name] : pin.kind === "head" && pin.branch !== undefined ? [pin.branch] : [],
	);
}

/** Branch names may hold `;`, `$` or quotes, so a shown command quotes any name a shell would split or expand. */
function shellWord(text: string): string {
	return /^[A-Za-z0-9._/@%+=,:-]+$/u.test(text) ? text : shellQuote(text);
}

/** A branch back at `sha`: recreated when gone, moved when it is elsewhere, and reset in place while checked out. */
function branchRecovery(name: string, sha: string, now: RefState | null): Omit<RewindRef, "pin"> {
	const create = `git branch ${shellWord(name)} ${sha}`;
	if (now === null) return { state: "unknown", recover: create };
	const tip = now.branches.get(name);
	if (tip === sha) return { state: "in-place", recover: null };
	if (tip === undefined) return { state: "gone", recover: create };
	// Git refuses to force the checked-out branch; a mixed reset moves it and keeps the restored files.
	return {
		state: "moved",
		recover: now.head?.branch === name ? `git reset ${sha}` : `git branch -f ${shellWord(name)} ${sha}`,
	};
}

function rewindRef(pin: SnapshotPin, now: RefState | null): RewindRef {
	if (pin.kind === "branch") return { pin, ...branchRecovery(pin.name, pin.sha, now) };
	if (pin.kind === "head") {
		if (pin.branch !== undefined) return { pin, ...branchRecovery(pin.branch, pin.sha, now) };
		if (now?.head?.sha === pin.sha) return { pin, state: "in-place", recover: null };
		const detached = now !== null && now.head !== null && now.head.branch === undefined;
		return {
			pin,
			state: now === null ? "unknown" : "moved",
			recover: detached ? `git reset ${pin.sha}` : `git switch --detach ${pin.sha}`,
		};
	}
	if (now?.stash.some((entry) => entry.sha === pin.sha)) return { pin, state: "in-place", recover: null };
	const message = pin.message.length > 0 ? pin.message : `restored stash@{${pin.index}}`;
	return {
		pin,
		state: now === null ? "unknown" : "gone",
		recover: `git stash store -m ${shellQuote(message)} ${pin.sha}`,
	};
}

/**
 * Each pin placed against the refs as they stand, in the order the recovery
 * commands run: HEAD, branches, then stash entries oldest first, because
 * `git stash store` pushes onto the top and that order rebuilds the stack.
 */
export function rewindRefs(pins: ReadonlyArray<SnapshotPin>, now: RefState | null): RewindRef[] {
	const rank = (pin: SnapshotPin): number => (pin.kind === "head" ? 0 : pin.kind === "branch" ? 1 : 2);
	return [...pins]
		.sort(
			(left, right) =>
				rank(left) - rank(right) || (left.kind === "stash" && right.kind === "stash" ? right.index - left.index : 0),
		)
		.map((pin) => rewindRef(pin, now));
}
