/**
 * Arm identity: what was actually built, and whether two arms differ.
 *
 * The point of hashing three things separately rather than one is
 * attribution. `buildHash` answers "are these the same binary"; when they are
 * not, `promptFragmentsHash` and `toolCatalogHash` answer "and was it the
 * prompt or the tool surface that moved". A comparison that cannot say which
 * one changed cannot attribute its own result.
 *
 * The harness refuses two arms that hash identically. That is not pedantry: an
 * A/B where both arms are the same build produces a clean, symmetric, entirely
 * meaningless result, and it is the easiest mistake to make when pointing two
 * checkouts at the same commit.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonicalJson, sha256 } from "../../src/domains/prompts/hash.js";
import type { PromptAbArmConfig } from "./config.js";
import type { PromptAbArmIdentity } from "./contract.js";

export class PromptAbArmError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptAbArmError";
	}
}

/** Source files whose content decides the tool surface a model sees. */
const TOOL_CATALOG_SOURCES = ["src/tools/builtin-tool-catalog.ts", "src/tools/registry.ts"] as const;

const PROMPT_FRAGMENT_ROOT = "src/domains/prompts/fragments";

export interface ResolveArmOptions {
	/** Allow a checkout with uncommitted changes. Off by default: a dirty arm is not reproducible. */
	allowDirty: boolean;
}

export function resolvePromptAbArm(config: PromptAbArmConfig, options: ResolveArmOptions): PromptAbArmIdentity {
	const entry = join(config.checkout, config.entry);
	if (!isFile(entry)) {
		throw new PromptAbArmError(`arm ${config.id}: built entry is missing at ${entry}; build the arm checkout first`);
	}
	const commit = gitOutput(config.checkout, ["rev-parse", "HEAD"]);
	if (config.commit !== null && commit !== null && !commit.startsWith(config.commit)) {
		throw new PromptAbArmError(`arm ${config.id}: checkout is at ${commit}, configuration pins ${config.commit}`);
	}
	const dirty = (gitOutput(config.checkout, ["status", "--porcelain"]) ?? "") !== "";
	if (dirty && !options.allowDirty) {
		throw new PromptAbArmError(`arm ${config.id}: checkout has uncommitted changes; a dirty arm is not reproducible`);
	}
	return {
		id: config.id,
		label: config.label,
		checkout: config.checkout,
		entry,
		commit,
		dirty,
		buildHash: hashTree(join(config.checkout, "dist"), config.checkout),
		promptFragmentsHash: hashTree(join(config.checkout, PROMPT_FRAGMENT_ROOT), config.checkout),
		toolCatalogHash: hashFiles(config.checkout, TOOL_CATALOG_SOURCES),
	};
}

/**
 * Refuse a comparison whose arms are not actually different, and name what is
 * the same. A caller that wants a null-control run passes `allowIdentical`.
 */
export function assertPromptAbArmsDiffer(arms: readonly PromptAbArmIdentity[], allowIdentical: boolean): void {
	if (allowIdentical || arms.length < 2) return;
	const [left, right] = arms as [PromptAbArmIdentity, PromptAbArmIdentity];
	if (left.buildHash !== right.buildHash) return;
	throw new PromptAbArmError(
		`arms ${left.id} and ${right.id} have the same build hash ${left.buildHash.slice(0, 12)}; ` +
			"a prompt A/B needs two independently built trees, or pass --allow-identical-arms for a null control",
	);
}

/** What differs between two arms, for the comparison header and the report. */
export function promptAbArmDelta(
	left: PromptAbArmIdentity,
	right: PromptAbArmIdentity,
): { build: boolean; promptFragments: boolean; toolCatalog: boolean } {
	return {
		build: left.buildHash !== right.buildHash,
		promptFragments: left.promptFragmentsHash !== right.promptFragmentsHash,
		toolCatalog: left.toolCatalogHash !== right.toolCatalogHash,
	};
}

/**
 * Content hash of every file under `root`, keyed by its path relative to the
 * checkout so two checkouts at different absolute paths still hash equal.
 * Paths are sorted, and directory order from the filesystem never enters.
 */
function hashTree(root: string, checkout: string): string {
	const entries: Array<[string, string]> = [];
	const walk = (dir: string): void => {
		let listing: string[];
		try {
			listing = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of listing) {
			const full = join(dir, name);
			const stats = statSync(full, { throwIfNoEntry: false });
			if (stats === undefined) continue;
			if (stats.isDirectory()) {
				walk(full);
				continue;
			}
			// Source maps are build noise: they change with absolute paths and
			// say nothing about what the model sees.
			if (!stats.isFile() || full.endsWith(".map")) continue;
			entries.push([posixRelative(checkout, full), sha256(readFileSync(full, "utf8"))]);
		}
	};
	walk(root);
	entries.sort(([left], [right]) => left.localeCompare(right));
	return sha256(canonicalJson(entries));
}

function hashFiles(checkout: string, relativePaths: readonly string[]): string {
	const entries = relativePaths.map((path): [string, string] => {
		const full = join(checkout, path);
		try {
			return [path, sha256(readFileSync(full, "utf8"))];
		} catch {
			return [path, "absent"];
		}
	});
	return sha256(canonicalJson(entries));
}

function posixRelative(from: string, to: string): string {
	return relative(from, to).split(sep).join("/");
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function gitOutput(cwd: string, args: readonly string[]): string | null {
	const result = spawnSync("git", [...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5_000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	return result.stdout.trim();
}
