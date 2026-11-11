import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { readSettings } from "../core/config.js";
import { canOpenBrowser, openBrowser } from "../core/open-browser.js";
import { proxyEnvSummary } from "../core/proxy-env.js";
import {
	authNotRequiredStatus,
	openAuthStorage,
	RETIRED_GITHUB_COPILOT_MESSAGE,
	RETIRED_GITHUB_COPILOT_PROVIDER_ID,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	targetRequiresAuth,
} from "../domains/providers/auth/index.js";
import { copilotAuthState, prepareCopilotSdk } from "../domains/providers/copilot-setup.js";
import type { AuthStatus } from "../domains/providers/index.js";
import { supportGroupLabel } from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { askYesNo } from "./ask.js";
import { railPrefix } from "./configure-target.js";
import { offerCopilotSignIn } from "./copilot-sign-in.js";
import { createLifecyclePresenter } from "./lifecycle-presenter.js";
import { createDelayedManualCodeInput } from "./oauth-manual-input.js";
import {
	chooseOAuthMethod,
	describeOAuthError,
	NO_LOCAL_BROWSER_LINE,
	type OAuthMethodPreference,
	oauthUrlLines,
	promptOAuthSelection,
} from "./oauth-select.js";
import {
	CONNECTABLE_LIST_CAPTION,
	type ConnectableProviderRow,
	listConnectableProviderRows,
	renderConnectableProviderRows,
	resolveCliProviderReference,
} from "./provider-target.js";
import { promptText } from "./select.js";
import {
	credentialWriteFailed,
	formatColumns,
	printError,
	printOk,
	printPlaintextCredentialWarning,
} from "./shared.js";
import { terminalColumns, wrapPlain } from "./text-layout.js";

const USAGE = `usage: clio-coder auth list
       clio-coder auth status [target-or-runtime]
       clio-coder auth login [target-or-runtime] [--api-key <value>] [--method browser|device]
       clio-coder auth logout [target-or-runtime]
`;

interface ParsedAuthTargetArgs {
	target?: string;
	apiKey?: string;
	method?: OAuthMethodPreference;
	help: boolean;
}

function parseAuthTargetArgs(args: ReadonlyArray<string>, verb: string): ParsedAuthTargetArgs {
	const parsed: ParsedAuthTargetArgs = { help: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--api-key") {
			const value = args[i + 1];
			if (!value) throw new Error("--api-key requires a value");
			parsed.apiKey = value;
			i += 1;
			continue;
		}
		if (arg === "--method") {
			const value = args[i + 1];
			if (value !== "browser" && value !== "device") throw new Error("--method requires browser or device");
			parsed.method = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		if (parsed.target) throw new Error(`auth ${verb} accepts at most one target or runtime`);
		parsed.target = arg;
	}
	return parsed;
}

/** The connectable listing plus the sentence that says what it left out. */
function printConnectableListing(rows: ReadonlyArray<ConnectableProviderRow>): void {
	process.stdout.write(renderConnectableProviderRows(rows));
	for (const line of wrapPlain(CONNECTABLE_LIST_CAPTION, terminalColumns())) {
		process.stdout.write(`${line}\n`);
	}
}

function printStatusLine(id: string, label: string, type: string | null, present: boolean, source: string): void {
	process.stdout.write(formatColumns([[id, label, type ?? "-", present ? "present" : "absent", source]]));
}

/**
 * A store that failed to parse reads back as zero credentials, which renders
 * identically to having never logged in. Saying so is the difference between
 * "you are not connected" and "your credentials are still on disk and this
 * version cannot read them", and it is the warning that stops someone from
 * treating a damaged file as a fresh start.
 */
function warnIfCredentialsDamaged(auth: ReturnType<typeof openAuthStorage>): void {
	const damage = auth.damageReason();
	if (damage === null) return;
	process.stderr.write(`warning: the credentials file could not be fully read: ${damage}\n`);
	process.stderr.write("warning: entries below may be understated. Nothing will be written until it is repaired.\n");
}

function renderStatusRows(
	rows: ReadonlyArray<ConnectableProviderRow>,
	auth: ReturnType<typeof openAuthStorage>,
	extraRows: ReadonlyArray<string[]> = [],
): string {
	const targets = readSettings().targets;
	return formatColumns([
		...rows.flatMap((row) => {
			const status = row.status;
			if (status === null) {
				return [[row.entry.runtimeId, row.entry.label, "-", "unknown", "no auth probe available"]];
			}
			const runtimeRow = [
				row.entry.runtimeId,
				row.entry.label,
				status.credentialType ?? "-",
				status.available ? "present" : "absent",
				status.detail ?? status.source,
			];
			// A target with its own credential reference (configure stores a
			// gateway key as `target:<id>`) is never read by its runtime's row,
			// which then said absent beside a working target. Name each one.
			const runtime = getRuntimeRegistry().get(row.entry.runtimeId);
			if (!runtime) return [runtimeRow];
			const runtimeProviderId = resolveRuntimeAuthTarget(runtime).providerId;
			const targetRows = targets.flatMap((target) => {
				if (target.runtime !== runtime.id || !targetRequiresAuth(target, runtime)) return [];
				const authTarget = resolveAuthTarget(target, runtime);
				if (authTarget.providerId === runtimeProviderId) return [];
				const targetStatus = auth.statusForTarget(authTarget, { includeFallback: false });
				return [
					[
						authTarget.providerId,
						`${row.entry.label} (target ${target.id})`,
						targetStatus.credentialType ?? "-",
						targetStatus.available ? "present" : "absent",
						targetStatus.detail ?? targetStatus.source,
					],
				];
			});
			return [runtimeRow, ...targetRows];
		}),
		...extraRows,
	]);
}

function defaultAuthTarget(rows: ReadonlyArray<ConnectableProviderRow>): string | undefined {
	const settings = readSettings();
	const activeTarget = settings.chat.target
		? settings.targets.find((entry) => entry.id === settings.chat.target)
		: undefined;
	if (activeTarget && rows.some((row) => row.entry.runtimeId === activeTarget.runtime)) {
		return activeTarget.runtime;
	}
	const configured = rows.find((row) => row.targetCount > 0);
	if (configured) return configured.entry.runtimeId;
	return rows[0]?.entry.runtimeId;
}

async function promptForLoginTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no auth-capable runtimes are registered");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultAuthTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Authenticate a runtime:\n");
		let lastGroup: ConnectableProviderRow["entry"]["group"] | null = null;
		for (const [index, row] of rows.entries()) {
			if (row.entry.group !== lastGroup) {
				lastGroup = row.entry.group;
				process.stdout.write(`  ${supportGroupLabel(row.entry.group)}:\n`);
			}
			const status = row.status?.available
				? row.status.source === "environment"
					? `env:${row.status.detail ?? row.entry.runtimeId}`
					: row.status.source
				: row.status === null
					? "native-cli"
					: "disconnected";
			process.stdout.write(
				`    ${String(index + 1).padStart(2)}. ${row.entry.runtimeId.padEnd(22)} ${status.padEnd(18)} targets=${row.targetCount}\n`,
			);
		}
		// The picker is where a runtime id copied off `clio-coder configure --list` gets
		// typed, so it says here which runtimes it can accept.
		for (const line of wrapPlain(CONNECTABLE_LIST_CAPTION, terminalColumns())) {
			process.stdout.write(`${line}\n`);
		}
		process.stdout.write("\n");
		for (;;) {
			const answer = (await rl.question(`Selection (number or runtime id) [${defaultTarget}]: `)).trim();
			const value = answer.length > 0 ? answer : defaultTarget;
			const numeric = Number(value);
			if (Number.isInteger(numeric) && numeric >= 1 && numeric <= rows.length) {
				return rows[numeric - 1]?.entry.runtimeId ?? null;
			}
			if (rows.some((row) => row.entry.runtimeId === value)) return value;
			process.stderr.write(`unknown selection: ${value}\n`);
		}
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

function storedCredentialRows(rows: ReadonlyArray<ConnectableProviderRow>): ConnectableProviderRow[] {
	return rows.filter((row) => row.status?.source === "stored-api-key" || row.status?.source === "stored-oauth");
}

function statusForResolvedTarget(
	resolved: NonNullable<ReturnType<typeof resolveCliProviderReference>>,
	auth: ReturnType<typeof openAuthStorage>,
): AuthStatus {
	if (resolved.target && !targetRequiresAuth(resolved.target, resolved.runtime)) {
		return authNotRequiredStatus(resolved.authTarget.providerId);
	}
	if (!resolved.target && resolved.runtime.auth !== "api-key" && resolved.runtime.auth !== "oauth") {
		return authNotRequiredStatus(resolved.authTarget.providerId);
	}
	return auth.statusForTarget(resolved.authTarget, { includeFallback: false });
}

async function promptForLogoutTarget(rows: ReadonlyArray<ConnectableProviderRow>): Promise<string | null> {
	if (rows.length === 0) {
		printError("no stored target credentials");
		return null;
	}
	const rl = createInterface({ input, output });
	const defaultTarget = defaultAuthTarget(rows) ?? rows[0]?.entry.runtimeId ?? "";
	try {
		process.stdout.write("Remove stored credentials:\n");
		let lastGroup: ConnectableProviderRow["entry"]["group"] | null = null;
		for (const [index, row] of rows.entries()) {
			if (row.entry.group !== lastGroup) {
				lastGroup = row.entry.group;
				process.stdout.write(`  ${supportGroupLabel(row.entry.group)}:\n`);
			}
			process.stdout.write(
				`    ${String(index + 1).padStart(2)}. ${row.entry.runtimeId.padEnd(22)} ${String(row.status?.source ?? "disconnected")}\n`,
			);
		}
		process.stdout.write("\n");
		for (;;) {
			const answer = (await rl.question(`Selection (number or runtime id) [${defaultTarget}]: `)).trim();
			const value = answer.length > 0 ? answer : defaultTarget;
			const numeric = Number(value);
			if (Number.isInteger(numeric) && numeric >= 1 && numeric <= rows.length) {
				return rows[numeric - 1]?.entry.runtimeId ?? null;
			}
			if (rows.some((row) => row.entry.runtimeId === value)) return value;
			process.stderr.write(`unknown selection: ${value}\n`);
		}
	} catch {
		return null;
	} finally {
		rl.close();
	}
}

async function runLogin(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedAuthTargetArgs;
	try {
		parsed = parseAuthTargetArgs(args, "login");
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(USAGE);
		return 2;
	}
	if (parsed.help) {
		// Usage only, like list|status|logout. Printing the runtime inventory first
		// made `login --help` read as though the picker had already started.
		process.stdout.write(USAGE);
		return 0;
	}
	if (!parsed.target) {
		if (!input.isTTY || !output.isTTY) {
			printConnectableListing(listConnectableProviderRows());
			process.stderr.write(USAGE);
			return 2;
		}
		const picked = await promptForLoginTarget(listConnectableProviderRows());
		if (!picked) return 0;
		parsed.target = picked;
	}

	if (parsed.target === RETIRED_GITHUB_COPILOT_PROVIDER_ID) {
		printError(RETIRED_GITHUB_COPILOT_MESSAGE);
		return 2;
	}
	const resolved = resolveCliProviderReference(parsed.target);
	if (!resolved) {
		printError(`unknown target or runtime: ${parsed.target}`);
		process.stderr.write(USAGE);
		return 2;
	}

	if (resolved.runtime.id === "copilot-sdk") return loginCopilotSdk();
	const auth = openAuthStorage();
	if (resolved.runtime.authNotice) process.stdout.write(`note: ${resolved.runtime.authNotice}\n`);
	if (resolved.runtime.auth === "oauth") {
		const rl = createInterface({ input, output });
		const preference = parsed.method ?? (canOpenBrowser() ? "browser" : "device");
		const manualCodeInput = createDelayedManualCodeInput(
			rl,
			"Paste verification code if the browser flow does not return automatically: ",
		);
		try {
			await auth.login(resolved.authTarget.providerId, {
				onAuth: ({ url, instructions }) => {
					const opened = preference === "browser" && openBrowser(url);
					process.stdout.write(`${oauthUrlLines(url, instructions, opened).join("\n")}\n`);
					if (preference === "browser")
						process.stdout.write("Waiting for the browser callback. A manual code prompt will appear if needed.\n");
				},
				onDeviceCode: ({ verificationUri, userCode }) => {
					process.stdout.write(`${verificationUri}\n`);
					process.stdout.write(`Enter code: ${userCode}\n`);
				},
				onPrompt: async (prompt) => {
					const answer = await rl.question(`${prompt.message}${prompt.allowEmpty ? " " : ": "}`);
					return prompt.allowEmpty ? answer : answer.trim();
				},
				onSelect: (prompt) => {
					const method = chooseOAuthMethod(prompt, preference);
					if (method === undefined) return promptOAuthSelection(rl, prompt);
					if (method !== "browser" && parsed.method === undefined) process.stdout.write(`${NO_LOCAL_BROWSER_LINE}\n`);
					return Promise.resolve(method);
				},
				onManualCodeInput: manualCodeInput.onManualCodeInput,
				onProgress: (message) => {
					process.stderr.write(`${message}\n`);
				},
			});
			// The OAuth handshake succeeding says nothing about the credential
			// reaching disk; auth.login() writes through the same swallowing
			// persist() the API-key path uses.
			if (credentialWriteFailed(auth, `credential for ${resolved.authTarget.providerId} was not stored`)) return 1;
			printOk(`authenticated ${resolved.authTarget.providerId}`);
			return 0;
		} catch (error) {
			printError(describeOAuthError(error, proxyEnvSummary()));
			return 1;
		} finally {
			manualCodeInput.cancel();
			rl.close();
		}
	}

	if (resolved.runtime.auth !== "api-key") {
		// Where a runtime id copied off `clio-coder configure --list` lands when it is
		// one of the ones this command cannot log into. Saying only that it is
		// unsupported leaves the user holding a name that another Clio screen
		// showed them as connectable.
		printError(`runtime ${resolved.runtime.id} does not support interactive auth login`);
		process.stderr.write(
			`  it authenticates as '${resolved.runtime.auth}', outside clio: \`clio-coder auth status ${resolved.runtime.id}\` reports its state, and \`clio-coder configure --list\` shows how it is registered\n`,
		);
		return 1;
	}

	let apiKey = parsed.apiKey?.trim();
	if (parsed.apiKey !== undefined && input.isTTY) {
		process.stderr.write(
			'warning: --api-key leaves the key in shell history and in the process list. To keep it out of both, omit --api-key and paste it at the prompt, or pipe it: printf %s "$KEY" | clio-coder auth login <target>\n',
		);
	}
	if (apiKey === undefined) {
		const read = await readApiKey(`API key for ${resolved.runtime.displayName}`);
		if (read === null) {
			printError("login cancelled");
			return 1;
		}
		apiKey = read;
	}
	if (!apiKey) {
		printError("empty API key");
		return 1;
	}
	try {
		auth.setApiKey(resolved.authTarget.providerId, apiKey);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (credentialWriteFailed(auth, `credential for ${resolved.authTarget.providerId} was not stored`)) return 1;
	printOk(`authenticated ${resolved.authTarget.providerId}`);
	printPlaintextCredentialWarning();
	return 0;
}

/**
 * A terminal gets the masked field the configure wizard uses, so the key never
 * reaches scrollback; a terminal that cannot draw it (TERM=dumb) reads the key
 * with echo off, since the line discipline would otherwise echo every
 * character. Anything else is read as the first line of stdin, so a script can
 * pipe the key in without it appearing in argv. Null means the user backed out
 * of the prompt.
 */
export async function readApiKey(
	label: string,
	io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input, output },
): Promise<string | null> {
	if (io.input.isTTY) {
		const field = io.output.isTTY ? io.output : process.stderr;
		if (typeof io.input.setRawMode !== "function") {
			printError(
				"this terminal cannot hide typed input; pipe the key on stdin instead: clio-coder auth login <target> < keyfile",
			);
			return null;
		}
		if (process.env.TERM === "dumb") return readHiddenLine(io.input, field, label);
		const result = await promptText({
			heading: ["", label],
			railPrefix: railPrefix(createLifecyclePresenter({ stream: field }).isPlain()),
			mask: true,
			backLabel: "cancel",
			clearOnExit: true,
			input: io.input,
			output: field,
		});
		return result.kind === "value" ? result.value.trim() : null;
	}
	const rl = createInterface({ input: io.input, terminal: false });
	try {
		for await (const line of rl) return line.trim();
		return "";
	} finally {
		rl.close();
	}
}

/** One line read in raw mode, so nothing typed is echoed; Ctrl-C backs out, Backspace and Ctrl-U edit. */
async function readHiddenLine(
	stream: NodeJS.ReadStream,
	field: NodeJS.WriteStream,
	label: string,
): Promise<string | null> {
	field.write(`${label} (typing is hidden): `);
	const wasRaw = stream.isRaw === true;
	stream.setRawMode(true);
	stream.resume();
	try {
		return await new Promise<string | null>((resolve) => {
			let value: string[] = [];
			const finish = (result: string | null): void => {
				stream.off("data", onData);
				stream.off("end", onEnd);
				stream.off("close", onEnd);
				resolve(result);
			};
			const onEnd = (): void => finish(value.join("").trim());
			const onData = (chunk: Buffer | string): void => {
				for (const char of chunk.toString()) {
					if (char === "\r" || char === "\n" || char === "\u0004") {
						finish(value.join("").trim());
						return;
					}
					if (char === "\u0003") {
						finish(null);
						return;
					}
					if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
					else if (char === "\u0015") value = [];
					else if (char >= " ") value.push(char);
				}
			};
			stream.on("data", onData);
			stream.once("end", onEnd);
			stream.once("close", onEnd);
		});
	} finally {
		if (!wasRaw) stream.setRawMode(false);
		stream.pause();
		field.write("\n");
	}
}

async function runStatus(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		printError(`unknown flag: ${args.find((arg) => arg.startsWith("-"))}`);
		process.stderr.write(USAGE);
		return 2;
	}
	if (args.length > 1) {
		printError("auth status accepts at most one target or runtime");
		process.stderr.write(USAGE);
		return 2;
	}

	const auth = openAuthStorage();
	warnIfCredentialsDamaged(auth);
	const target = args[0];
	if (target) {
		const resolved = resolveCliProviderReference(target);
		if (!resolved) {
			printError(`unknown target or runtime: ${target}`);
			return 2;
		}
		if (resolved.runtime.id === "copilot-sdk") {
			// The credential is the official runtime's own login; ask the runtime who it is signed in as.
			const copilot = await copilotAuthState(input.isTTY === true && output.isTTY === true);
			printStatusLine(
				resolved.authTarget.providerId,
				resolved.runtime.displayName,
				"seat",
				copilot.present,
				copilot.detail,
			);
			return copilot.present ? 0 : 1;
		}
		const status = statusForResolvedTarget(resolved, auth);
		printStatusLine(
			resolved.authTarget.providerId,
			resolved.runtime.displayName,
			status.credentialType,
			status.available,
			status.detail ?? status.source,
		);
		return status.available ? 0 : 1;
	}

	// Copilot signs in through its own CLI, so it is not a connectable runtime; with a target configured, its
	// login is reported too. Without one, nothing starts the runtime.
	const rows = listConnectableProviderRows();
	const extraRows: string[][] = [];
	const copilotRuntime = getRuntimeRegistry().get("copilot-sdk");
	if (copilotRuntime && readSettings().targets.some((t) => t.runtime === copilotRuntime.id)) {
		const copilot = await copilotAuthState(input.isTTY === true && output.isTTY === true);
		extraRows.push([
			copilotRuntime.id,
			copilotRuntime.displayName,
			"seat",
			copilot.present ? "present" : "absent",
			copilot.detail,
		]);
	}
	process.stdout.write(renderStatusRows(rows, auth, extraRows));
	return 0;
}

function runLogout(args: ReadonlyArray<string>): Promise<number> | number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (args.some((arg) => arg.startsWith("-"))) {
		printError(`unknown flag: ${args.find((arg) => arg.startsWith("-"))}`);
		process.stderr.write(USAGE);
		return 2;
	}
	const target = args[0];
	if (!target) {
		const rows = storedCredentialRows(listConnectableProviderRows());
		if (!input.isTTY || !output.isTTY) {
			process.stdout.write(renderConnectableProviderRows(rows));
			process.stderr.write(USAGE);
			return 2;
		}
		return promptForLogoutTarget(rows).then((picked) => (picked ? runLogout([picked]) : 1));
	}
	if (args.length > 1) {
		printError("auth logout accepts at most one target or runtime");
		process.stderr.write(USAGE);
		return 2;
	}

	const resolved = resolveCliProviderReference(target);
	if (!resolved) {
		printError(`unknown target or runtime: ${target}`);
		process.stderr.write(USAGE);
		return 2;
	}
	const auth = openAuthStorage();
	warnIfCredentialsDamaged(auth);
	const status = statusForResolvedTarget(resolved, auth);
	if (!status.available) {
		// A damaged store reads as zero credentials, so "no stored credential"
		// would be the same understatement the warning above exists to remove.
		// Logout by runtime id never drops a target's own key; name those targets.
		const keyed =
			resolved.target === null && auth.damageReason() === null
				? readSettings()
						.targets.filter((t) => t.runtime === resolved.runtime.id && targetRequiresAuth(t, resolved.runtime))
						.filter((t) => auth.statusForTarget(resolveAuthTarget(t, resolved.runtime), { includeFallback: false }).available)
						.map((t) => t.id)
				: [];
		if (keyed.length > 0) {
			printError(
				`no stored credential for runtime ${resolved.authTarget.providerId}; target keys are stored for ${keyed.join(", ")}. Run \`clio-coder auth logout <target-id>\` to drop one`,
			);
			return 1;
		}
		printError(
			auth.damageReason() === null
				? `no stored credential for ${resolved.authTarget.providerId}`
				: `cannot tell whether ${resolved.authTarget.providerId} is stored: the credentials file could not be fully read`,
		);
		return 1;
	}
	if (status.source === "environment") {
		printError(
			`credential for ${resolved.authTarget.providerId} comes from ${status.detail ?? "the environment"}; clear the env var to log out`,
		);
		return 1;
	}
	if (status.source !== "stored-api-key" && status.source !== "stored-oauth") {
		printError(`cannot remove credential for ${resolved.authTarget.providerId} from source ${status.source}`);
		return 1;
	}
	try {
		auth.logout(resolved.authTarget.providerId);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
	if (credentialWriteFailed(auth, `credential for ${resolved.authTarget.providerId} was not removed`)) return 1;
	printOk(`removed credential for ${resolved.authTarget.providerId}`);
	return 0;
}

/**
 * Copilot's credential belongs to the official runtime (`copilot login`): this step installs the SDK component
 * when needed and confirms which account the runtime is signed in as. Clio stores nothing.
 */
async function loginCopilotSdk(): Promise<number> {
	const interactive = input.isTTY === true && output.isTTY === true;
	const rl = interactive ? createInterface({ input, output }) : null;
	try {
		const result = await prepareCopilotSdk({
			...(rl
				? {
						confirm: (question: string) => askYesNo(rl, question, false),
						signIn: () =>
							offerCopilotSignIn({
								confirm: (question) => askYesNo(rl, question, true),
								pause: () => rl.pause(),
								resume: () => rl.resume(),
								print: (text) => process.stdout.write(`${text}\n`),
							}),
					}
				: {}),
			print: (text) => process.stdout.write(`${text}\n`),
		});
		if (!result.ok) {
			printError(result.message);
			return 1;
		}
		printOk(`GitHub Copilot ready as ${result.account.login}`);
		return 0;
	} finally {
		rl?.close();
	}
}

export async function runAuthCommand(args: ReadonlyArray<string>): Promise<number> {
	const subcommand = args[0] ?? "status";
	const rest = args.slice(1);
	if (subcommand === "list") {
		if (rest.includes("--help") || rest.includes("-h")) {
			process.stdout.write(USAGE);
			return 0;
		}
		if (rest.length > 0 && rest.some((arg) => arg !== "--help" && arg !== "-h")) {
			printError("auth list takes no arguments");
			process.stderr.write(USAGE);
			return 2;
		}
		warnIfCredentialsDamaged(openAuthStorage());
		printConnectableListing(listConnectableProviderRows());
		return 0;
	}
	if (subcommand === "status") return runStatus(rest);
	if (subcommand === "login") return runLogin(rest);
	if (subcommand === "logout") return runLogout(rest);
	if (subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	printError(`unknown auth subcommand: ${subcommand}`);
	process.stderr.write(USAGE);
	return 2;
}
