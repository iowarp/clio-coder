import { readFileSync } from "node:fs";
import { startedUnderClioAgent } from "../core/agent-environment.js";
import { editTextExternally, resolveExternalEditor } from "../core/external-editor.js";
import { canOpenBrowser, openBrowser } from "../core/open-browser.js";
import { clioStateDir } from "../core/xdg.js";
import {
	applyReportEdit,
	type BuiltBundle,
	checkLastAttempt,
	composeReportDraft,
	type DuplicateChoice,
	deleteShareGist,
	detectTransport,
	forgetReport,
	type IdentitySettings,
	type LocalIdentity,
	localIdentity,
	newShareId,
	observeSession,
	outboxEntry,
	planHeadline,
	planReport,
	REPORT_BUNDLE_FORMAT,
	REPORT_ID,
	REPORT_THANKS,
	type ReportCommandRunner,
	type ReportDraft,
	type ReportKind,
	type ReportPlan,
	type ReportPlanTransport,
	type ReportShareHook,
	type ReportSharePointer,
	type ReportTransport,
	readReportDraft,
	refreshReportStatus,
	relatedLine,
	rememberIdentity,
	reportBundleDigest,
	reportBundlePath,
	reportEditTemplate,
	reportMarkdownPath,
	reportRows,
	reportShare,
	routeFor,
	runReportSend,
	SHARE_RETENTION_DAYS,
	saveBuiltBundle,
	saveReportDraft,
	sentLine,
	sweepReportBundles,
	sweepShareGists,
	updateOutbox,
	updateShareReceipt,
	uploadShare,
} from "../domains/report/index.js";
import {
	attachBundle,
	type BundleRequest,
	bundleRequest,
	consentSentences,
	formatBundleSummary,
	printReportBundle,
	type ReportBundleIo,
	runReportSelftest,
} from "./report-bundle.js";
import { canSelect, promptSelect } from "./select.js";

export const REPORT_HELP = `clio-coder report [bug|feature|question] [--title <t>] [--body-file <f> | -] [--session <id> | --last]
                  [--bundle none|mechanics [--consent debug|dataset] [--transcript [N]] [--with-tool-output]
                  [--anonymize-models] [--share]] [--credit] [--dry-run] [--yes] [--json]
                  [--on-duplicate comment|new|stop]
                  [--reply-check]
clio-coder report status [--json]          clio-coder report show <id> [--bundle]
clio-coder report send <id> [--yes] [--reply-check]
clio-coder report forget <id>
clio-coder report selftest [--session <id>] [--transcript [N]] [--with-tool-output] [--anonymize-models]
clio-coder report security

report files a bug, a feature request or a question with Clio Coder's maintainers
at github.com/iowarp/clio-coder. It always prints the exact title and body first,
with what Clio masked, and the numbered list of what sending will do. Nothing is
sent until you choose send in a terminal or pass --yes.
--body-file (or - for stdin) supplies "What happened"; in a terminal without it,
$EDITOR opens a template. --last uses the newest session in this directory and
--session a named one, to add what Clio observed. --dry-run stops after the
preview and makes no network call. When the search finds an open report of the
same problem, or a fixed one this would be a regression of, a terminal asks; with
--yes, --on-duplicate decides (default stop: an unattended script never comments
on someone's issue or files a regression). --reply-check lets an attended session
check the filed issue once a day for a maintainer's reply (off unless asked).
status asks GitHub, through your gh, where each open report stands.
Security problems go to a private advisory: clio-coder report security.
--bundle mechanics builds a diagnostic bundle of the session's telemetry and needs
--consent: debug lets the maintainers read it to fix this report; dataset also lets
its mechanics go into public datasets. The consent text prints with the bundle, and
the bundle is kept only once you send or save the report.
--transcript adds the last N turns (3, at most 10) scrubbed and without thinking;
tool arguments and output stay out unless --with-tool-output. The bundle stays on
this machine: show <id> --bundle prints every byte of it and forget deletes it,
also after the report was sent.
--share uploads the bundle too, encrypted so only the maintainers can open it, as a
secret gist in your own GitHub account through gh; the report names that gist.
forget or github.com deletes the gist any time; once it is ${SHARE_RETENTION_DAYS} days old, the next
report or telemetry share run deletes it. Only a report
composed and sent with --share shares; report send <id> never does.
selftest builds that bundle for the newest session here, writes nothing, and
says whether any of this machine's identifiers survived into it.
Exit codes: 0 sent, opened, written or previewed; 1 on a send failure or a refused
bundle; 2 on a usage error or a call outside a terminal without --yes; 3 when a
likely duplicate or a newer release stopped it and the draft was saved.
`;

/** Everything that reaches outside the process, injectable so a test never runs `gh` or opens a browser. */
export interface ReportCliDeps {
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	browserAvailable?: (env: NodeJS.ProcessEnv) => boolean;
	open?: (url: string) => boolean;
	env?: NodeJS.ProcessEnv;
	interactive?: boolean;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
	readStdin?: () => string;
	cwd?: string;
	stateDir?: string;
	identitySettings?: IdentitySettings;
	changelog?: string | null;
	now?: () => Date;
}

interface ComposeArgs {
	verb: "compose";
	kind: ReportKind;
	title: string | null;
	bodyFile: string | null;
	session: string | null;
	last: boolean;
	credit: boolean;
	dryRun: boolean;
	yes: boolean;
	json: boolean;
	onDuplicate: DuplicateChoice | null;
	bundle: BundleRequest | null;
	share: boolean;
	replyCheck: boolean;
}

type ReportArgs =
	| ComposeArgs
	| { verb: "status"; json: boolean }
	| { verb: "show"; id: string; bundle: boolean }
	| {
			verb: "send";
			id: string;
			yes: boolean;
			dryRun: boolean;
			json: boolean;
			onDuplicate: DuplicateChoice | null;
			replyCheck: boolean;
	  }
	| { verb: "forget"; id: string }
	| { verb: "selftest"; session: string | null; request: BundleRequest }
	| { verb: "security" }
	| { verb: "help" };

const KINDS: ReadonlyArray<ReportKind> = ["bug", "feature", "question"];
const DUPLICATE_CHOICES: ReadonlyArray<DuplicateChoice> = ["comment", "new", "stop"];
const VALUE_FLAGS = new Set(["--title", "--body-file", "--session", "--bundle", "--consent", "--on-duplicate"]);
/** Flags whose value may be left out: `show <id> --bundle` and a bare `--transcript` (3 turns). */
const OPTIONAL_VALUE = new Map([
	["--bundle", (next: string) => !next.startsWith("-")],
	["--transcript", (next: string) => /^[0-9]+$/u.test(next)],
]);
const BOOLEAN_FLAGS = [
	"--last",
	"--credit",
	"--dry-run",
	"--yes",
	"--json",
	"--with-tool-output",
	"--anonymize-models",
	"--reply-check",
	"--share",
];

function parseReport(argv: ReadonlyArray<string>): ReportArgs | string {
	if (argv.includes("--help") || argv.includes("-h")) return { verb: "help" };
	const positionals: string[] = [];
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		if (arg === "-") {
			if (values.has("--body-file")) return "--body-file was given twice";
			values.set("--body-file", "-");
		} else if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq > 0 ? arg.slice(0, eq) : arg;
			const optional = OPTIONAL_VALUE.get(name);
			if (optional !== undefined && eq < 0) {
				const next = argv[i + 1];
				if (values.has(name)) return `${name} was given twice`;
				values.set(name, next !== undefined && optional(next) ? (argv[++i] ?? "") : "");
			} else if (VALUE_FLAGS.has(name) || optional !== undefined) {
				const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
				if (value === undefined || value === "") return `${name} needs a value`;
				if (values.has(name)) return `${name} was given twice`;
				values.set(name, value);
			} else if (BOOLEAN_FLAGS.includes(name) && eq < 0) flags.add(name);
			else return `unknown option ${arg}`;
		} else positionals.push(arg);
	}
	const bundle = values.get("--bundle");
	// selftest writes nothing and keeps no consent, so only a kept bundle needs --consent named.
	const request = (bundleFlag: string | undefined, requireConsent = bundleFlag !== undefined) =>
		bundleRequest({
			bundle: bundleFlag,
			consent: values.get("--consent"),
			transcript: values.get("--transcript"),
			withToolOutput: flags.has("--with-tool-output"),
			anonymizeModels: flags.has("--anonymize-models"),
			requireConsent,
		});
	const onDuplicateValue = values.get("--on-duplicate");
	if (onDuplicateValue !== undefined && !(DUPLICATE_CHOICES as ReadonlyArray<string>).includes(onDuplicateValue))
		return `--on-duplicate takes comment, new or stop, not ${onDuplicateValue}`;
	const onDuplicate = (onDuplicateValue ?? null) as DuplicateChoice | null;

	const [verb, ...rest] = positionals;
	const allow = (verbName: string, allowed: ReadonlyArray<string>): string | null => {
		const used = [...flags, ...values.keys()].filter((flag) => !allowed.includes(flag) && flag !== "--bundle");
		return used.length > 0 ? `${used[0]} does not apply to report ${verbName}` : null;
	};
	const idOf = (verbName: string): string | { error: string } => {
		const id = rest[0];
		if (id === undefined || rest.length > 1) return { error: `usage: clio-coder report ${verbName} <id>` };
		if (!REPORT_ID.test(id)) return { error: `not a report id: ${id} (they look like rpt_ and 26 letters and digits)` };
		return id;
	};
	switch (verb) {
		case "status":
			if (rest.length > 0) return "usage: clio-coder report status [--json]";
			return allow("status", ["--json"]) ?? { verb: "status", json: flags.has("--json") };
		case "show": {
			const id = idOf("show");
			if (typeof id !== "string") return id.error;
			if (bundle !== undefined && bundle !== "") return "report show takes a bare --bundle";
			return allow("show", []) ?? { verb: "show", id, bundle: bundle !== undefined };
		}
		case "send": {
			const id = idOf("send");
			if (typeof id !== "string") return id.error;
			return (
				allow("send", ["--yes", "--dry-run", "--json", "--on-duplicate", "--reply-check"]) ?? {
					verb: "send",
					id,
					yes: flags.has("--yes"),
					dryRun: flags.has("--dry-run"),
					json: flags.has("--json"),
					onDuplicate,
					replyCheck: flags.has("--reply-check"),
				}
			);
		}
		case "forget": {
			const id = idOf("forget");
			if (typeof id !== "string") return id.error;
			return allow("forget", []) ?? { verb: "forget", id };
		}
		case "selftest": {
			if (rest.length > 0) return "usage: clio-coder report selftest [--session <id>]";
			if (bundle !== undefined) return "--bundle does not apply to report selftest; it always builds one";
			const used = allow("selftest", [
				"--session",
				"--consent",
				"--transcript",
				"--with-tool-output",
				"--anonymize-models",
			]);
			if (used !== null) return used;
			const selftest = request("mechanics", false);
			if (typeof selftest === "string") return selftest;
			return { verb: "selftest", session: values.get("--session") ?? null, request: selftest as BundleRequest };
		}
		case "security":
			if (rest.length > 0) return "usage: clio-coder report security";
			return allow("security", []) ?? { verb: "security" };
	}
	if (verb !== undefined && !(KINDS as ReadonlyArray<string>).includes(verb))
		return `unknown report kind or verb: ${verb}`;
	if (rest.length > 0) return `unexpected argument: ${rest[0]} (quote the title and pass it with --title)`;
	if (values.has("--session") && flags.has("--last")) return "--session and --last cannot be combined";
	const attach = request(bundle);
	if (typeof attach === "string") return attach;
	if (attach !== null && !values.has("--session") && !flags.has("--last"))
		return "--bundle mechanics bundles a session: pass --last or --session <id>";
	if (flags.has("--share") && attach === null)
		return "--share shares the diagnostic bundle: pass --bundle mechanics --consent debug|dataset";
	return {
		verb: "compose",
		kind: (verb ?? "bug") as ReportKind,
		title: values.get("--title") ?? null,
		bodyFile: values.get("--body-file") ?? null,
		session: values.get("--session") ?? null,
		last: flags.has("--last"),
		credit: flags.has("--credit"),
		dryRun: flags.has("--dry-run"),
		yes: flags.has("--yes"),
		json: flags.has("--json"),
		onDuplicate,
		bundle: attach,
		share: flags.has("--share"),
		replyCheck: flags.has("--reply-check"),
	};
}

interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
	interactive: boolean;
	env: NodeJS.ProcessEnv;
	stateDir: string;
	cwd: string;
	deps: ReportCliDeps;
}

/** An Enter typed while gh was being asked must not send: the prompt ignores keys for this long after it appears. */
const REPORT_PROMPT_SETTLE_MS = 400;

function fail(io: Io, message: string): void {
	io.err(`error: ${message}\n`);
}

const RULE = (label: string) => `----- ${label} -----\n`;

/** The plain preview: destination, title, the body byte for byte between two rules, masks, actions and gates. */
function formatReportPreview(plan: ReportPlan, bundled: boolean, id: string): string {
	const lines = [
		`${planHeadline(plan)}; nothing sent yet`,
		"",
		RULE("title"),
		`${plan.rendered.title}\n`,
		RULE("body, exactly as it will be sent"),
	];
	const after = [
		RULE("end of body"),
		plan.maskSummary,
		plan.bundle !== null
			? `The diagnostic bundle is uploaded encrypted to the Clio Coder maintainers, as a secret gist in your GitHub account that the report names. Only the maintainers can open it. clio-coder report forget ${id} or github.com deletes the gist any time; once it is ${SHARE_RETENTION_DAYS} days old, Clio deletes it the next time you run clio-coder report or clio-coder telemetry share.`
			: bundled
				? "The diagnostic bundle stays on this machine; sending does not upload it."
				: "No diagnostic bundle is attached.",
		...(plan.credit ? ["Credit: the report block asks for credit in the release notes (credit: yes)."] : []),
		"",
		"Sending will, in this order:",
		...plan.actions.map((action, index) => `  ${index + 1}. ${action}`),
		...(plan.rateWarning !== null ? ["", plan.rateWarning] : []),
		...(plan.gates.length > 0 ? ["", "Cannot send yet:", ...plan.gates.map((gate) => `  - ${gate}`)] : []),
	];
	return `${lines.join("\n")}${plan.rendered.body}${after.join("\n")}\n`;
}

/** The transport a dry run names without asking GitHub anything: a `gh` on PATH, else a browser, else a file. */
function offlineTransport(io: Io, findGh: () => string | null): ReportPlanTransport {
	if (findGh() !== null) return { kind: "gh", login: null };
	return (io.deps.browserAvailable ?? canOpenBrowser)(io.env) ? { kind: "browser" } : { kind: "file" };
}

async function loadFindGh(deps: ReportCliDeps): Promise<() => string | null> {
	if (deps.findGh !== undefined) return deps.findGh;
	const { resolveToolBinary } = await import("../domains/toolchain/index.js");
	return () => resolveToolBinary("gh").binaryPath;
}

async function identityFor(io: Io): Promise<LocalIdentity> {
	let settings = io.deps.identitySettings;
	if (settings === undefined) {
		try {
			const { readSettings } = await import("../core/config.js");
			settings = { targets: readSettings().targets };
		} catch {
			// Unreadable settings mask no target names; every other identity value still applies.
			settings = {};
		}
	}
	return localIdentity(io.cwd, settings, {
		...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
		env: io.env,
	});
}

function readBody(io: Io, path: string): string {
	if (path === "-") return io.deps.readStdin !== undefined ? io.deps.readStdin() : readFileSync(0, "utf8");
	return readFileSync(path, "utf8");
}

async function sessionFor(
	args: ComposeArgs,
	io: Io,
): Promise<{ id: string; observations: ReturnType<typeof observeSession>; facts: { model?: string } } | null | string> {
	if (!args.last && args.session === null) return null;
	const { listSessionsForCwd } = await import("../domains/session/history.js");
	const metas = listSessionsForCwd(io.cwd);
	const meta = args.last ? metas[0] : metas.find((candidate) => candidate.id === args.session);
	const id = args.last ? meta?.id : (args.session ?? undefined);
	if (id === undefined) return "no session in this directory; start one or pass --session <id>";
	const observations = observeSession(io.stateDir, id);
	if (observations.length === 0 && meta === undefined) return `no session ${id} in this directory`;
	return { id, observations, facts: meta?.model ? { model: meta.model } : {} };
}

function editDraft(draft: ReportDraft, io: Io): ReportDraft | string {
	const edited = editTextExternally(reportEditTemplate(draft), resolveExternalEditor(io.env));
	if (!edited.ok || edited.text === undefined) return edited.error ?? "the editor did not return the text";
	return applyReportEdit(draft, edited.text);
}

function saveDraft(io: Io, draft: ReportDraft, title: string): void {
	saveReportDraft(io.stateDir, draft);
	// A `sending` entry stays so: its last create may have filed, and the next send checks for it first.
	const state = outboxEntry(io.stateDir, draft.id)?.state === "sending" ? "sending" : "draft";
	updateOutbox(io.stateDir, draft.id, { kind: draft.kind, title, state });
}

async function confirmAndSend(
	initial: ReportDraft,
	io: Io,
	options: {
		dryRun: boolean;
		yes: boolean;
		json: boolean;
		onDuplicate: DuplicateChoice | null;
		replyCheck: boolean;
		/** A bundle built for this report and not yet kept. */
		bundle?: BuiltBundle | null;
		/** Share that bundle encrypted to the maintainers when the report goes out through gh. */
		share?: boolean;
	},
): Promise<number> {
	// R-12 promises the agent drafts but never sends: a bash call has no terminal, and --yes skips the review the
	// footer claims, so an agent's draft goes only through the interactive review. Refused before gh is asked anything.
	// A command a Clio session's bash ran is the agent's at yolo too, where no autonomy ceiling marks it.
	const fromSession = startedUnderClioAgent(io.env);
	if (
		!options.dryRun &&
		(initial.origin === "agent" || fromSession) &&
		(options.yes || !io.interactive || options.json)
	) {
		// Kept as the agent's, so the operator's own send of it opens the review.
		if (fromSession && readReportDraft(io.stateDir, initial.id) === null)
			saveDraft(io, { ...initial, origin: "agent" }, initial.title);
		io.err(
			`nothing sent: an agent's draft is reviewed in a terminal: run \`clio-coder report send ${initial.id}\` yourself\n`,
		);
		return 2;
	}
	// Set only in a command a Clio session's bash started below yolo; --yes there would send text nobody reviewed.
	const ceiling = io.env.CLIO_CODER_AUTONOMY_CEILING;
	if (!options.dryRun && options.yes && ceiling !== undefined && ceiling !== "") {
		io.err("nothing sent: --yes is refused in a command a Clio session started; send it from your own terminal\n");
		return 2;
	}
	const pending = options.bundle ?? null;
	const keepBundle = () => {
		if (pending !== null) saveBuiltBundle(io.stateDir, draft, pending, io.deps.now?.() ?? new Date());
	};
	const identity = await identityFor(io);
	let transport: ReportTransport | null = null;
	let planTransport: ReportPlanTransport;
	const findGh = await loadFindGh(io.deps);
	if (options.dryRun) planTransport = offlineTransport(io, findGh);
	else {
		transport = await detectTransport(io.env, {
			findGh,
			...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
			...(io.deps.browserAvailable !== undefined ? { browserAvailable: io.deps.browserAvailable } : {}),
		});
		planTransport = transport;
	}
	if (transport?.kind === "gh" && outboxEntry(io.stateDir, initial.id)?.state === "sending") {
		const last = await checkLastAttempt(initial.id, transport, {
			stateDir: io.stateDir,
			env: io.env,
			...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
			...(io.deps.now !== undefined ? { now: io.deps.now } : {}),
		});
		if (last.status === "unknown") {
			fail(io, `nothing sent: ${last.reason}`);
			return 1;
		}
		if (last.status === "filed") {
			if (options.json)
				io.out(
					`${JSON.stringify({ result: { status: "sent", url: last.url, number: last.number, adopted: true } }, null, 2)}\n`,
				);
			else io.out(`${initial.id} was filed by its last attempt: ${last.url}\n`);
			return 0;
		}
		if (!options.json) io.out(`GitHub has nothing from the last attempt to send ${initial.id}; it is a draft again.\n`);
	}
	const interactive = io.interactive && !options.json;
	let draft = rememberIdentity(initial, identity);
	// Only the prompt below is a review; --yes sends what the preview printed without one.
	const reviewed = !options.yes;
	// The share id is fixed now so the preview names it; the gist id exists only once sending uploads it.
	const shareId = options.share === true && pending !== null ? newShareId() : null;
	const sharing = shareId !== null && planTransport.kind === "gh";
	if (shareId !== null && !sharing && !options.json)
		io.err("not shared: --share needs an authenticated gh; the bundle stays on this machine.\n");
	const consent: ReportSharePointer["consent"] =
		pending?.summary.scopesGranted.includes("dataset") === true ? "debug,dataset" : "debug";
	const preview = sharing ? { share: { bundle: `gist:<created on send>#${shareId}`, consent } } : {};
	let plan = planReport(draft, { identity, transport: planTransport, stateDir: io.stateDir, reviewed, ...preview });
	const emit = (result?: unknown) =>
		io.out(
			`${JSON.stringify(
				{
					draft,
					rendered: plan.rendered,
					transport: planTransport,
					plan,
					...(pending !== null ? { bundle: bundleJson(pending) } : {}),
					...(result !== undefined ? { result } : {}),
				},
				null,
				2,
			)}\n`,
		);
	const bundled = pending !== null || Boolean(outboxEntry(io.stateDir, draft.id)?.bundle);
	if (!options.json) io.out(formatReportPreview(plan, bundled, draft.id));
	if (options.dryRun) {
		if (options.json) emit();
		else io.out("dry run: nothing sent\n");
		return 0;
	}
	if (!options.yes && !interactive) {
		if (options.json) emit();
		io.err("nothing sent: add --yes to send this report\n");
		return 2;
	}
	if (plan.gates.length > 0 && (options.yes || !interactive)) {
		if (options.json) emit();
		io.err('nothing sent: fix what the preview lists under "Cannot send yet"\n');
		return 2;
	}
	if (!options.yes) {
		for (;;) {
			const sendable = plan.gates.length === 0;
			const choice = await promptSelect<"send" | "edit" | "save" | "cancel">({
				heading: sendable ? "Send this report?" : "This report cannot be sent yet",
				choices: [
					...(sendable ? [{ value: "send" as const, label: "send", hint: plan.actions.join("; ") }] : []),
					{ value: "edit", label: "edit", hint: "open the text in $EDITOR" },
					{ value: "save", label: "save as draft", hint: "keep it; clio-coder report send <id> later" },
					{ value: "cancel", label: "cancel", hint: "keep the draft, send nothing" },
				],
				backLabel: "cancel",
				clearOnExit: true,
				settleMs: REPORT_PROMPT_SETTLE_MS,
			});
			const picked = choice.kind === "selected" ? choice.value : "cancel";
			if (picked === "send") break;
			if (picked === "edit") {
				const edited = editDraft(draft, io);
				if (typeof edited === "string") io.err(`${edited}\n`);
				else {
					const before = plan.masks.reduce((sum, mask) => sum + mask.count, 0);
					draft = edited;
					plan = planReport(draft, {
						identity,
						transport: planTransport,
						stateDir: io.stateDir,
						reviewed,
						...preview,
					});
					io.out(formatReportPreview(plan, bundled, draft.id));
					const added = plan.masks.reduce((sum, mask) => sum + mask.count, 0) - before;
					if (added > 0) io.out(`Clio masked ${added} more value${added === 1 ? "" : "s"} in your edit.\n`);
				}
				continue;
			}
			keepBundle();
			saveDraft(io, draft, plan.rendered.title);
			io.out(`nothing sent; saved as draft ${draft.id}. clio-coder report send ${draft.id} sends it later.\n`);
			if (sharing) io.out("The bundle was not shared; report send <id> sends the report without sharing it.\n");
			return 0;
		}
	}
	if (transport === null) return 2;
	keepBundle();
	if (plan.rateWarning !== null && !options.json) io.err(`${plan.rateWarning}\n`);
	const share =
		sharing && transport.kind === "gh" && pending !== null
			? shareHook(io, transport.path, shareId, consent, pending)
			: null;
	const outcome = await runReportSend(draft, plan.rendered, {
		...(share !== null ? { share } : {}),
		stateDir: io.stateDir,
		identity,
		transport,
		...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
		env: io.env,
		...(io.deps.open !== undefined ? { open: io.deps.open } : {}),
		...(io.deps.now !== undefined ? { now: io.deps.now } : {}),
		replyCheck: options.replyCheck,
		reviewed,
		related: {
			...(io.deps.changelog !== undefined ? { changelog: io.deps.changelog } : {}),
			...(io.deps.now !== undefined ? { now: io.deps.now } : {}),
		},
		chooseDuplicate: async (verdict, choices) => {
			if (!options.json) {
				io.out(`\nThis may already be reported:\n  ${"issue" in verdict ? relatedLine(verdict.issue) : ""}\n`);
				if (verdict.kind === "upgrade")
					io.out(
						`  You are on ${verdict.installed}; the latest is ${verdict.latest}. clio-coder upgrade first may fix it.\n`,
					);
			}
			const allowed = choices.map((choice) => choice.value);
			if (options.yes && options.onDuplicate !== null)
				return allowed.includes(options.onDuplicate) ? options.onDuplicate : "stop";
			if (!interactive) return "stop";
			const picked = await promptSelect<DuplicateChoice>({
				heading: "What should Clio do?",
				choices: choices.map((choice) => ({ value: choice.value, label: choice.label })),
				backLabel: "cancel",
				clearOnExit: true,
				settleMs: REPORT_PROMPT_SETTLE_MS,
			});
			return picked.kind === "selected" ? picked.value : "stop";
		},
	});
	if (outcome.kind === "stopped") {
		if (options.json) emit({ status: "stopped", verdict: outcome.verdict });
		else
			io.out(
				`nothing sent; saved as draft ${outcome.draft.id}. Pass --on-duplicate comment or new with --yes, or run clio-coder report send ${outcome.draft.id} in a terminal.\n`,
			);
		return 3;
	}
	// The rendered text also changes when a share's pointer is filled in; only new links are news.
	const relinked = outcome.draft.links.join() !== draft.links.join();
	draft = outcome.draft;
	if (relinked && !options.json)
		io.out(`The report now links #${outcome.draft.links.join(", #")}; its title is: ${outcome.rendered.title}\n`);
	if (options.json) {
		plan = { ...plan, rendered: outcome.rendered };
		emit(outcome.result);
		if (outcome.notShared !== undefined) io.err(`${outcome.notShared}\n`);
	} else {
		io.out(`${sentLine(outcome.result)}\n`);
		if (outcome.notShared !== undefined) io.out(`${outcome.notShared}\n`);
		if (outcome.shared !== undefined)
			io.out(
				`Shared the bundle encrypted as secret gist ${outcome.shared.gistId} (${outcome.shared.shareId}). clio-coder report forget ${draft.id} deletes it.\n`,
			);
		if (outcome.result.status !== "failed")
			io.out(`${REPORT_THANKS}\nclio-coder report status shows it; nothing more is sent without you.\n`);
	}
	if (outcome.result.status === "failed") {
		if (!options.json) fail(io, outcome.result.reason);
		return 1;
	}
	return 0;
}

async function compose(args: ComposeArgs, io: Io): Promise<number> {
	const session = await sessionFor(args, io);
	if (typeof session === "string") {
		fail(io, session);
		return 1;
	}
	let happened = "";
	let openEditor = false;
	if (args.bodyFile !== null) {
		try {
			happened = readBody(io, args.bodyFile);
		} catch (error) {
			fail(io, `cannot read ${args.bodyFile}: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
	} else openEditor = io.interactive && !args.json && !args.dryRun;
	let draft = composeReportDraft({
		kind: args.kind,
		surface: "headless",
		...(args.title !== null ? { title: args.title } : {}),
		happened,
		session,
	});
	if (args.credit) draft = { ...draft, credit: true };
	if (openEditor) {
		const edited = editDraft(draft, io);
		if (typeof edited === "string") {
			fail(io, `${edited}; pass --body-file <file> instead`);
			return 2;
		}
		draft = edited;
	}
	let bundle: BuiltBundle | null = null;
	if (args.bundle !== null) {
		// Built in memory: it is written, and its consent recorded, only once the reporter sends or saves the report.
		const built = await attachBundle(bundleIo(io), draft, args.bundle, { write: false });
		if (typeof built === "string") {
			fail(io, `no bundle was built: ${built}`);
			return 1;
		}
		(args.json ? io.err : io.out)(
			`${formatBundleSummary(built, args.dryRun ? null : reportBundlePath(io.stateDir, draft.id), args.share)}\n`,
		);
		bundle = built;
	}
	return confirmAndSend(draft, io, { ...args, bundle });
}

/** Uploads the built bundle sealed to the maintainers through the reporter's own gh, and deletes it again if asked. */
function shareHook(
	io: Io,
	gh: string,
	shareId: string,
	consent: ReportSharePointer["consent"],
	built: BuiltBundle,
): ReportShareHook {
	const deps = { gh, env: io.env, ...(io.deps.run !== undefined ? { run: io.deps.run } : {}) };
	return {
		shareId,
		consent,
		upload: () =>
			uploadShare(
				io.stateDir,
				{
					kind: "report-bundle",
					shareId,
					clio: built.envelope.environment.clioCoder,
					consent: built.summary.scopesGranted,
					digest: reportBundleDigest(built.bytes),
					archiveFormat: REPORT_BUNDLE_FORMAT,
					archive: built.bytes,
					...(io.deps.now !== undefined ? { now: io.deps.now() } : {}),
				},
				deps,
			),
		abandon: async (gistId) => {
			const deleted = await deleteShareGist(gistId, deps);
			if (!("failed" in deleted)) return true;
			io.err(`${deleted.failed}; delete it at https://gist.github.com/${gistId} or with clio-coder report forget\n`);
			return false;
		},
	};
}

/** The bundle in `--json`: what it holds and the consent text the reporter agreed to, sentence by sentence. */
function bundleJson(built: BuiltBundle) {
	return {
		sha256: built.sha256,
		bytes: built.summary.bytes,
		scopes: built.summary.scopesGranted,
		content: built.summary.content,
		consent: { textVersion: built.envelope.consent.textVersion, sentences: consentSentences(built) },
	};
}

function bundleIo(io: Io): ReportBundleIo {
	return {
		out: io.out,
		err: io.err,
		stateDir: io.stateDir,
		cwd: io.cwd,
		identity: () => identityFor(io),
		...(io.deps.now !== undefined ? { now: io.deps.now } : {}),
	};
}

async function status(io: Io, json: boolean): Promise<number> {
	const gh = await refreshReportStatus(io.stateDir, {
		findGh: await loadFindGh(io.deps),
		...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
		env: io.env,
		...(io.deps.now !== undefined ? { now: io.deps.now } : {}),
	});
	const rows = reportRows(io.stateDir);
	if (json) {
		io.out(`${JSON.stringify({ reports: rows }, null, 2)}\n`);
		return 0;
	}
	if (rows.length === 0) {
		io.out("no reports yet; clio-coder report bug starts one\n");
		return 0;
	}
	for (const row of rows) {
		io.out(`${row.id}  ${row.state.padEnd(9)}  ${row.kind.padEnd(8)}  ${row.title}${row.url ? `  ${row.url}` : ""}\n`);
		const facts = [
			row.bundle ? `bundle, consent ${row.consent}` : "no bundle",
			`credit ${row.credit ? "yes" : "no"}`,
			...(row.state === "sent" ? [`reply check ${row.replyCheck ? "on" : "off"}`] : []),
			...(row.lastSeen !== null ? [`GitHub: ${row.lastSeen}`] : []),
		];
		io.out(`    ${facts.join(" · ")}\n`);
	}
	if (!gh && rows.some((row) => row.state === "sent"))
		io.out("gh is not on this machine, so this is the state stored when each report was sent.\n");
	return 0;
}

/** The body file written when the report went out; null when it is gone. */
function readSentBody(stateDir: string, id: string): string | null {
	try {
		return readFileSync(reportMarkdownPath(stateDir, id), "utf8");
	} catch {
		// Without the file, show renders the draft and does not call it the body as sent.
		return null;
	}
}

async function show(io: Io, id: string, bundle: boolean): Promise<number> {
	const entry = outboxEntry(io.stateDir, id);
	const draft = readReportDraft(io.stateDir, id);
	if (entry === null && draft === null) {
		fail(io, `no report ${id}; clio-coder report status lists them`);
		return 1;
	}
	if (entry !== null) io.out(`${id}  ${entry.state}${entry.url !== null ? `  ${entry.url}` : ""}\n`);
	if (bundle) return printReportBundle(bundleIo(io), id);
	const sentBody = entry !== null && entry.state === "sent" ? readSentBody(io.stateDir, id) : null;
	if (entry !== null && sentBody !== null) {
		io.out(`${RULE("title")}${entry.title}\n${RULE("body as sent")}${sentBody}${RULE("end of body")}`);
		return 0;
	}
	if (draft !== null) {
		const rendered = planReport(draft, { identity: await identityFor(io), transport: { kind: "file" } }).rendered;
		io.out(`${RULE("title")}${rendered.title}\n${RULE("body")}${rendered.body}${RULE("end of body")}`);
	}
	return 0;
}

async function sendSaved(
	io: Io,
	args: {
		id: string;
		yes: boolean;
		dryRun: boolean;
		json: boolean;
		onDuplicate: DuplicateChoice | null;
		replyCheck: boolean;
	},
): Promise<number> {
	const entry = outboxEntry(io.stateDir, args.id);
	if (entry !== null && (entry.state === "sent" || entry.state === "withdrawn")) {
		io.out(`${args.id} is already ${entry.state}${entry.url !== null ? `: ${entry.url}` : ""}\n`);
		return 0;
	}
	const draft = readReportDraft(io.stateDir, args.id);
	if (draft === null) {
		fail(io, `no saved draft ${args.id}; clio-coder report status lists them`);
		return 1;
	}
	return confirmAndSend(draft, io, args);
}

async function forget(io: Io, id: string): Promise<number> {
	let deletedShare: string | null = null;
	const share = reportShare(io.stateDir, id);
	if (share !== null) {
		const gh = (await loadFindGh(io.deps))();
		if (gh === null) {
			fail(io, `${id}'s encrypted share is gist ${share.receipt.gistId}; deleting it needs gh, which is not on PATH`);
			return 1;
		}
		const deleted = await deleteShareGist(share.receipt.gistId, {
			gh,
			env: io.env,
			...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
		});
		if ("failed" in deleted) {
			fail(io, `nothing forgotten: ${deleted.failed}`);
			return 1;
		}
		updateShareReceipt(io.stateDir, share.shareId, { deletedAt: (io.deps.now?.() ?? new Date()).toISOString() });
		deletedShare = `deleted the encrypted share ${share.shareId} (gist ${share.receipt.gistId})`;
		io.out(`${deletedShare}\n`);
	}
	const result = forgetReport(io.stateDir, id);
	if (!result.ok && deletedShare !== null) {
		io.out(`${result.reason}\n`);
		return 0;
	}
	if (!result.ok) {
		fail(io, `${result.reason}${result.reason.startsWith("no report") ? "; clio-coder report status lists them" : ""}`);
		return 1;
	}
	io.out(`${result.message}\n`);
	return 0;
}

function security(io: Io): number {
	const route = routeFor("security");
	const url = route.name === "security" ? route.url : "";
	io.out(`Security problems go to a private advisory, not a public issue. Only the maintainers see it:\n${url}\n`);
	const open = io.deps.open ?? ((link: string) => openBrowser(link, io.env));
	if (io.interactive && (io.deps.browserAvailable ?? canOpenBrowser)(io.env) && open(url))
		io.out("opened it in your browser\n");
	return 0;
}

/**
 * `clio-coder report`: exit 0 sent, opened, written or previewed; 1 on a send failure; 2 on usage or without --yes;
 * 3 when a likely duplicate stopped it.
 */
export async function runReport(argv: ReadonlyArray<string>, deps: ReportCliDeps = {}): Promise<number> {
	const out = deps.stdout ?? ((text: string) => void process.stdout.write(text));
	const err = deps.stderr ?? ((text: string) => void process.stderr.write(text));
	const args = parseReport(argv);
	if (typeof args === "string") {
		err(`error: ${args}\n`);
		err(REPORT_HELP);
		return 2;
	}
	if (args.verb === "help") {
		out(REPORT_HELP);
		return 0;
	}
	const io: Io = {
		out,
		err,
		interactive: deps.interactive ?? canSelect(),
		env: deps.env ?? process.env,
		stateDir: deps.stateDir ?? clioStateDir(),
		cwd: deps.cwd ?? process.cwd(),
		deps,
	};
	try {
		sweepReportBundles(io.stateDir, io.deps.now?.() ?? new Date());
		await sweepShareGists(io.stateDir, {
			findGh: await loadFindGh(io.deps),
			env: io.env,
			...(io.deps.run !== undefined ? { run: io.deps.run } : {}),
			...(io.deps.now !== undefined ? { now: io.deps.now() } : {}),
		});
		switch (args.verb) {
			case "compose":
				return await compose(args, io);
			case "status":
				return await status(io, args.json);
			case "show":
				return await show(io, args.id, args.bundle);
			case "send":
				return await sendSaved(io, args);
			case "forget":
				return await forget(io, args.id);
			case "selftest":
				return await runReportSelftest(bundleIo(io), args);
			case "security":
				return security(io);
		}
	} catch (error) {
		err(`error: report: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
