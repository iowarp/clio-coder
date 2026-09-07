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

export interface CodewikiBuildWorkerResult {
	codewiki: Codewiki;
	fingerprint: Fingerprint;
	changed: boolean;
}

/**
 * What the worker posts back. An unchanged reconciliation of an artifact it
 * was handed by reference leaves `codewiki` null: the caller still holds the
 * object, and returning it would clone the whole artifact a second time.
 */
export interface CodewikiBuildWorkerOutcome {
	codewiki: Codewiki | null;
	fingerprint: Fingerprint;
	changed: boolean;
}

export type CodewikiBuildWorkerMessage =
	| { ok: true; result: CodewikiBuildWorkerOutcome }
	| { ok: false; error: string; stack?: string };
