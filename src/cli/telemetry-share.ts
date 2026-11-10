import { readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startedUnderClioAgent } from "../core/agent-environment.js";
import { resolvePackageRoot } from "../core/package-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import type { SegmentHeader } from "../core/telemetry/envelope.js";
import { clioStateDir } from "../core/xdg.js";
import {
	consentText,
	deleteShareGist,
	detectTransport,
	findDiscussionCategory,
	newShareId,
	postDiscussion,
	type ReportCommandRunner,
	readShareReceipts,
	reportEnvironment,
	reportsDirectory,
	SHARE_ID,
	SHARE_RETENTION_DAYS,
	sweepShareGists,
	telemetryShareDigest,
	updateShareReceipt,
	uploadShare,
} from "../domains/report/index.js";
import type { SharePlan, ShareProfile, ShareScopeKind, ShareSelection } from "../domains/telemetry/share.js";
import {
	freshShareSource,
	importShareArchive,
	isShareProfile,
	listShareCandidates,
	packShare,
	planShare,
	resolveShareScopes,
	SHARE_PROFILE_NAMES,
	SHARE_PROFILES,
	telemetryShareSource,
	writeShare,
} from "../domains/telemetry/share.js";
import { formatBytes } from "./lifecycle-presenter.js";
import { canSelect, promptMultiSelect, promptSelect } from "./select.js";
import { printError } from "./shared.js";

export const SHARE_HELP = `clio-coder telemetry share [--session <id>]... [--run <id>]... [--process <id>]... [--repo <path>]
                           [--since <iso>] [--until <iso>] [--live]
                           [--profile content-free|report|structural|research] [--out <file>] [--dry-run]
                           [--send --consent debug|dataset [--yes]]
clio-coder telemetry share list
clio-coder telemetry share forget <shareId>
clio-coder telemetry import <archive>

share packs sealed telemetry scopes into one tar.gz for the maintainer; without
--send nothing is uploaded. Pick sessions, runs, a repository's sessions or a seal-time range; a
session brings the runs it references, and a scope that is live or fails
verification is skipped and named. --live shares a named scope that is still
live as a snapshot of what is on disk, without sealing or touching it; a
process scope (boot, health, domain loads, exit) is reachable by --process,
and the running process's own only with --live. In a terminal with no scope
flags it asks which scopes and which profile. Profiles:
  content-free  ${SHARE_PROFILES["content-free"].summary} (default)
  report        ${SHARE_PROFILES.report.summary}
  structural    ${SHARE_PROFILES.structural.summary}
  research      ${SHARE_PROFILES.research.summary}
Every profile redacts secrets again in every record and object it keeps. Each
scope is resealed with share.sealed over exactly what the archive carries, and
the archive's manifest names the profile, this installation's random install id
and the Clio version, never a hostname or path; a report archive gets an install
id and anonymization key of its own, so it links to no other share. It previews
scope, record and object counts and what the profile drops before writing, and
for report every name left readable; --dry-run stops there.
--out defaults to a timestamped file in the current directory and is never
overwritten.

--send shares the archive instead of writing it, only when you run it: it seals the
archive so that only the Clio Coder maintainers can open it, uploads it as a secret
gist in your GitHub account through your own gh, and opens a public discussion in
"Telemetry shares" on iowarp/clio-coder that names the gist and nothing else.
--consent debug lets the maintainers read it to fix Clio; dataset also lets them
publish an anonymized dataset from it. It takes the content-free, structural or
research profile, asks before sending in a terminal and needs --yes outside one,
and is refused in a command a Clio session started. list shows what this machine
shared; forget <shareId> deletes the gist, and Clio deletes it ${SHARE_RETENTION_DAYS} days after
sending.

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
	const dropped = {
		tier: 0,
		contentClass: 0,
		unreadable: 0,
		seals: 0,
		objects: 0,
		missingObjects: 0,
		unlisted: 0,
		projected: 0,
	};
	let objects = 0;
	let objectBytes = 0;
	let redactions = 0;
	const downgraded: string[] = [];
	for (const scope of plan.scopes) {
		const live = scope.snapshotAt === undefined ? "" : `live, snapshot at ${scope.snapshotAt}, `;
		lines.push(
			`  ${scope.kind} ${scope.id}: ${live}${scope.profile}, ${scope.records} record(s), ${scope.objects.length} object(s) (${formatBytes(scope.objectBytes)}), ${scope.redactions} secret(s) redacted`,
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
	lines.push(`archive: ${formatBytes(plan.archiveBytes)} uncompressed`);
	lines.push(
		`the profile drops: ${dropped.tier} record(s) by tier, ${dropped.contentClass} by content class, ${dropped.unreadable} unreadable line(s), ${dropped.unlisted} of an event its projection does not admit, ${dropped.objects} object(s); ${dropped.projected} kept record(s) have prose withheld or identities and paths anonymized; ${dropped.seals} source seal(s) are replaced by share seals; ${dropped.missingObjects} cited object(s) were already missing`,
	);
	if (downgraded.length > 0)
		lines.push(`captured without research consent, so shared as structural: ${downgraded.join(", ")}`);
	if (plan.inventory) {
		const { readable, anonymized, withheld } = plan.inventory;
		const named = (
			[
				["models", readable.model],
				["runtimes", readable.runtime],
				["tools", readable.tool],
				["tokens", readable.token],
			] as const
		)
			.filter(([, values]) => values.length > 0)
			.map(([label, values]) => `${label} ${values.join(", ")}`);
		lines.push(`readable names: ${named.length === 0 ? "none" : named.join("; ")}`);
		const counts = Object.entries(anonymized)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`);
		lines.push(`anonymized: ${counts.length === 0 ? "none" : counts.join(", ")}; withheld: ${withheld} string(s)`);
	}
	return `${lines.join("\n")}\n`;
}

interface ShareArgs {
	selection: ShareSelection;
	profile: ShareProfile | null;
	out: string | null;
	dryRun: boolean;
	send: { consent: ReadonlyArray<"debug" | "dataset">; yes: boolean } | null;
}

const SINGLE_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"--repo",
	"--since",
	"--until",
	"--profile",
	"--out",
	"--consent",
]);

function parseShare(argv: ReadonlyArray<string>): ShareArgs | string {
	const sessions: string[] = [];
	const runs: string[] = [];
	const processes: string[] = [];
	const single = new Map<string, string>();
	let dryRun = false;
	let live = false;
	let send = false;
	let yes = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--send") {
			send = true;
			continue;
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--live") {
			live = true;
			continue;
		}
		const value = argv[index + 1];
		if (!arg.startsWith("--")) return `unexpected argument: ${arg}`;
		if (arg !== "--session" && arg !== "--run" && arg !== "--process" && !SINGLE_VALUE_FLAGS.has(arg))
			return `unknown flag: ${arg}`;
		if (value === undefined || value.startsWith("--")) return `${arg} needs a value`;
		index += 1;
		if (arg === "--session") sessions.push(value);
		else if (arg === "--run") runs.push(value);
		else if (arg === "--process") processes.push(value);
		else if (!single.has(arg)) single.set(arg, value);
		else return `repeated flag ${arg}`;
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
	const consent = single.get("--consent");
	if (!send && (consent !== undefined || yes)) return "--consent and --yes apply only with --send";
	if (send && consent !== "debug" && consent !== "dataset") return "--send needs --consent debug or --consent dataset";
	if (send && out !== undefined) return "--send uploads the archive instead of writing it: drop --out";
	if (send && profile === "report")
		return "--send takes the content-free, structural or research profile; a report profile archive goes with a report";
	return {
		selection: {
			sessions,
			runs,
			processes,
			repo: repo === undefined ? null : resolve(repo),
			since,
			until,
			live: live ? "snapshot" : "refuse",
		},
		profile,
		out: out === undefined ? null : resolve(out),
		dryRun,
		send: send ? { consent: consent === "dataset" ? ["debug", "dataset"] : ["debug"], yes } : null,
	};
}

function selectsNothing(selection: ShareSelection): boolean {
	return (
		selection.sessions.length === 0 &&
		selection.runs.length === 0 &&
		(selection.processes ?? []).length === 0 &&
		selection.repo === null &&
		selection.since === null &&
		selection.until === null
	);
}

/** What `telemetry share` reaches outside itself; tests replace it. */
export interface TelemetryShareDeps {
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	interactive?: boolean;
	findGh?: () => string | null;
	run?: ReportCommandRunner;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	now?: () => Date;
}

interface ShareIo {
	stateDir: string;
	env: NodeJS.ProcessEnv;
	out: (text: string) => void;
	fail: (message: string) => void;
	deps: TelemetryShareDeps;
}

function shareIo(deps: TelemetryShareDeps): ShareIo {
	const stderr = deps.stderr;
	return {
		stateDir: deps.stateDir ?? clioStateDir(),
		env: deps.env ?? process.env,
		out: deps.stdout ?? ((text) => process.stdout.write(text)),
		fail: stderr === undefined ? (message) => printError(message) : (message) => stderr(`error: ${message}\n`),
		deps,
	};
}

async function findGhFor(deps: TelemetryShareDeps): Promise<() => string | null> {
	if (deps.findGh !== undefined) return deps.findGh;
	const { resolveToolBinary } = await import("../domains/toolchain/index.js");
	return () => resolveToolBinary("gh").binaryPath;
}

function ghDeps(io: ShareIo, gh: string) {
	return { gh, env: io.env, ...(io.deps.run !== undefined ? { run: io.deps.run } : {}) };
}

async function sweep(io: ShareIo): Promise<void> {
	await sweepShareGists(io.stateDir, {
		findGh: await findGhFor(io.deps),
		env: io.env,
		...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
		...(io.deps.now !== undefined ? { now: io.deps.now() } : {}),
	});
}

const DISCUSSION_CATEGORY = "Telemetry shares";

/** The public discussion a telemetry share leaves: a plain note and the pointer block the maintainers' intake reads. */
function pointerBody(fields: {
	gistId: string;
	shareId: string;
	version: string;
	consent: string;
	profile: string;
}): string {
	return [
		"An encrypted telemetry share from Clio Coder. Only the Clio Coder maintainers can open it; counts derived from it, never its contents, help rank what to fix next.",
		"",
		`The sender can delete it at any time with \`clio-coder telemetry share forget ${fields.shareId}\`; Clio Coder deletes it ${SHARE_RETENTION_DAYS} days after sending.`,
		"",
		"```clio-coder-share",
		"v: 1",
		`share: gist:${fields.gistId}#${fields.shareId}`,
		"kind: telemetry-share",
		`version: ${fields.version}`,
		`consent: ${fields.consent}`,
		`profile: ${fields.profile}`,
		"```",
		"",
	].join("\n");
}

/** `telemetry share list`: what this machine shared, live or deleted. */
async function listShares(io: ShareIo): Promise<number> {
	await sweep(io);
	const shares = Object.entries(readShareReceipts(io.stateDir)).sort(([, a], [, b]) => a.sentAt.localeCompare(b.sentAt));
	if (shares.length === 0) {
		io.out("no shares sent from this machine\n");
		return 0;
	}
	for (const [shareId, receipt] of shares) {
		const state = receipt.deletedAt === null ? "live" : `deleted ${receipt.deletedAt.slice(0, 10)}`;
		const where = receipt.url ?? (receipt.reportId !== undefined ? `report ${receipt.reportId}` : "");
		io.out(
			`${shareId}  ${receipt.kind}  ${receipt.sentAt.slice(0, 10)}  ${state}  consent ${receipt.consent}  ${receipt.profile}  gist ${receipt.gistId}  ${where}\n`,
		);
	}
	return 0;
}

/** `telemetry share forget <shareId>`: delete the share's gist. The public pointer stays, naming a gist that is gone. */
async function forgetShare(io: ShareIo, shareId: string | undefined): Promise<number> {
	if (shareId === undefined || !SHARE_ID.test(shareId)) {
		io.fail("usage: clio-coder telemetry share forget <shareId> (clio-coder telemetry share list names them)");
		return 2;
	}
	const receipt = readShareReceipts(io.stateDir)[shareId];
	if (receipt === undefined) {
		io.fail(`no share ${shareId} was sent from this machine; clio-coder telemetry share list names them`);
		return 1;
	}
	if (receipt.deletedAt !== null) {
		io.out(`${shareId} was already deleted on ${receipt.deletedAt}\n`);
		return 0;
	}
	const gh = (await findGhFor(io.deps))();
	if (gh === null) {
		io.fail(
			`deleting gist ${receipt.gistId} needs gh, which is not on PATH; or delete it at https://gist.github.com/${receipt.gistId}`,
		);
		return 1;
	}
	const deleted = await deleteShareGist(receipt.gistId, ghDeps(io, gh));
	if ("failed" in deleted) {
		io.fail(`nothing forgotten: ${deleted.failed}`);
		return 1;
	}
	updateShareReceipt(io.stateDir, shareId, { deletedAt: (io.deps.now?.() ?? new Date()).toISOString() });
	io.out(
		`deleted the encrypted share ${shareId} (gist ${receipt.gistId}); the maintainers' counts drop it on their next daily run\n`,
	);
	return 0;
}

/** Seal, upload and point at the archive; any failure after the gist exists deletes it again. */
async function sendShare(
	io: ShareIo,
	plan: SharePlan,
	consent: ReadonlyArray<"debug" | "dataset">,
	gh: string,
	target: Parameters<typeof postDiscussion>[2],
): Promise<number> {
	const deps = ghDeps(io, gh);
	const now = io.deps.now?.() ?? new Date();
	const shareId = newShareId();
	const archive = packShare(plan);
	const digest = telemetryShareDigest(archive, {
		platform: process.platform,
		install: reportEnvironment("headless").install,
		profile: plan.profile,
	});
	const uploaded = await uploadShare(
		io.stateDir,
		{
			kind: "telemetry-share",
			shareId,
			clio: plan.clioCoderVersion,
			consent,
			digest,
			archiveFormat: "clio-coder.telemetry.share",
			archive,
			now,
		},
		deps,
	);
	if ("failed" in uploaded) {
		io.fail(`nothing shared: ${uploaded.failed}`);
		return 1;
	}
	const { gistId } = uploaded;
	const consentLine = consent.join(",");
	// Recorded before posting, so a gist is never left without a receipt that can delete it.
	updateShareReceipt(io.stateDir, shareId, {
		kind: "telemetry-share",
		gistId,
		sentAt: now.toISOString(),
		consent: consentLine,
		profile: plan.profile,
	});
	const bodyPath = join(reportsDirectory(io.stateDir), `${shareId}.discussion.md`);
	safeResourceWrite(
		bodyPath,
		pointerBody({ gistId, shareId, version: plan.clioCoderVersion, consent: consentLine, profile: plan.profile }),
		{ mode: 0o600 },
	);
	let posted: Awaited<ReturnType<typeof postDiscussion>>;
	try {
		posted = await postDiscussion(`Telemetry share ${shareId}`, bodyPath, target, gh, deps);
	} finally {
		rmSync(bodyPath, { force: true });
	}
	if ("failed" in posted) {
		const deleted = await deleteShareGist(gistId, deps);
		if ("failed" in deleted) io.fail(`${deleted.failed}; delete it at https://gist.github.com/${gistId}`);
		else updateShareReceipt(io.stateDir, shareId, { deletedAt: new Date().toISOString() });
		io.fail(`nothing shared: ${posted.failed}`);
		return 1;
	}
	updateShareReceipt(io.stateDir, shareId, { url: posted.url });
	io.out(
		`shared ${shareId}: encrypted in secret gist ${gistId}, announced at ${posted.url}\ndelete it with: clio-coder telemetry share forget ${shareId}\n`,
	);
	return 0;
}

/** `telemetry share`: exit 0 written, sent or previewed, 1 nothing to share or a failure, 2 on usage errors (#434). */
export async function runTelemetryShare(argv: ReadonlyArray<string>, deps: TelemetryShareDeps = {}): Promise<number> {
	const io = shareIo(deps);
	try {
		if (argv[0] === "list" && argv.length === 1) return await listShares(io);
		if (argv[0] === "forget" && argv.length <= 2) return await forgetShare(io, argv[1]);
	} catch (error) {
		io.fail(`cannot ${argv[0]} shares: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const args = parseShare(argv);
	if (typeof args === "string") {
		io.fail(args);
		(deps.stderr ?? ((text) => process.stderr.write(text)))(SHARE_HELP);
		return 2;
	}
	const send = args.send;
	if (send !== null && !args.dryRun && startedUnderClioAgent(io.env)) {
		io.fail("nothing sent: an agent never shares telemetry; run telemetry share --send yourself in your own terminal");
		return 2;
	}
	const stateDir = io.stateDir;
	const interactive = deps.interactive ?? canSelect();
	let selection = args.selection;
	if (selectsNothing(selection)) {
		if (!interactive) {
			io.fail("share needs --session, --run, --process, --repo, or --since/--until outside a terminal");
			(deps.stderr ?? ((text) => process.stderr.write(text)))(SHARE_HELP);
			return 2;
		}
		const candidates = listShareCandidates(stateDir);
		if (candidates.length === 0) {
			io.fail("no sealed session or run scope to share");
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
			io.out("nothing shared\n");
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
			choices: SHARE_PROFILE_NAMES.filter((name) => send === null || name !== "report").map((name) => ({
				value: name,
				label: name,
				hint: SHARE_PROFILES[name].summary,
			})),
			backLabel: "cancel",
			clearOnExit: true,
		});
		if (chosen.kind !== "selected") {
			io.out("nothing shared\n");
			return 1;
		}
		profile = chosen.value;
	}
	try {
		const { scopes, skipped } = resolveShareScopes(stateDir, selection);
		for (const skip of skipped) io.out(`skipped ${skip.kind} ${skip.id}: ${skip.reason}\n`);
		if (scopes.length === 0) {
			io.fail("nothing to share: no selected scope is sealed and verified");
			return 1;
		}
		const plan = planShare({
			scopes,
			skipped,
			profile,
			// A report archive links to no other share; every other profile names this installation (R-16).
			source: profile === "report" ? freshShareSource() : telemetryShareSource(stateDir),
			writer: packageWriter(),
			...(profile === "report" ? { inventory: true as const } : {}),
		});
		io.out(preview(plan));
		if (send !== null) {
			const text = consentText();
			io.out(
				`--send seals this archive so that only the Clio Coder maintainers can open it, uploads it as a secret gist in your GitHub account, and opens a public discussion in "${DISCUSSION_CATEGORY}" on iowarp/clio-coder that names the gist.\nBy sending it you agree to:\n  ${text.debug}\n${send.consent.includes("dataset") ? `  ${text.dataset}\n` : ""}  ${text.share}\n`,
			);
		}
		if (args.dryRun) {
			io.out(send === null ? "dry run: nothing written\n" : "dry run: nothing sent\n");
			return 0;
		}
		if (send !== null) {
			if (!interactive && !send.yes) {
				io.fail("nothing sent: pass --yes to send outside a terminal");
				return 2;
			}
			await sweep(io);
			const findGh = await findGhFor(deps);
			const transport = await detectTransport(io.env, {
				findGh,
				browserAvailable: () => false,
				...(deps.run !== undefined ? { run: deps.run } : {}),
			});
			if (transport.kind !== "gh") {
				io.fail("nothing sent: --send needs gh installed and signed in to github.com (gh auth login)");
				return 1;
			}
			const target = await findDiscussionCategory(DISCUSSION_CATEGORY, transport.path, ghDeps(io, transport.path));
			if (target === null) {
				io.fail(
					`nothing sent: the "${DISCUSSION_CATEGORY}" discussion category on iowarp/clio-coder could not be found; nothing was uploaded`,
				);
				return 1;
			}
			if (interactive) {
				const confirm = await promptSelect<boolean>({
					heading: "Send this encrypted share to the Clio Coder maintainers?",
					choices: [
						{ value: true, label: "send" },
						{ value: false, label: "cancel" },
					],
					clearOnExit: true,
				});
				if (confirm.kind !== "selected" || !confirm.value) {
					io.out("nothing sent\n");
					return 1;
				}
			}
			return await sendShare(io, plan, send.consent, transport.path, target);
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
				io.out("nothing written\n");
				return 1;
			}
		}
		const bytes = await writeShare(plan, out);
		io.out(`wrote ${out} (${formatBytes(bytes)})\n`);
		return 0;
	} catch (error) {
		io.fail(`cannot share telemetry: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

/** `telemetry import <archive>`: exit 0 placed or already present, 1 on a failed verify or a differing or damaged scope. */
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
				scope.damaged !== null
					? `kept the existing ${scope.kind} ${scope.id} at ${scope.directory}, which fails verification: ${scope.damaged}\n`
					: `${scope.identical ? "already imported" : "kept the existing, different"} ${scope.kind} ${scope.id} at ${scope.directory}\n`,
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
