import path from "node:path";

export type ProtectedArtifactSource = "validation" | "middleware" | "user" | "session";

export interface ProtectedArtifact {
	path: string;
	protectedAt: string;
	reason: string;
	validationCommand?: string;
	validationExitCode?: number;
	source: ProtectedArtifactSource;
}

export interface ProtectedArtifactState {
	artifacts: ProtectedArtifact[];
}

export type DestructiveCommandOperation =
	| "rm"
	| "mv"
	| "truncate"
	| "redirect"
	| "cp"
	| "git_checkout"
	| "git_restore"
	| "git_reset_hard"
	| "find_delete";

export interface ProtectedArtifactCommandMatch {
	artifactPath: string;
	commandPath: string;
	reason: string;
}

export type DestructiveCommandClassification =
	| { kind: "benign"; matches: [] }
	| {
			kind: "destructive";
			operation: DestructiveCommandOperation;
			matches: ProtectedArtifactCommandMatch[];
	  };

export type ValidationCommandDetection = { kind: "validation"; matched: string } | { kind: "none" };

interface NormalizedArtifact {
	key: string;
	artifact: ProtectedArtifact;
}

const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|"]);
const SHELL_WRAPPERS = new Set(["command", "builtin", "sudo", "doas"]);

export function protectArtifact(state: ProtectedArtifactState, artifact: ProtectedArtifact): ProtectedArtifactState {
	const artifacts = artifactMap(state.artifacts);
	const key = normalizePathKey(artifact.path);
	if (key !== null) artifacts.set(key, cloneArtifact(artifact));
	return stateFromMap(artifacts);
}

export function unprotectArtifact(state: ProtectedArtifactState, artifactPath: string): ProtectedArtifactState {
	const artifacts = artifactMap(state.artifacts);
	const key = normalizePathKey(artifactPath);
	if (key !== null) artifacts.delete(key);
	return stateFromMap(artifacts);
}

export function isProtectedPath(state: ProtectedArtifactState, artifactPath: string): boolean {
	const candidate = normalizePathKey(artifactPath);
	if (candidate === null) return false;
	for (const artifact of normalizedArtifacts(state.artifacts)) {
		if (isSameOrDescendant(candidate, artifact.key)) return true;
	}
	return false;
}

export function classifyDestructiveCommand(
	command: string,
	protectedArtifacts: ReadonlyArray<ProtectedArtifact>,
): DestructiveCommandClassification {
	const artifacts = normalizedArtifacts(protectedArtifacts);
	if (artifacts.length === 0) return { kind: "benign", matches: [] };

	const tokens = tokenizeShellLike(command);
	for (const segment of splitSegments(tokens)) {
		const redirect = classifyRedirect(segment, artifacts);
		if (redirect.kind === "destructive") return redirect;

		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		if (executable === "rm") {
			const result = classifyPathOperation(
				"rm",
				"rm can remove protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "mv") {
			const result = classifyPathOperation(
				"mv",
				"mv can move or overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "truncate") {
			const result = classifyPathOperation(
				"truncate",
				"truncate can overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "cp") {
			const args = pathArgs(segment, commandIndex);
			const destination = args.at(-1);
			const result = classifyPathOperation(
				"cp",
				"cp can overwrite protected artifacts",
				destination === undefined ? [] : [destination],
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "git") {
			const result = classifyGitOperation(segment.slice(commandIndex + 1), artifacts);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "find") {
			const result = classifyFindDelete(segment.slice(commandIndex + 1), artifacts);
			if (result.kind === "destructive") return result;
		}
	}

	return { kind: "benign", matches: [] };
}

export function detectValidationCommand(command: string): ValidationCommandDetection {
	const tokens = tokenizeShellLike(command);
	for (const segment of splitSegments(tokens)) {
		const commandIndex = commandTokenIndex(segment);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		const args = segment.slice(commandIndex + 1);
		const matched = validationMatch(executable, args);
		if (matched !== null) return { kind: "validation", matched };
	}
	return { kind: "none" };
}

/**
 * Returns every path the command would write to: shell redirect targets
 * (`>`, `>>`), all path arguments to `tee`, and the destination argument
 * of `cp` and `mv`. Standard descriptors like `/dev/null` and fd
 * references like `&1` are filtered out so callers only see real
 * filesystem targets.
 *
 * Used by the action classifier to escalate bash calls that write to a
 * system root or out-of-cwd path through the same super-mode gate as the
 * write tool. The classifier is the only safety lever for these patterns;
 * pi-mono executes the bash command verbatim, so the registry-side check
 * has to happen before the shell runs.
 */
export function extractCommandWriteTargets(command: string): string[] {
	const tokens = tokenizeShellLike(command);
	const targets: string[] = [];
	for (const segment of splitSegments(tokens)) {
		collectRedirectTargets(segment, targets);
		collectInvokedWriteTargets(segment, targets);
	}
	return targets.filter(isInterestingWriteTarget);
}

const STANDARD_DEV_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

function collectRedirectTargets(segment: ReadonlyArray<string>, out: string[]): void {
	for (let index = 0; index < segment.length - 1; index += 1) {
		const token = segment[index];
		if (token !== ">" && token !== ">>") continue;
		const target = segment[index + 1];
		if (target !== undefined) out.push(target);
	}
}

function collectInvokedWriteTargets(segment: ReadonlyArray<string>, out: string[]): void {
	const cmdIndex = commandTokenIndex(segment);
	if (cmdIndex === null) return;
	const executable = basenameToken(segment[cmdIndex]);
	if (executable === "tee") {
		for (const arg of pathArgs(segment, cmdIndex)) out.push(arg);
		return;
	}
	if (executable === "cp" || executable === "mv") {
		const args = pathArgs(segment, cmdIndex);
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
	}
}

function isInterestingWriteTarget(target: string): boolean {
	if (target.length === 0) return false;
	if (target.startsWith("&")) return false;
	if (STANDARD_DEV_TARGETS.has(target)) return false;
	if (target.startsWith("/dev/fd/")) return false;
	return true;
}

function classifyRedirect(
	segment: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	for (let index = 0; index < segment.length; index += 1) {
		if (segment[index] !== ">") continue;
		const target = segment[index + 1];
		if (target === undefined) continue;
		const matches = matchesForPaths([target], artifacts, "target", "redirect can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "redirect",
				matches,
			};
		}
	}
	return { kind: "benign", matches: [] };
}

function classifyGitOperation(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	const subcommand = args[0];
	if (subcommand === "reset" && args.includes("--hard")) {
		return {
			kind: "destructive",
			operation: "git_reset_hard",
			matches: artifacts.map(({ artifact }) => ({
				artifactPath: artifact.path,
				commandPath: ".",
				reason: "git reset --hard can overwrite protected artifacts",
			})),
		};
	}

	if (subcommand === "checkout" && args.includes("--")) {
		const paths = args.slice(args.indexOf("--") + 1);
		const matches = matchesForPaths(paths, artifacts, "intersects", "git checkout -- can overwrite protected artifacts");
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_checkout",
				matches,
			};
		}
		return { kind: "benign", matches: [] };
	}

	if (subcommand === "restore") {
		const matches = matchesForPaths(
			pathArgs(args.slice(1), -1),
			artifacts,
			"intersects",
			"git restore can overwrite protected artifacts",
		);
		if (matches.length > 0) {
			return {
				kind: "destructive",
				operation: "git_restore",
				matches,
			};
		}
	}

	return { kind: "benign", matches: [] };
}

function classifyFindDelete(
	args: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	if (!args.includes("-delete")) return { kind: "benign", matches: [] };
	const roots: string[] = [];
	for (const token of args) {
		if (token === "-delete" || token.startsWith("-") || token === "(" || token === "!" || token === "not") break;
		if (token === "--") continue;
		roots.push(token);
	}
	const matches = matchesForPaths(
		roots.length === 0 ? ["."] : roots,
		artifacts,
		"intersects",
		"find -delete can remove protected artifacts",
	);
	if (matches.length > 0) {
		return {
			kind: "destructive",
			operation: "find_delete",
			matches,
		};
	}
	return { kind: "benign", matches: [] };
}

function classifyPathOperation(
	operation: DestructiveCommandOperation,
	reason: string,
	paths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
): DestructiveCommandClassification {
	const matches = matchesForPaths(paths, artifacts, "intersects", reason);
	if (matches.length === 0) return { kind: "benign", matches: [] };
	return {
		kind: "destructive",
		operation,
		matches,
	};
}

function matchesForPaths(
	commandPaths: ReadonlyArray<string>,
	artifacts: ReadonlyArray<NormalizedArtifact>,
	mode: "target" | "intersects",
	reason: string,
): ProtectedArtifactCommandMatch[] {
	const matches: ProtectedArtifactCommandMatch[] = [];
	const seen = new Set<string>();
	for (const commandPath of commandPaths) {
		for (const artifact of artifacts) {
			if (!pathMatchesArtifact(commandPath, artifact.key, mode)) continue;
			const key = `${artifact.key}\0${commandPath}\0${reason}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push({
				artifactPath: artifact.artifact.path,
				commandPath,
				reason,
			});
		}
	}
	matches.sort(compareMatches);
	return matches;
}

function pathMatchesArtifact(commandPath: string, artifactKey: string, mode: "target" | "intersects"): boolean {
	const wildcardRoot = wildcardRootKey(commandPath);
	if (wildcardRoot !== null) {
		return isSameOrDescendant(artifactKey, wildcardRoot);
	}
	const commandKey = normalizePathKey(commandPath);
	if (commandKey === null) return false;
	if (mode === "target") return isSameOrDescendant(commandKey, artifactKey);
	return isSameOrDescendant(commandKey, artifactKey) || isSameOrDescendant(artifactKey, commandKey);
}

function validationMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (executable === "npm") {
		if (args[0] === "test") return "npm test";
		if (args[0] === "run" && args[1] === "test") return "npm run test";
	}
	if (executable === "pytest") return "pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return "python -m pytest";
	if (executable === "cargo" && args[0] === "test") return "cargo test";
	if (executable === "go" && args[0] === "test") return "go test";
	if (executable === "ctest") return "ctest";
	if (executable === "make" && args[0] === "test") return "make test";
	if (executable === "ninja" && args[0] === "test") return "ninja test";
	if (executable === "mvn" && args[0] === "test") return "mvn test";
	if ((executable === "gradle" || executable === "gradlew") && args[0] === "test") return "gradle test";
	return null;
}

function moduleArg(args: ReadonlyArray<string>): string | null {
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-m") return args[index + 1] ?? null;
	}
	return null;
}

function isPythonExecutable(executable: string): boolean {
	return executable === "python" || executable === "python3" || /^python3\.\d+$/.test(executable);
}

function pathArgs(segment: ReadonlyArray<string>, commandIndex: number): string[] {
	const args: string[] = [];
	let endOfOptions = false;
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (COMMAND_SEPARATORS.has(token)) break;
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-")) continue;
		if (token === ">" || token === ">>" || token === "<" || token === "<<") {
			index += 1;
			continue;
		}
		args.push(token);
	}
	return args;
}

function tokenizeShellLike(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;

	const pushCurrent = (): void => {
		if (current.length === 0) return;
		tokens.push(current);
		current = "";
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (char === undefined) continue;
		if (quote !== null) {
			if (char === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && char === "\\" && index + 1 < command.length) {
				index += 1;
				current += command[index] ?? "";
				continue;
			}
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			index += 1;
			current += command[index] ?? "";
			continue;
		}
		if (/\s/.test(char)) {
			pushCurrent();
			if (char === "\n") tokens.push(";");
			continue;
		}
		if (char === ";") {
			pushCurrent();
			tokens.push(";");
			continue;
		}
		if (char === "&" && command[index + 1] === "&") {
			pushCurrent();
			tokens.push("&&");
			index += 1;
			continue;
		}
		if (char === "|") {
			pushCurrent();
			if (command[index + 1] === "|") {
				tokens.push("||");
				index += 1;
			} else {
				tokens.push("|");
			}
			continue;
		}
		if (char === ">") {
			pushCurrent();
			if (command[index + 1] === ">") {
				tokens.push(">>");
				index += 1;
			} else {
				tokens.push(">");
			}
			continue;
		}
		if (char === "<") {
			pushCurrent();
			if (command[index + 1] === "<") {
				tokens.push("<<");
				index += 1;
			} else {
				tokens.push("<");
			}
			continue;
		}
		current += char;
	}
	pushCurrent();
	return tokens;
}

function splitSegments(tokens: ReadonlyArray<string>): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of tokens) {
		if (COMMAND_SEPARATORS.has(token)) {
			if (current.length > 0) segments.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

function commandTokenIndex(segment: ReadonlyArray<string>): number | null {
	let index = 0;
	while (index < segment.length) {
		const token = segment[index];
		if (token === undefined) return null;
		if (isEnvAssignment(token)) {
			index += 1;
			continue;
		}
		if (token === "env") {
			index += 1;
			while (
				index < segment.length &&
				(segment[index]?.startsWith("-") === true || isEnvAssignment(segment[index] ?? ""))
			) {
				index += 1;
			}
			continue;
		}
		if (SHELL_WRAPPERS.has(token)) {
			index += 1;
			while (index < segment.length && segment[index]?.startsWith("-") === true) index += 1;
			continue;
		}
		return index;
	}
	return null;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function basenameToken(token: string | undefined): string {
	if (token === undefined) return "";
	const normalized = token.replace(/\\/g, "/");
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return basename.toLowerCase();
}

function artifactMap(artifacts: ReadonlyArray<ProtectedArtifact>): Map<string, ProtectedArtifact> {
	const out = new Map<string, ProtectedArtifact>();
	for (const artifact of artifacts) {
		const key = normalizePathKey(artifact.path);
		if (key !== null) out.set(key, cloneArtifact(artifact));
	}
	return out;
}

function stateFromMap(artifacts: ReadonlyMap<string, ProtectedArtifact>): ProtectedArtifactState {
	return {
		artifacts: Array.from(artifacts.entries())
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([, artifact]) => cloneArtifact(artifact)),
	};
}

function normalizedArtifacts(artifacts: ReadonlyArray<ProtectedArtifact>): NormalizedArtifact[] {
	const out = Array.from(artifactMap(artifacts).entries()).map(([key, artifact]) => ({ key, artifact }));
	out.sort((left, right) => compareStrings(left.key, right.key));
	return out;
}

function cloneArtifact(artifact: ProtectedArtifact): ProtectedArtifact {
	const cloned: ProtectedArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) cloned.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) cloned.validationExitCode = artifact.validationExitCode;
	return cloned;
}

function normalizePathKey(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	const posixInput = trimmed.replace(/\\/g, "/");
	if (path.posix.isAbsolute(posixInput)) return path.posix.normalize(posixInput);
	return path.posix.resolve(posixCwd(), posixInput);
}

function wildcardRootKey(input: string): string | null {
	const firstWildcard = firstWildcardIndex(input);
	if (firstWildcard === null) return null;
	const prefix = input.slice(0, firstWildcard);
	const slash = prefix.lastIndexOf("/");
	const root = slash >= 0 ? prefix.slice(0, slash + 1) : ".";
	return normalizePathKey(root);
}

function firstWildcardIndex(input: string): number | null {
	const indexes = ["*", "?", "["].map((char) => input.indexOf(char)).filter((index) => index >= 0);
	if (indexes.length === 0) return null;
	return Math.min(...indexes);
}

function posixCwd(): string {
	return process.cwd().replace(/\\/g, "/");
}

function isSameOrDescendant(candidate: string, parent: string): boolean {
	if (candidate === parent) return true;
	const relative = path.posix.relative(parent, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.posix.isAbsolute(relative);
}

function compareMatches(left: ProtectedArtifactCommandMatch, right: ProtectedArtifactCommandMatch): number {
	return (
		compareStrings(left.artifactPath, right.artifactPath) ||
		compareStrings(left.commandPath, right.commandPath) ||
		compareStrings(left.reason, right.reason)
	);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
