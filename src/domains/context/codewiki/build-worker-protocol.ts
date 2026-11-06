import type { Fingerprint } from "../fingerprint.js";
import type { Codewiki } from "./schema.js";

/**
 * The committed artifact, named instead of shipped. Structured-cloning a
 * parsed index into the worker and back costs main-thread time proportional to
 * the index size on every reconciliation, including the `code_nav` calls that
 * reconcile nothing. The coordinator already holds the artifact lease, so the
 * file on disk is exactly the object it would have cloned; the worker reads it
 * only on the paths that need its contents.
 */
export interface CodewikiArtifactRef {
	source: "artifact";
	/** `codewikiNeedsBackfill(current)`, computed where the object is already parsed. */
	needsBackfill: boolean;
	/** Source line total the artifact records, so an unchanged fingerprint matches the committed one exactly. */
	loc: number;
}

export type CodewikiBuildWorkerRequest =
	| { kind: "build"; cwd: string; language: Codewiki["language"] }
	| {
			kind: "ensure";
			cwd: string;
			/** Optional when neither state nor an existing artifact identifies the project. */
			language?: Codewiki["language"];
			current: Codewiki | CodewikiArtifactRef | null;
			previous: Fingerprint | null;
	  }
	| {
			kind: "incremental";
			cwd: string;
			current: Codewiki | CodewikiArtifactRef;
			paths: string[];
			/** Retained for no-op batches; absence requires global reconciliation. */
			previous?: Fingerprint | null;
	  };

/** What a build worker starts with. A worker thread has its own module state, so the mode travels with it. */
export interface CodewikiBuildWorkerData {
	request: CodewikiBuildWorkerRequest;
	/** The spawner's `readOnlyMode()`: a read-only reconcile may fetch a grammar but never caches it. */
	readOnly: boolean;
}

export interface CodewikiBuildWorkerResult {
	codewiki: Codewiki;
	fingerprint: Fingerprint;
	changed: boolean;
}

/**
 * What the worker posts back. An unchanged reconciliation leaves `codewiki`
 * null, whether the artifact was handed by reference or as an object: the
 * caller still holds it, and returning it would clone the whole artifact a
 * second time and break the caller's identity-keyed caches.
 */
export interface CodewikiBuildWorkerOutcome {
	codewiki: Codewiki | null;
	fingerprint: Fingerprint;
	changed: boolean;
}

export interface CodewikiBuildProgress {
	stage: "queue" | "enumerate" | "hash" | "grammar" | "parse" | "edges";
	current?: number;
	total?: number;
	path?: string;
}

export type CodewikiBuildWorkerMessage =
	| { progress: CodewikiBuildProgress }
	| { ok: true; result: CodewikiBuildWorkerOutcome }
	| { ok: false; error: string; stack?: string };
