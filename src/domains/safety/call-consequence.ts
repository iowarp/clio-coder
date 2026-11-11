import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { storeReplacedBytes } from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import type { AutonomyExposure } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import { describeBashCallConsequences, type PathKind } from "./command-consequence.js";
import { outwardShellReason } from "./containment.js";
import type { SafetyDecision } from "./contract.js";
import { shellCommandSteps } from "./protected-artifacts.js";

/** What exists at `path` once resolved against `cwd`; null when it does not, or cannot be read. */
function pathKindIn(cwd: string): (path: string) => PathKind {
	return (path) => {
		try {
			const stat = statSync(resolve(cwd, path));
			return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
		} catch {
			// A path that cannot be statted is not an existing file to overwrite.
			return null;
		}
	};
}

/**
 * The consequence sentences for a bash ask the main agent made, read from the
 * full command and checked against the filesystem it will run in. Card text
 * only: a failure here is no sentence, never a different admission. Every
 * approval surface (the terminal card and the ACP permission request) reads
 * it here so they describe one command the same way.
 */
export function describeMainCallConsequences(call: ClassifierCall): string[] {
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	const described = describeBashCallConsequences(call.tool, call.args, {
		pathKind: pathKindIn(resolve(process.cwd(), cwd)),
		home: homedir,
	});
	if (described.length > 0) return described;
	// A step the sandbox refuses as outward says why, so a card titled outward names what reaches out.
	const outward = shellOutwardReason(call);
	return outward === null ? [] : [outward];
}

/**
 * What a store put replaces, in plain words, when its admission found the blob already there; the
 * judge reads this line instead of the internal marker admission set on the arguments.
 */
export function storeReplaceConsequences(call: ClassifierCall): string[] {
	if (call.tool !== ToolNames.Store || call.args?.op !== "put") return [];
	const bytes = storeReplacedBytes(call.args);
	if (bytes === null) return [];
	const { tag, blob, path } = call.args;
	const name = typeof blob === "string" && blob.length > 0 ? blob : typeof path === "string" ? basename(path) : "";
	return [`this put replaces the existing blob ${String(tag)}:${name} of ${bytes} bytes`];
}

const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NPM_SCRIPT_ALIASES: Readonly<Record<string, string>> = {
	t: "test",
	tst: "test",
	test: "test",
	start: "start",
	stop: "stop",
	restart: "restart",
};

/**
 * The package.json script bodies a shell call runs through npm, pnpm, yarn or
 * bun, one line per script with its pre and post hooks. `npm run release` names
 * a script, not what it does, so the judge reads the body that executes and
 * judges that against the operator's words. Empty when no step runs a script
 * the manifest defines; a manifest that cannot be read says so.
 */
export function projectScriptConsequences(call: ClassifierCall): string[] {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return [];
	const command = call.args?.command;
	if (typeof command !== "string") return [];
	const names: string[] = [];
	for (const step of shellCommandSteps(command)) {
		if (!PACKAGE_RUNNERS.has(step.executable)) continue;
		const words = step.args.filter((word) => !word.startsWith("-"));
		const verb = words[0];
		if (verb === undefined) continue;
		const name =
			verb === "run" || verb === "run-script" ? words[1] : step.executable === "npm" ? NPM_SCRIPT_ALIASES[verb] : verb;
		if (name !== undefined && !names.includes(name)) names.push(name);
	}
	if (names.length === 0) return [];
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	let scripts: Record<string, unknown> | undefined;
	try {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), cwd, "package.json"), "utf8")) as {
			scripts?: Record<string, unknown>;
		};
		scripts = manifest.scripts;
	} catch {
		return ["package.json could not be read, so the project script this runs is unknown repository code"];
	}
	const lines: string[] = [];
	for (const name of names.slice(0, 4)) {
		if (typeof scripts?.[name] !== "string") continue;
		const bodies = [`pre${name}`, name, `post${name}`].flatMap((key) =>
			typeof scripts?.[key] === "string" ? [`${key}: ${scripts[key]}`] : [],
		);
		lines.push(`runs package.json script "${name}", repository data that executes as written: ${bodies.join("; ")}`);
	}
	return lines;
}

/**
 * The rail's word for a call whose only known reach is a credentialed CLI, since
 * Clio cannot say that it has an outward consequence, only what it runs as. Null
 * when the sentences name anything more, and then the tier's word stands.
 */
export function credentialedCallKind(consequence: ReadonlyArray<string> | undefined): string | null {
	if (consequence === undefined || consequence.length !== 1) return null;
	const line = consequence[0] ?? "";
	if (/ reads with your credentials$/u.test(line)) return "reads with your credentials";
	if (/ acts with your credentials$/u.test(line)) return "uses your credentials";
	return null;
}

function shellOutwardReason(call: ClassifierCall): string | null {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return null;
	const command = call.args?.command;
	return typeof command === "string" ? outwardShellReason(command) : null;
}

/**
 * Whether a parked main-agent call reaches outside the workspace, for the words
 * and tone of its approval card. The classifier's own exposure comes first, then
 * the shell steps the sandbox already treats as outward, so `npm publish` is not
 * titled a workspace action beside an effect that says otherwise. Card text only:
 * admission reads none of this, and a false match only makes a card warier.
 */
export function mainCallExposure(call: ClassifierCall, decision: SafetyDecision): AutonomyExposure {
	if (autonomyCallInputs(call, decision).exposure === "outward") return "outward";
	return shellOutwardReason(call) === null ? "local" : "outward";
}
