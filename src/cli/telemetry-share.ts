import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import type { SegmentHeader } from "../core/telemetry/envelope.js";
import { clioStateDir } from "../core/xdg.js";
import type { SharePlan, ShareProfile, ShareScopeKind, ShareSelection } from "../domains/telemetry/share.js";
import {
	importShareArchive,
	isShareProfile,
	listShareCandidates,
	planShare,
	resolveShareScopes,
	SHARE_PROFILE_NAMES,
	SHARE_PROFILES,
	telemetryInstallId,
	writeShare,
} from "../domains/telemetry/share.js";
import { canSelect, promptMultiSelect, promptSelect } from "./select.js";
import { printError } from "./shared.js";

export const SHARE_HELP = `clio-coder telemetry share [--session <id>]... [--run <id>]... [--repo <path>] [--since <iso>] [--until <iso>]
                           [--profile content-free|structural|research] [--out <file>] [--dry-run]
clio-coder telemetry import <archive>

share packs sealed telemetry scopes into one tar.gz for the maintainer; nothing is
uploaded. Pick sessions, runs, a repository's sessions or a seal-time range; a
session brings the runs it references, and a scope that is live or fails
verification is skipped and named. In a terminal with no scope flags it asks
which scopes and which profile. Profiles:
  content-free  ${SHARE_PROFILES["content-free"].summary} (default)
  structural    ${SHARE_PROFILES.structural.summary}
  research      ${SHARE_PROFILES.research.summary}
Every profile redacts secrets again in every record and object it keeps. Each
scope is resealed with share.sealed over exactly what the archive carries, and
the archive's manifest names the profile, this installation's random install id
and the Clio version, never a hostname or path. It previews scope, record and
object counts and what the profile drops before writing; --dry-run stops there.
--out defaults to a timestamped file in the current directory and is never
overwritten.

import verifies every bundle in an archive as telemetry verify does, then places
the scopes under the state directory's telemetry/imported/<install-id>/,
keeping any scope already there. Read them with --imported <install-id> on the
read commands; they never enter your own totals.
`;

function packageWriter(): SegmentHeader["writer"] {
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	return { clioCoderVersion: pkg.version, piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown" };
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

function tally(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
	return entries.length === 0 ? "none" : entries.map(([name, count]) => `${name} ${count}`).join(", ");
}

function preview(plan: SharePlan): string {
	const lines = [
		`share preview: ${plan.scopes.length} scope(s), profile ${plan.profile}, source ${plan.installId}, Clio ${plan.clioCoderVersion}`,
	];
	const byTier: Record<string, number> = {};
	const byEvent: Record<string, number> = {};
	const dropped = { tier: 0, contentClass: 0, unreadable: 0, seals: 0, objects: 0, missingObjects: 0 };
	let objects = 0;
	let objectBytes = 0;
	let redactions = 0;
	const downgraded: string[] = [];
	for (const scope of plan.scopes) {
		lines.push(
			`  ${scope.kind} ${scope.id}: ${scope.profile}, ${scope.records} record(s), ${scope.objects.length} object(s) (${formatBytes(scope.objectBytes)}), ${scope.redactions} secret(s) redacted`,
		);
		for (const [tier, count] of Object.entries(scope.byTier)) byTier[tier] = (byTier[tier] ?? 0) + count;
		for (const [event, count] of Object.entries(scope.byEvent)) byEvent[event] = (byEvent[event] ?? 0) + count;
		for (const key of Object.keys(dropped) as Array<keyof typeof dropped>) dropped[key] += scope.dropped[key];
		objects += scope.objects.length;
		objectBytes += scope.objectBytes;
		redactions += scope.redactions;
		if (scope.profile !== plan.profile) downgraded.push(`${scope.kind} ${scope.id}`);
	}
	lines.push(`records by tier: ${tally(byTier)}`);
	lines.push(`records by event: ${tally(byEvent)}`);
	lines.push(`objects: ${objects} (${formatBytes(objectBytes)}); secrets redacted: ${redactions}`);
	lines.push(
		`the profile drops: ${dropped.tier} record(s) by tier, ${dropped.contentClass} by content class, ${dropped.unreadable} unreadable line(s), ${dropped.objects} object(s); ${dropped.seals} source seal(s) are replaced by share seals; ${dropped.missingObjects} cited object(s) were already missing`,
	);
	if (downgraded.length > 0)
		lines.push(`captured without research consent, so shared as structural: ${downgraded.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

interface ShareArgs {
	selection: ShareSelection;
	profile: ShareProfile | null;
	out: string | null;
	dryRun: boolean;
}

function parseShare(argv: ReadonlyArray<string>): ShareArgs | string {
	const sessions: string[] = [];
	const runs: string[] = [];
	const single = new Map<string, string>();
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		const value = argv[index + 1];
		if (!arg.startsWith("--")) return `unexpected argument ${arg}`;
		if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
		index += 1;
		if (arg === "--session") sessions.push(value);
		else if (arg === "--run") runs.push(value);
		else if (["--repo", "--since", "--until", "--profile", "--out"].includes(arg) && !single.has(arg))
			single.set(arg, value);
		else return `unknown or repeated flag ${arg}`;
	}
	const profile = single.get("--profile") ?? null;
	if (profile !== null && !isShareProfile(profile)) return `--profile takes ${SHARE_PROFILE_NAMES.join(", ")}`;
	const bound = (flag: string): string | null | Error => {
		const value = single.get(flag);
		if (value === undefined) return null;
		const time = Date.parse(value);
		return Number.isFinite(time) ? new Date(time).toISOString() : new Error(`${flag} is not a timestamp: ${value}`);
	};
	const since = bound("--since");
	const until = bound("--until");
	if (since instanceof Error) return since.message;
	if (until instanceof Error) return until.message;
	const repo = single.get("--repo");
	const out = single.get("--out");
	return {
		selection: { sessions, runs, repo: repo === undefined ? null : resolve(repo), since, until },
		profile,
		out: out === undefined ? null : resolve(out),
		dryRun,
	};
}

function selectsNothing(selection: ShareSelection): boolean {
	return (
		selection.sessions.length === 0 &&
		selection.runs.length === 0 &&
		selection.repo === null &&
		selection.since === null &&
		selection.until === null
	);
}

/** `telemetry share`: exit 0 written or previewed, 1 nothing to share or a failure, 2 on usage errors (#434). */
export async function runTelemetryShare(argv: ReadonlyArray<string>): Promise<number> {
	const args = parseShare(argv);
	if (typeof args === "string") {
		printError(args);
		process.stderr.write(SHARE_HELP);
		return 2;
	}
	const stateDir = clioStateDir();
	const interactive = canSelect();
	let selection = args.selection;
	if (selectsNothing(selection)) {
		if (!interactive) {
			printError("share needs --session, --run, --repo, or --since/--until outside a terminal");
			process.stderr.write(SHARE_HELP);
			return 2;
		}
		const candidates = listShareCandidates(stateDir);
		if (candidates.length === 0) {
			printError("no sealed session or run scope to share");
			return 1;
		}
		const picked = await promptMultiSelect<{ kind: ShareScopeKind; id: string }>({
			heading: "Telemetry scopes to share (a session brings the runs it references)",
			choices: candidates.map(({ kind, id, sealedAt }) => ({
				value: { kind, id },
				label: `${kind} ${id}`,
				hint: sealedAt,
			})),
			searchable: true,
			confirmLabel: "share",
			backLabel: "cancel",
			clearOnExit: true,
		});
		if (picked.kind !== "selected" || picked.values.length === 0) {
			process.stdout.write("nothing shared\n");
			return 1;
		}
		selection = {
			...selection,
			sessions: picked.values.filter((scope) => scope.kind === "session").map((scope) => scope.id),
			runs: picked.values.filter((scope) => scope.kind === "run").map((scope) => scope.id),
		};
	}
	let profile: ShareProfile = args.profile ?? "content-free";
	if (args.profile === null && interactive) {
		const chosen = await promptSelect<ShareProfile>({
			heading: "Share profile",
			choices: SHARE_PROFILE_NAMES.map((name) => ({ value: name, label: name, hint: SHARE_PROFILES[name].summary })),
			backLabel: "cancel",
			clearOnExit: true,
		});
		if (chosen.kind !== "selected") {
			process.stdout.write("nothing shared\n");
			return 1;
		}
		profile = chosen.value;
	}
	try {
		const { scopes, skipped } = resolveShareScopes(stateDir, selection);
		for (const skip of skipped) process.stdout.write(`skipped ${skip.kind} ${skip.id}: ${skip.reason}\n`);
		if (scopes.length === 0) {
			printError("nothing to share: no selected scope is sealed and verified");
			return 1;
		}
		const plan = planShare({
			scopes,
			skipped,
			profile,
			installId: telemetryInstallId(stateDir),
			writer: packageWriter(),
		});
		process.stdout.write(preview(plan));
		if (args.dryRun) {
			process.stdout.write("dry run: nothing written\n");
			return 0;
		}
		const out =
			args.out ?? resolve(`clio-coder-telemetry-${plan.createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`);
		if (interactive) {
			const confirm = await promptSelect<boolean>({
				heading: `Write ${out}?`,
				choices: [
					{ value: true, label: "write the archive" },
					{ value: false, label: "cancel" },
				],
				clearOnExit: true,
			});
			if (confirm.kind !== "selected" || !confirm.value) {
				process.stdout.write("nothing written\n");
				return 1;
			}
		}
		const bytes = await writeShare(plan, out);
		process.stdout.write(`wrote ${out} (${formatBytes(bytes)})\n`);
		return 0;
	} catch (error) {
		printError(`cannot share telemetry: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** `telemetry import <archive>`: exit 0 placed or already present, 1 on a failed verify or a differing scope. */
export async function runTelemetryImport(argv: ReadonlyArray<string>): Promise<number> {
	if (argv.length !== 1 || argv[0]?.startsWith("-")) {
		printError("usage: clio-coder telemetry import <archive>");
		return 2;
	}
	const path = resolve(argv[0] as string);
	try {
		const imported = await importShareArchive(clioStateDir(), await readFile(path));
		for (const scope of imported.placed)
			process.stdout.write(`imported ${scope.kind} ${scope.id} to ${scope.directory}\n`);
		for (const scope of imported.existing)
			process.stdout.write(
				`${scope.identical ? "already imported" : "kept the existing, different"} ${scope.kind} ${scope.id} at ${scope.directory}\n`,
			);
		process.stdout.write(
			`verified ${imported.manifest.scopes.length} scope(s) from ${imported.installId} (${imported.manifest.profile}, Clio ${imported.manifest.clioCoderVersion}); read them with --imported ${imported.installId}\n`,
		);
		return imported.existing.every((scope) => scope.identical) ? 0 : 1;
	} catch (error) {
		printError(`cannot import ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
