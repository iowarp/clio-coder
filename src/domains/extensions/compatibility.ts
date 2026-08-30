/**
 * SemVer range evaluation for extension compatibility.
 *
 * Extension manifests are untrusted package input, so this parser is bounded
 * and fail-closed. It accepts the ordinary npm range vocabulary authors use in
 * manifests: comparator sets, `||`, exact and partial versions, wildcards,
 * hyphen ranges, caret ranges, and tilde ranges. Tags and malformed or
 * overlong expressions are rejected instead of being treated as compatible.
 */

import { getVersionInfo } from "../lifecycle/version.js";

const MAX_RANGE_CHARS = 256;

interface SemVer {
	major: number;
	minor: number;
	patch: number;
	prerelease: ReadonlyArray<string | number>;
}

interface PartialVersion {
	major: number | null;
	minor: number | null;
	patch: number | null;
	prerelease: ReadonlyArray<string | number>;
}

type Predicate = (version: SemVer) => boolean;

const NUMERIC = "(?:0|[1-9]\\d*)";
const IDENTIFIER = "[0-9A-Za-z-]+";
const VERSION_RE = new RegExp(
	`^v?(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
);
const PARTIAL_RE = new RegExp(
	`^v?(${NUMERIC}|[xX*])(?:\\.(${NUMERIC}|[xX*]))?(?:\\.(${NUMERIC}|[xX*]))?(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
);

function prerelease(value: string | undefined): ReadonlyArray<string | number> | null {
	if (value === undefined) return [];
	const out: Array<string | number> = [];
	for (const identifier of value.split(".")) {
		if (identifier.length === 0) return null;
		if (/^\d+$/u.test(identifier)) {
			if (identifier.length > 1 && identifier.startsWith("0")) return null;
			const parsed = Number(identifier);
			if (!Number.isSafeInteger(parsed)) return null;
			out.push(parsed);
		} else {
			out.push(identifier);
		}
	}
	return out;
}

function parseSemVer(value: string): SemVer | null {
	const match = VERSION_RE.exec(value);
	if (match === null) return null;
	const parsedPrerelease = prerelease(match[4]);
	if (parsedPrerelease === null) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (![major, minor, patch].every(Number.isSafeInteger)) return null;
	return { major, minor, patch, prerelease: parsedPrerelease };
}

function parsePart(value: string | undefined): number | null {
	if (value === undefined || value === "x" || value === "X" || value === "*") return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePartial(value: string): PartialVersion | null {
	const match = PARTIAL_RE.exec(value);
	if (match === null) return null;
	for (const part of match.slice(1, 4)) {
		if (part === undefined || part === "x" || part === "X" || part === "*") continue;
		if (!Number.isSafeInteger(Number(part))) return null;
	}
	const major = parsePart(match[1]);
	const minor = parsePart(match[2]);
	const patch = parsePart(match[3]);
	// A wildcard closes the core. `1.x.3` is not a range with a coherent
	// meaning, and accepting it differently from npm would be worse than a
	// parse-time refusal.
	if (
		(major === null && (match[2] !== undefined || match[3] !== undefined)) ||
		(minor === null && match[3] !== undefined)
	) {
		return null;
	}
	const parsedPrerelease = prerelease(match[4]);
	if (parsedPrerelease === null) return null;
	if (parsedPrerelease.length > 0 && (major === null || minor === null || patch === null)) return null;
	return { major, minor, patch, prerelease: parsedPrerelease };
}

function compareIdentifiers(left: string | number, right: string | number): number {
	if (left === right) return 0;
	if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
	if (typeof left === "number") return -1;
	if (typeof right === "number") return 1;
	return left < right ? -1 : 1;
}

function compare(left: SemVer, right: SemVer): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0) {
		if (left.prerelease.length === right.prerelease.length) return 0;
		return left.prerelease.length === 0 ? 1 : -1;
	}
	const length = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < length; index += 1) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined || rightPart === undefined) {
			if (leftPart === rightPart) return 0;
			return leftPart === undefined ? -1 : 1;
		}
		const order = compareIdentifiers(leftPart, rightPart);
		if (order !== 0) return order;
	}
	return 0;
}

function floor(partial: PartialVersion): SemVer {
	return {
		major: partial.major ?? 0,
		minor: partial.minor ?? 0,
		patch: partial.patch ?? 0,
		prerelease: partial.prerelease,
	};
}

function nextWildcard(partial: PartialVersion): SemVer | null {
	if (partial.major === null) return null;
	if (partial.minor === null) return { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] };
	if (partial.patch === null) return { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: [] };
	return null;
}

function lowerBound(version: SemVer, inclusive: boolean): Predicate {
	return (candidate) => (inclusive ? compare(candidate, version) >= 0 : compare(candidate, version) > 0);
}

function upperBound(version: SemVer, inclusive: boolean): Predicate {
	return (candidate) => (inclusive ? compare(candidate, version) <= 0 : compare(candidate, version) < 0);
}

function core(version: SemVer): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

function predicatesForToken(token: string): { predicates: Predicate[]; prereleaseCore: string | null } | null {
	const match = /^(<=|>=|<|>|=|~|\^)?(.+)$/u.exec(token);
	if (match === null) return null;
	const operator = match[1] ?? "";
	const partial = parsePartial(match[2] ?? "");
	if (partial === null) return null;
	const base = floor(partial);
	const wildcardUpper = nextWildcard(partial);
	const prereleaseCore = partial.prerelease.length > 0 ? core(base) : null;

	if (operator === "" || operator === "=") {
		if (partial.major === null) return { predicates: [], prereleaseCore };
		if (wildcardUpper !== null) {
			return { predicates: [lowerBound(base, true), upperBound(wildcardUpper, false)], prereleaseCore };
		}
		return { predicates: [(candidate) => compare(candidate, base) === 0], prereleaseCore };
	}
	if (operator === ">=") return { predicates: [lowerBound(base, true)], prereleaseCore };
	if (operator === "<") return { predicates: [upperBound(base, false)], prereleaseCore };
	if (operator === ">") {
		return {
			predicates: [wildcardUpper === null ? lowerBound(base, false) : lowerBound(wildcardUpper, true)],
			prereleaseCore,
		};
	}
	if (operator === "<=") {
		return {
			predicates: [wildcardUpper === null ? upperBound(base, true) : upperBound(wildcardUpper, false)],
			prereleaseCore,
		};
	}
	if (partial.major === null) return { predicates: [], prereleaseCore };
	if (operator === "~") {
		const upper =
			partial.minor === null
				? { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }
				: { major: partial.major, minor: partial.minor + 1, patch: 0, prerelease: [] };
		return { predicates: [lowerBound(base, true), upperBound(upper, false)], prereleaseCore };
	}
	const upper =
		partial.major > 0
			? { major: partial.major + 1, minor: 0, patch: 0, prerelease: [] }
			: partial.minor === null
				? { major: 1, minor: 0, patch: 0, prerelease: [] }
				: (partial.minor ?? 0) > 0
					? { major: 0, minor: (partial.minor ?? 0) + 1, patch: 0, prerelease: [] }
					: partial.patch === null
						? { major: 0, minor: 1, patch: 0, prerelease: [] }
						: { major: 0, minor: 0, patch: (partial.patch ?? 0) + 1, prerelease: [] };
	return { predicates: [lowerBound(base, true), upperBound(upper, false)], prereleaseCore };
}

function predicatesForSet(raw: string): { predicates: Predicate[]; prereleaseCores: ReadonlySet<string> } | null {
	const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(raw);
	if (hyphen !== null) {
		const left = parsePartial(hyphen[1] ?? "");
		const right = parsePartial(hyphen[2] ?? "");
		if (left === null || right === null || left.major === null || right.major === null) return null;
		const rightUpper = nextWildcard(right);
		return {
			predicates: [
				lowerBound(floor(left), true),
				rightUpper === null ? upperBound(floor(right), true) : upperBound(rightUpper, false),
			],
			prereleaseCores: new Set(
				[
					left.prerelease.length > 0 ? core(floor(left)) : null,
					right.prerelease.length > 0 ? core(floor(right)) : null,
				].filter((entry): entry is string => entry !== null),
			),
		};
	}
	const normalized = raw.replace(/(<=|>=|<|>|=|~|\^)\s+/gu, "$1");
	const tokens = normalized.split(/\s+/u).filter((entry) => entry.length > 0);
	if (tokens.length === 0) return null;
	const predicates: Predicate[] = [];
	const prereleaseCores = new Set<string>();
	for (const token of tokens) {
		const parsed = predicatesForToken(token);
		if (parsed === null) return null;
		predicates.push(...parsed.predicates);
		if (parsed.prereleaseCore !== null) prereleaseCores.add(parsed.prereleaseCore);
	}
	return { predicates, prereleaseCores };
}

function parseRange(
	range: string,
): ReadonlyArray<{ predicates: Predicate[]; prereleaseCores: ReadonlySet<string> }> | null {
	const trimmed = range.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_RANGE_CHARS) return null;
	const sets = trimmed.split("||");
	if (sets.some((set) => set.trim().length === 0)) return null;
	const parsed = sets.map((set) => predicatesForSet(set.trim()));
	return parsed.every((set) => set !== null) ? (parsed as Array<NonNullable<(typeof parsed)[number]>>) : null;
}

export function isValidSemVerRange(range: string): boolean {
	return parseRange(range) !== null;
}

export function satisfiesSemVerRange(version: string, range: string): boolean {
	const candidate = parseSemVer(version);
	const sets = parseRange(range);
	if (candidate === null || sets === null) return false;
	return sets.some((set) => {
		if (candidate.prerelease.length > 0 && !set.prereleaseCores.has(core(candidate))) return false;
		return set.predicates.every((predicate) => predicate(candidate));
	});
}

export interface ClioCompatibilityEvaluation {
	rangeValid: boolean;
	satisfied: boolean;
	runningVersion: string;
}

export function evaluateClioCompatibility(
	range: string,
	runningVersion = getVersionInfo().clio,
): ClioCompatibilityEvaluation {
	const rangeValid = isValidSemVerRange(range);
	return {
		rangeValid,
		satisfied: rangeValid && satisfiesSemVerRange(runningVersion, range),
		runningVersion,
	};
}
