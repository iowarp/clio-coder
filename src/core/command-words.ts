/**
 * Readers for the words of one simple command, after the shell has split
 * them: which program a wrapper runs, and whether the script a text program
 * is given (a sed script, an awk program, a `python -c` string) can only
 * compute and print.
 *
 * Every reader is strict. A form it cannot read with certainty is reported
 * as unreadable, never guessed, so a caller that grants something on a
 * reading (a safety exemption, a memory receipt, a fresh-read verdict) grants
 * nothing on a form it does not know. Callers choose which wrappers they look
 * through: a privilege wrapper or one that takes its arguments from input
 * changes what the inner command means for some of them.
 */

/** The program a command word names: its last path component. */
export function commandName(word: string): string {
	return word.split("/").pop() ?? word;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** env's options that leave the command and its directory alone: `-i` and `-` empty the environment, `-u` unsets a name, `-v` traces. */
const ENV_SHORT = { flags: "iv", values: "u" };
const ENV_FLAGS = ["--ignore-environment", "--debug"];
const ENV_VALUES = ["--unset"];
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/u;

/**
 * Short options of one wrapper: flags that stand alone, and options that take
 * a value either attached (`-oL`, `-c3`) or as the next word.
 */
interface ShortOptions {
	readonly flags: string;
	readonly values: string;
}

/**
 * How many words one short-option cluster at `argv[at]` takes, or null when
 * it names an option outside `options`.
 */
function shortCluster(argv: readonly string[], at: number, options: ShortOptions): number | null {
	const word = argv[at] ?? "";
	for (let index = 1; index < word.length; index += 1) {
		const flag = word[index] ?? "";
		if (options.flags.includes(flag)) continue;
		if (!options.values.includes(flag)) return null;
		if (index < word.length - 1) return 1;
		return at + 1 < argv.length ? 2 : null;
	}
	return word.length > 1 ? 1 : null;
}

/**
 * Words one long option at `argv[at]` takes: 1 for a listed flag or a listed
 * value option written `--name=value`, 2 for a value option followed by its
 * value, null for anything else.
 */
function longOption(
	argv: readonly string[],
	at: number,
	flags: ReadonlyArray<string>,
	values: ReadonlyArray<string>,
): number | null {
	const word = argv[at] ?? "";
	if (flags.includes(word)) return 1;
	if (values.includes(word)) return at + 1 < argv.length ? 2 : null;
	const name = word.split("=")[0] ?? "";
	return word.includes("=") && values.includes(name) ? 1 : null;
}

/**
 * Reads options until the first operand. Returns the index of that operand,
 * or null when an option is not one the wrapper is known to take.
 */
function readOptions(
	argv: readonly string[],
	short: ShortOptions,
	longFlags: ReadonlyArray<string> = [],
	longValues: ReadonlyArray<string> = [],
	start = 1,
): number | null {
	let at = start;
	while (at < argv.length) {
		const word = argv[at] ?? "";
		if (word === "--") return at + 1;
		if (!word.startsWith("-") || word === "-") return at;
		const taken = word.startsWith("--") ? longOption(argv, at, longFlags, longValues) : shortCluster(argv, at, short);
		if (taken === null) return null;
		at += taken;
	}
	return at;
}

/**
 * The command a wrapper runs and whose exit status it returns: `[]` when it
 * runs none, null when its options cannot be read with certainty (`env -S`,
 * `env -C`, `command -v`, `sudo -b`, `ionice -p`, any option not listed
 * here), undefined when the program is not such a wrapper. The wrapper may be
 * named by path (`/usr/bin/env`).
 */
export function wrappedCommand(argv: readonly string[]): readonly string[] | null | undefined {
	const wrapper = commandName(argv[0] ?? "");
	let at: number | null = 1;
	const optionsEnd = (): boolean => {
		if (argv[at ?? 0] !== "--") return false;
		at = (at ?? 0) + 1;
		return true;
	};
	switch (wrapper) {
		case "env":
			// `-u` unsets a name, `-i` and `-` empty the environment, `-v` traces.
			// A lone `-` is env's spelling of -i, and options may follow it.
			at = readOptions(argv, ENV_SHORT, ENV_FLAGS, ENV_VALUES);
			while (at !== null && argv[at] === "-" && argv[at - 1] !== "--")
				at = readOptions(argv, ENV_SHORT, ENV_FLAGS, ENV_VALUES, at + 1);
			if (at !== null) while (ENV_ASSIGNMENT.test(argv[at] ?? "")) at += 1;
			break;
		case "nice": {
			const arg = argv[1] ?? "";
			if (arg === "-n" || arg === "--adjustment") at = /^-?\d+$/u.test(argv[2] ?? "") ? 3 : null;
			else if (/^(?:-n-?|--adjustment=-?|-)\d+$/u.test(arg)) at = 2;
			else if (arg.startsWith("-") && arg !== "--") return null;
			if (at === null) return null;
			optionsEnd();
			break;
		}
		case "time":
			if (argv[1] === "-p") at = 2;
			if (!optionsEnd() && (argv[at] ?? "").startsWith("-")) return null;
			break;
		case "timeout":
			at = readOptions(
				argv,
				{ flags: "v", values: "ks" },
				["--preserve-status", "--foreground", "--verbose"],
				["--kill-after", "--signal"],
			);
			if (at === null || !TIMEOUT_DURATION.test(argv[at] ?? "")) return null;
			at += 1;
			break;
		case "command":
			if (argv[1] === "-p") at = 2;
			if (!optionsEnd() && (argv[at] ?? "").startsWith("-")) return null;
			break;
		case "nohup":
		case "exec":
		case "builtin":
			if (!optionsEnd() && (argv[at] ?? "").startsWith("-")) return null;
			break;
		case "sudo":
			// Background (`-b`), edit, list, shell and directory forms do not run
			// the command in place, so they are not read.
			at = readOptions(
				argv,
				{ flags: "EHknPSA", values: "ugpCrtT" },
				["--preserve-env", "--non-interactive", "--stdin", "--set-home", "--reset-timestamp", "--askpass"],
				["--user", "--group", "--prompt", "--close-from", "--role", "--type", "--command-timeout", "--preserve-env"],
			);
			if (at !== null) while (ENV_ASSIGNMENT.test(argv[at] ?? "")) at += 1;
			break;
		case "doas":
			at = readOptions(argv, { flags: "n", values: "u" });
			break;
		case "xargs":
			at = readOptions(
				argv,
				{ flags: "0rtxo", values: "nLsPdEaI" },
				["--null", "--no-run-if-empty", "--verbose", "--exit", "--open-tty"],
				["--max-args", "--max-lines", "--max-chars", "--max-procs", "--delimiter", "--eof", "--arg-file", "--replace"],
			);
			break;
		case "stdbuf":
			at = readOptions(argv, { flags: "", values: "ioe" }, [], ["--input", "--output", "--error"]);
			break;
		case "ionice":
			at = readOptions(argv, { flags: "t", values: "cn" }, ["--ignore"], ["--class", "--classdata"]);
			break;
		case "taskset":
			// The first operand is the CPU mask or list.
			at = readOptions(argv, { flags: "ac", values: "" }, ["--all-tasks", "--cpu-list"]);
			if (at === null || at >= argv.length) return null;
			at += 1;
			break;
		case "chrt":
			// The first operand is the priority.
			at = readOptions(
				argv,
				{ flags: "abdfioRrv", values: "TPD" },
				["--all-tasks", "--batch", "--deadline", "--fifo", "--idle", "--other", "--rr", "--reset-on-fork", "--verbose"],
				["--sched-runtime", "--sched-period", "--sched-deadline"],
			);
			if (at === null || !/^\d+$/u.test(argv[at] ?? "")) return null;
			at += 1;
			break;
		default:
			return undefined;
	}
	return at === null || at > argv.length ? null : argv.slice(at);
}

/**
 * Whether sed with these arguments only reads its input and prints: no
 * in-place edit, no script file, and a script whose commands neither run a
 * command (`e`, the `e` flag of `s`) nor write a file (`w`, `W`, the `w` flag).
 */
export function sedOnlyPrints(args: readonly string[]): boolean {
	const scripts: string[] = [];
	const operands: string[] = [];
	let operandsOnly = false;
	for (let at = 0; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (operandsOnly || word === "-" || !word.startsWith("-")) {
			operands.push(word);
			continue;
		}
		if (word === "--") {
			operandsOnly = true;
			continue;
		}
		if (word.startsWith("--")) {
			const [name, ...value] = word.split("=");
			if (
				[
					"--quiet",
					"--silent",
					"--regexp-extended",
					"--posix",
					"--sandbox",
					"--debug",
					"--separate",
					"--unbuffered",
					"--null-data",
					"--zero-terminated",
				].includes(word)
			)
				continue;
			if (name === "--line-length" && value.length > 0) continue;
			if (name !== "--expression") return false;
			const script = value.length > 0 ? value.join("=") : args[++at];
			if (script === undefined) return false;
			scripts.push(script);
			continue;
		}
		for (let index = 1; index < word.length; index += 1) {
			const flag = word[index] ?? "";
			if ("nErsuz".includes(flag)) continue;
			if (flag !== "e" && flag !== "l") return false;
			const value = index < word.length - 1 ? word.slice(index + 1) : args[++at];
			if (value === undefined) return false;
			if (flag === "e") scripts.push(value);
			break;
		}
	}
	if (scripts.length === 0) {
		const script = operands[0];
		if (script === undefined) return false;
		scripts.push(script);
	}
	// sed joins its -e scripts with newlines before it parses them.
	return sedScriptOnlyPrints(scripts.join("\n"));
}

/** GNU sed's script grammar, read far enough to find every command letter. */
function sedScriptOnlyPrints(script: string): boolean {
	let at = 0;
	const blank = (): void => {
		while (script[at] === " " || script[at] === "\t") at += 1;
	};
	// A delimited part, `at` just past the opening delimiter. sed ends it at the
	// first unescaped delimiter, brackets included.
	const delimited = (delimiter: string): boolean => {
		while (at < script.length) {
			const char = script[at] ?? "";
			if (char === "\\") at += 2;
			else if (char === "\n") return false;
			else if (char === delimiter) {
				at += 1;
				return true;
			} else at += 1;
		}
		return false;
	};
	const address = (second: boolean): boolean => {
		const char = script[at] ?? "";
		if (/\d/u.test(char) || (second && (char === "+" || char === "~"))) {
			at += 1;
			while (/[\d~]/u.test(script[at] ?? "")) at += 1;
			return true;
		}
		if (char === "$") {
			at += 1;
			return true;
		}
		let delimiter = "/";
		if (char === "\\") {
			delimiter = script[at + 1] ?? "\n";
			if (delimiter === "\n" || delimiter === "\\") return false;
			at += 1;
		} else if (char !== "/") return true;
		at += 1;
		if (!delimited(delimiter)) return false;
		while (script[at] === "I" || script[at] === "M") at += 1;
		return true;
	};
	const toLineEnd = (continued: boolean): void => {
		while (at < script.length && script[at] !== "\n") at += continued && script[at] === "\\" ? 2 : 1;
	};
	while (at < script.length) {
		while (/[\s;]/u.test(script[at] ?? "")) at += 1;
		if (at >= script.length) break;
		if (script[at] === "#") {
			toLineEnd(false);
			continue;
		}
		if (!address(false)) return false;
		blank();
		if (script[at] === ",") {
			at += 1;
			blank();
			if (!address(true)) return false;
		}
		blank();
		if (script[at] === "!") {
			at += 1;
			blank();
		}
		const command = script[at] ?? "";
		at += 1;
		if ("{}pPdDnNgGhHx=zF".includes(command)) {
			// no argument
		} else if ("lqQL".includes(command)) {
			blank();
			while (/\d/u.test(script[at] ?? "")) at += 1;
		} else if ("btT:v".includes(command)) {
			while (at < script.length && script[at] !== "\n" && script[at] !== ";") at += 1;
		} else if ("aicrR".includes(command)) {
			// Text to print or a file to read, to the end of the line.
			toLineEnd(true);
		} else if (command === "s" || command === "y") {
			const delimiter = script[at] ?? "\n";
			if (delimiter === "\n" || delimiter === "\\") return false;
			at += 1;
			if (!delimited(delimiter) || !delimited(delimiter)) return false;
			if (command === "s") {
				while (/[gpiImM\d]/u.test(script[at] ?? "")) at += 1;
				// `e` runs the pattern space and `w` writes a file.
				if (script[at] === "e" || script[at] === "w") return false;
			}
		} else {
			// `e`, `w` and `W` run or write; anything else is not a command this reads.
			return false;
		}
		blank();
		const next = script[at];
		if (next !== undefined && !"\n;}#".includes(next)) return false;
	}
	return true;
}

/**
 * Whether awk with these arguments runs only its program over its input: no
 * program file or extension, and a program with no way to run a command or
 * write a file (`system`, a pipe, a redirection, `getline`, an `@` directive).
 * A comparison with `>` reads as a redirection, which only refuses more.
 */
export function awkOnlyPrints(args: readonly string[]): boolean {
	let at = 0;
	for (; at < args.length; at += 1) {
		const word = args[at] ?? "";
		if (word === "--") {
			at += 1;
			break;
		}
		if (word === "-F" || word === "-v") {
			at += 1;
			if (args[at] === undefined) return false;
			continue;
		}
		if (word.startsWith("-F") || word.startsWith("-v")) continue;
		if (word.startsWith("-") && word !== "-") return false;
		break;
	}
	const program = args[at];
	return program !== undefined && !/system|getline|[|>@]/u.test(program);
}

/** Interpreter options that change nothing about what `-c` code can reach. */
const PYTHON_FLAGS: ReadonlySet<string> = new Set([
	"-B",
	"-E",
	"-I",
	"-O",
	"-OO",
	"-P",
	"-q",
	"-s",
	"-S",
	"-u",
	"-b",
	"-bb",
]);

/** Builtins that compute or print and reach nothing else, with the keywords such code uses. */
const PYTHON_NAMES: ReadonlySet<string> = new Set(
	(
		"print len str repr int float bool list dict set tuple frozenset range enumerate zip sorted reversed min max " +
		"sum abs round any all chr ord hex oct bin format divmod pow isinstance map filter True False None and or " +
		"not in is if else elif for while lambda pass break continue"
	).split(" "),
);

/**
 * Every builtin function and keyword. A name outside {@link PYTHON_NAMES} and
 * outside these resolves, in `-c` code, only to what the code itself bound or
 * to a NameError, because the main module holds nothing else without a dunder.
 */
const PYTHON_RESERVED: ReadonlySet<string> = new Set(
	(
		"abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex " +
		"copyright credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr " +
		"globals hasattr hash help hex id input int isinstance issubclass iter len license list locals map max " +
		"memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice " +
		"sorted staticmethod str sum super tuple type vars zip as assert async await class def del except finally " +
		"from global import nonlocal raise return try with yield match case"
	).split(" "),
);

/**
 * Methods of the values such code can build: strings, numbers, lists, dicts
 * and sets. An attribute outside this list could reach a frame or a module
 * (`(x for x in ()).gi_frame.f_builtins`).
 */
const PYTHON_ATTRIBUTES: ReadonlySet<string> = new Set(
	(
		"capitalize casefold center count encode endswith expandtabs find format index isalnum isalpha isascii " +
		"isdecimal isdigit isidentifier islower isnumeric isprintable isspace istitle isupper join ljust lower lstrip " +
		"partition removeprefix removesuffix replace rfind rindex rjust rpartition rsplit rstrip split splitlines " +
		"startswith strip swapcase title translate upper zfill maketrans decode hex fromhex append extend insert pop " +
		"remove reverse sort copy clear keys values items get setdefault update fromkeys popitem add discard union " +
		"intersection difference symmetric_difference issubset issuperset isdisjoint bit_length to_bytes from_bytes " +
		"real imag conjugate numerator denominator is_integer as_integer_ratio"
	).split(" "),
);

/**
 * Whether Python run with these arguments executes only `-c` code that
 * computes and prints: it names no builtin or keyword outside the listed ones,
 * reads no attribute outside the listed methods, and has no dunder and no
 * f-string (whose fields are code). Other names are the code's own.
 */
export function pythonOnlyComputes(args: readonly string[]): boolean {
	let at = 0;
	while (PYTHON_FLAGS.has(args[at] ?? "")) at += 1;
	const code = args[at + 1];
	return args[at] === "-c" && code !== undefined && pythonCodeOnlyComputes(code);
}

const PYTHON_NUMBER =
	/^(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?|\.\d[\d_]*(?:[eE][+-]?\d+)?[jJ]?)/u;

function pythonCodeOnlyComputes(code: string): boolean {
	if (code.includes("__")) return false;
	let previous = "";
	let at = 0;
	while (at < code.length) {
		const char = code[at] ?? "";
		if (char === "#") {
			while (at < code.length && code[at] !== "\n") at += 1;
			continue;
		}
		if (/\s/u.test(char)) {
			at += 1;
			continue;
		}
		// Python folds identifiers to NFKC, so a fullwidth `ｅｘｅｃ` is `exec`.
		if (char.charCodeAt(0) > 0x7f) return false;
		const number = PYTHON_NUMBER.exec(code.slice(at))?.[0];
		if (number !== undefined) {
			at += number.length;
			previous = "0";
			continue;
		}
		const word = /^[A-Za-z_]\w*/u.exec(code.slice(at))?.[0];
		const next = code[at + (word?.length ?? 0)];
		if (word !== undefined && (next === "'" || next === '"')) {
			// A string prefix; `f` and `t` strings hold code.
			if (!/^(?:[rRbBuU]|[rR][bB]|[bB][rR])$/u.test(word)) return false;
			at += word.length;
		} else if (word !== undefined) {
			at += word.length;
			if (previous === "." ? !PYTHON_ATTRIBUTES.has(word) : PYTHON_RESERVED.has(word) && !PYTHON_NAMES.has(word))
				return false;
			previous = "a";
			continue;
		}
		const quote = code[at] ?? "";
		if (quote === "'" || quote === '"') {
			const delimiter = code.startsWith(quote.repeat(3), at) ? quote.repeat(3) : quote;
			at += delimiter.length;
			let closed = false;
			while (at < code.length && !closed) {
				if (code[at] === "\\") at += 2;
				else if (code.startsWith(delimiter, at)) {
					at += delimiter.length;
					closed = true;
				} else if (code[at] === "\n" && delimiter.length === 1) return false;
				else at += 1;
			}
			if (!closed) return false;
			previous = "'";
			continue;
		}
		previous = char;
		at += 1;
	}
	return true;
}
