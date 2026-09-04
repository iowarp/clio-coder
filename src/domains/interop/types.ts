import type { DelegationAgentConfig } from "../../core/defaults.js";
import type { AdoptionProvider } from "../context/adoption.js";
import type { SkillSource } from "../resources/skills/loader.js";

export type InteropAgentId =
	| "claude-code"
	| "codex"
	| "opencode"
	| "gemini"
	| "copilot"
	| "cursor"
	| "antigravity"
	| "agents";

/** How a peer is launched over ACP stdio, for the kinds that speak it. */
export interface InteropAcpRecipe {
	command: string;
	args: ReadonlyArray<string>;
	/** npm package carrying the adapter, when the recipe launches one through npx. */
	npmPackage?: string;
	/** Executable that package installs, looked up on PATH before falling back to npx. */
	npmPackageBin?: string;
}

/**
 * One known coding agent, as pure data. Every list of foreign roots, binaries,
 * and instruction files in the tree is a projection of this table.
 */
export interface InteropAgentKind {
	id: InteropAgentId;
	label: string;
	/** Executables whose presence means the agent is installed. Empty for conventions with no CLI. */
	binaryNames: ReadonlyArray<string>;
	/** Home-relative directory the agent owns. */
	userDir: string;
	/** Older home-relative roots still owned by supported installations. */
	legacyUserDirs?: ReadonlyArray<string>;
	/** Project-relative directory the agent owns, when it has one distinct from the repo's own. */
	projectDir?: string;
	/** Older project-relative roots still protected from Clio writes. */
	legacyProjectDirs?: ReadonlyArray<string>;
	userSkillRoot?: string;
	projectSkillRoot?: string;
	userPromptRoot?: string;
	projectPromptRoot?: string;
	/** Project-relative instruction files the context domain mines for rules. */
	instructionFiles: ReadonlyArray<string>;
	acp?: InteropAcpRecipe;
	adoptionProvider?: AdoptionProvider;
	skillSource?: SkillSource;
}

/** A probe that cannot answer reports "unknown"; it never guesses "absent". */
export type InteropPresence = "present" | "absent" | "unknown";

export interface InteropAgentFacts {
	kind: InteropAgentId;
	presence: InteropPresence;
	binary?: string;
	version?: string;
	installDir?: string;
	/** Whether the ACP adapter can launch without a network install. Absent for kinds with no recipe. */
	adapter?: InteropPresence;
	skillCount: number;
	projectArtifacts: number;
}

export type InteropDecision = "accepted" | "declined";

export interface InteropAgentRecord extends InteropAgentFacts {
	/** Fingerprint of the facts a proposal is keyed by. */
	fingerprint: string;
	decision?: InteropDecision;
	decidedAt?: string;
	/** Fingerprint the decision was made against; a change re-proposes the agent. */
	decidedFingerprint?: string;
	/** Fingerprint the boot hint last named, so unchanged facts stay silent. */
	hintedFingerprint?: string;
}

export interface InteropReport {
	version: 1;
	detectedAt: string;
	agents: ReadonlyArray<InteropAgentRecord>;
}

export interface InteropProposal {
	kind: InteropAgentId;
	label: string;
	fingerprint: string;
	/** Exactly the entry `accept` appends to delegation.agents. */
	entry: DelegationAgentConfig;
	/** True when the adapter is not installed locally and npx would fetch it on first use. */
	needsNetworkInstall: boolean;
}

export interface InteropDecisionResult {
	decided: ReadonlyArray<InteropAgentId>;
	/** delegation.agents ids appended by this call. */
	wired: ReadonlyArray<string>;
	diagnostics: ReadonlyArray<string>;
}

export interface InteropDetectInput {
	cwd?: string;
	home?: string;
	/** Run a bounded `<bin> --version` for kinds whose binary already resolved. */
	probeVersion?: boolean;
	/** Skill sources already loaded by the resources domain. Interop counts them and never walks a root. */
	skillSources?: ReadonlyArray<SkillSource>;
	/** Foreign artifact providers already scanned by the context domain. */
	artifactProviders?: ReadonlyArray<AdoptionProvider>;
}
