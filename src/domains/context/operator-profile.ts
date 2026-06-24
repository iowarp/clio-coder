/**
 * Operator profile: a small, structured, budgeted set of cross-repo preferences
 * an operator authors explicitly, rendered as one capped prompt section. It is
 * deliberately not a freeform always-on global file and not auto-memory; durable
 * learned preferences belong in approved memory instead.
 *
 * Storage bundles with scoped settings: a user profile at
 * `<configDir>/profile.yaml` is overridden field by field by a project
 * `.clio/profile.yaml`. Every field is a closed enum or a bounded path list, and
 * the rendered section is capped so the profile can never crowd out the task.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveClioDirs } from "../../core/xdg.js";
import { ceilChars } from "../session/context-accounting.js";

export const RESPONSE_POSTURES = ["concise", "balanced", "thorough"] as const;
export const VALIDATION_PREFERENCES = ["tests-first", "manual", "trust"] as const;
export const COMMIT_MESSAGE_STYLES = ["conventional", "descriptive", "terse"] as const;

export type ResponsePosture = (typeof RESPONSE_POSTURES)[number];
export type ValidationPreference = (typeof VALIDATION_PREFERENCES)[number];
export type CommitMessageStyle = (typeof COMMIT_MESSAGE_STYLES)[number];

/** Cap on rendered profile section, in characters. Keeps it a small section. */
export const OPERATOR_PROFILE_MAX_CHARS = 700;
/** Cap on local-only path entries surfaced in the prompt. */
export const OPERATOR_PROFILE_MAX_LOCAL_PATHS = 8;

export interface OperatorProfile {
	responsePosture?: ResponsePosture;
	validationPreference?: ValidationPreference;
	commitMessageStyle?: CommitMessageStyle;
	/** Paths the operator wants kept local-only; advisory, surfaced to the agent. */
	localOnlyPaths?: string[];
}

export type OperatorProfileOrigin = "user" | "project" | "none";

export interface LoadedOperatorProfile {
	profile: OperatorProfile;
	origin: OperatorProfileOrigin;
	sourcePath?: string;
	hash?: string;
	issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEnum<T extends string>(
	value: unknown,
	allowed: ReadonlyArray<T>,
	field: string,
	issues: string[],
): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)) return value as T;
	issues.push(`${field} must be one of ${allowed.join(", ")}`);
	return undefined;
}

function readProfileBlob(value: unknown, issues: string[]): OperatorProfile {
	if (!isRecord(value)) {
		if (value !== null && value !== undefined) issues.push("profile must be a mapping at the root");
		return {};
	}
	const profile: OperatorProfile = {};
	const posture = readEnum(value.responsePosture, RESPONSE_POSTURES, "responsePosture", issues);
	if (posture) profile.responsePosture = posture;
	const validation = readEnum(value.validationPreference, VALIDATION_PREFERENCES, "validationPreference", issues);
	if (validation) profile.validationPreference = validation;
	const commit = readEnum(value.commitMessageStyle, COMMIT_MESSAGE_STYLES, "commitMessageStyle", issues);
	if (commit) profile.commitMessageStyle = commit;
	if (value.localOnlyPaths !== undefined) {
		if (Array.isArray(value.localOnlyPaths)) {
			const paths = value.localOnlyPaths.filter((item): item is string => typeof item === "string" && item.length > 0);
			if (paths.length > 0) profile.localOnlyPaths = paths.slice(0, OPERATOR_PROFILE_MAX_LOCAL_PATHS);
		} else {
			issues.push("localOnlyPaths must be an array of strings");
		}
	}
	return profile;
}

function readProfileFile(path: string, issues: string[]): { profile: OperatorProfile; present: boolean } {
	if (!existsSync(path)) return { profile: {}, present: false };
	try {
		return { profile: readProfileBlob(parseYaml(readFileSync(path, "utf8")), issues), present: true };
	} catch (err) {
		issues.push(`${path}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
		return { profile: {}, present: false };
	}
}

export interface LoadOperatorProfileOptions {
	/** Override the user profile path; defaults to `<configDir>/profile.yaml`. */
	userPath?: string;
}

/**
 * Load the effective operator profile for `cwd`: the user profile with each
 * field overridden by the project profile when set. Never throws.
 */
export function loadOperatorProfile(cwd: string, options: LoadOperatorProfileOptions = {}): LoadedOperatorProfile {
	const issues: string[] = [];
	const userPath = options.userPath ?? join(resolveClioDirs().config, "profile.yaml");
	const projectPath = join(cwd, ".clio", "profile.yaml");
	const user = readProfileFile(userPath, issues);
	const project = readProfileFile(projectPath, issues);
	const profile: OperatorProfile = { ...user.profile, ...project.profile };

	let origin: OperatorProfileOrigin = "none";
	let sourcePath: string | undefined;
	if (project.present) {
		origin = "project";
		sourcePath = projectPath;
	} else if (user.present) {
		origin = "user";
		sourcePath = userPath;
	}

	const result: LoadedOperatorProfile = { profile, origin, issues };
	if (sourcePath !== undefined) {
		result.sourcePath = sourcePath;
		result.hash = createHash("sha256").update(JSON.stringify(profile)).digest("hex").slice(0, 16);
	}
	return result;
}

export interface RenderedOperatorProfile {
	text: string;
	tokenEstimate: number;
}

/**
 * Render the profile as one small capped prompt section, or an empty string when
 * the profile sets nothing. The text is truncated to
 * {@link OPERATOR_PROFILE_MAX_CHARS} so it stays a budgeted section.
 */
export function renderOperatorProfile(profile: OperatorProfile): RenderedOperatorProfile {
	const lines: string[] = [];
	if (profile.responsePosture) lines.push(`- Response posture: ${profile.responsePosture}.`);
	if (profile.validationPreference) lines.push(`- Validation preference: ${profile.validationPreference}.`);
	if (profile.commitMessageStyle) lines.push(`- Commit-message style: ${profile.commitMessageStyle}.`);
	if (profile.localOnlyPaths && profile.localOnlyPaths.length > 0) {
		lines.push(`- Keep local-only (do not push or share): ${profile.localOnlyPaths.join(", ")}.`);
	}
	if (lines.length === 0) return { text: "", tokenEstimate: 0 };
	const full = `## Operator profile\n${lines.join("\n")}`;
	const text = full.length > OPERATOR_PROFILE_MAX_CHARS ? `${full.slice(0, OPERATOR_PROFILE_MAX_CHARS - 1)}…` : full;
	return { text, tokenEstimate: ceilChars(text.length) };
}
