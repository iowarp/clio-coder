import {
	type BuiltBundle,
	buildBundle,
	type ConsentScopes,
	composeReportDraft,
	type LocalIdentity,
	observeSession,
	previewBundle,
	type ReportDraft,
	readReportBundle,
	renderBundlePreview,
	TRANSCRIPT_TURNS_DEFAULT,
	TRANSCRIPT_TURNS_MAX,
} from "../domains/report/index.js";

/** What `report` needs to build and show a bundle; the TUI and tests supply their own. */
export interface ReportBundleIo {
	out: (text: string) => void;
	err: (text: string) => void;
	stateDir: string;
	cwd: string;
	identity: () => Promise<LocalIdentity>;
	/** Flush the live telemetry journals first; the CLI has none of its own. */
	flush?: () => Promise<void>;
	/** The running process's telemetry scope, when it has one. */
	process?: string | null;
	now?: () => Date;
}

/** A bundle the reporter asked for on the command line: consent is restated on every call. */
export interface BundleRequest {
	scopes: ConsentScopes;
	transcript: { turns: number; toolOutput: boolean } | null;
	models: "keep" | "anonymize";
}

/**
 * The bundle flags of `report`: `--bundle none|mechanics`, `--consent debug|dataset`, `--transcript [N]`,
 * `--with-tool-output`, `--anonymize-models`. Null when no bundle is asked for; a string is a usage error.
 */
export function bundleRequest(input: {
	bundle?: string | undefined;
	consent?: string | undefined;
	/** `""` for a bare `--transcript`. */
	transcript?: string | undefined;
	withToolOutput: boolean;
	anonymizeModels: boolean;
}): BundleRequest | null | string {
	if (input.bundle !== undefined && input.bundle !== "none" && input.bundle !== "mechanics")
		return `--bundle takes none or mechanics, not ${input.bundle || "nothing"}`;
	if (input.consent !== undefined && input.consent !== "debug" && input.consent !== "dataset")
		return `--consent takes debug or dataset, not ${input.consent}`;
	if (input.bundle !== "mechanics") {
		const stray = [
			input.consent !== undefined ? "--consent" : null,
			input.transcript !== undefined ? "--transcript" : null,
			input.withToolOutput ? "--with-tool-output" : null,
			input.anonymizeModels ? "--anonymize-models" : null,
		].find((flag) => flag !== null);
		return stray ? `${stray} applies only with --bundle mechanics` : null;
	}
	let turns = TRANSCRIPT_TURNS_DEFAULT;
	if (input.transcript !== undefined && input.transcript !== "") {
		turns = Number(input.transcript);
		if (!Number.isInteger(turns) || turns < 1 || turns > TRANSCRIPT_TURNS_MAX)
			return `--transcript takes 1 to ${TRANSCRIPT_TURNS_MAX} turns, not ${input.transcript}`;
	}
	if (input.withToolOutput && input.transcript === undefined) return "--with-tool-output applies only with --transcript";
	return {
		scopes: input.consent === "dataset" ? ["debug", "dataset"] : ["debug"],
		transcript: input.transcript !== undefined ? { turns, toolOutput: input.withToolOutput } : null,
		models: input.anonymizeModels ? "anonymize" : "keep",
	};
}

function listOrNone(values: ReadonlyArray<string>): string {
	return values.length > 0 ? values.join(", ") : "none";
}

/** The attach step's lines: size, records, what is kept and never kept, what stayed readable, the ticks. */
export function formatBundleSummary(built: BuiltBundle): string {
	const { summary } = built;
	const anonymized = Object.entries(summary.anonymized)
		.map(([kind, count]) => `${kind} ${count}`)
		.join(", ");
	const lines = [
		`Diagnostic bundle: ${summary.bytes} bytes, ${summary.records} telemetry records in ${summary.scopes} scope${summary.scopes === 1 ? "" : "s"}, sha256 ${built.sha256}`,
		"Kept:",
		...summary.kept.map((line) => `  - ${line}`),
		"Never kept:",
		...summary.neverKept.map((line) => `  - ${line}`),
		"Readable as written:",
		`  models: ${listOrNone(summary.readable.model)}`,
		`  runtimes: ${listOrNone(summary.readable.runtime)}`,
		`  tools: ${listOrNone(summary.readable.tool)}`,
		`  tokens: ${listOrNone(summary.readable.token)}`,
		`Anonymized: ${anonymized || "none"}; withheld: ${summary.withheld}`,
		`Consent: ${summary.scopesGranted.join(" and ")}`,
		summary.transcript
			? `Transcript: the last ${summary.transcript.turns} of ${summary.transcript.of} turns, tool arguments and output ${summary.transcript.toolOutput ? "included" : "left out"}`
			: "Transcript: not included",
		built.path !== null
			? `Saved at ${built.path}. It stays on this machine; clio-coder report show ${built.envelope.reportId} --bundle prints every byte of it.`
			: "Not saved: nothing was written.",
	];
	return `${lines.join("\n")}\n`;
}

/** Build the bundle a report asked for. A refusal is returned as its message, never as a partial bundle. */
export async function attachBundle(
	io: ReportBundleIo,
	draft: ReportDraft,
	request: BundleRequest,
	options: { write: boolean },
): Promise<BuiltBundle | string> {
	try {
		return await buildBundle(draft, {
			consent: { scopes: request.scopes },
			...(request.transcript ? { transcript: request.transcript } : {}),
			identity: await io.identity(),
			stateDir: io.stateDir,
			models: request.models,
			write: options.write,
			...(io.flush ? { flush: io.flush } : {}),
			...(io.process ? { process: io.process } : {}),
			...(io.now ? { now: io.now() } : {}),
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** `report show <id> --bundle`: the bytes of the file whose sha256 the outbox holds, member by member. */
export function printReportBundle(io: ReportBundleIo, id: string): number {
	let bytes: Buffer | null;
	try {
		bytes = readReportBundle(io.stateDir, id);
	} catch (error) {
		io.err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (bytes === null) {
		io.out("No diagnostic bundle is attached to this report.\n");
		return 0;
	}
	io.out(renderBundlePreview(previewBundle(bytes)));
	return 0;
}

/**
 * `report selftest`: build the bundle a report of this directory's newest session (or `session`) would carry, write
 * nothing, and say whether any of this machine's identifiers survived into it (R-19). Exit 0 when none did, 1 when the
 * scan found one or the bundle could not be built, 2 when there is no session to build from.
 */
export async function runReportSelftest(
	io: ReportBundleIo,
	args: { session: string | null; request: BundleRequest | null },
): Promise<number> {
	let id = args.session;
	let facts: { model?: string } = {};
	if (id === null) {
		const { listSessionsForCwd } = await import("../domains/session/history.js");
		const meta = listSessionsForCwd(io.cwd)[0];
		if (meta === undefined) {
			io.err("error: no session in this directory; run clio-coder here first or pass --session <id>\n");
			return 2;
		}
		id = meta.id;
		if (meta.model) facts = { model: meta.model };
	}
	const draft = composeReportDraft({
		kind: "bug",
		surface: "headless",
		session: { id, observations: observeSession(io.stateDir, id), facts },
		...(io.now ? { now: io.now() } : {}),
	});
	const built = await attachBundle(io, draft, args.request ?? { scopes: ["debug"], transcript: null, models: "keep" }, {
		write: false,
	});
	if (typeof built === "string") {
		io.err(`error: ${built}\n`);
		return 1;
	}
	io.out(
		`0 identifiers found in ${built.summary.bytes} bytes (${built.members.map((member) => member.path).join(", ")}; ${built.summary.records} telemetry records)\n`,
	);
	return 0;
}
