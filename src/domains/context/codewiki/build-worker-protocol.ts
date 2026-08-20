import type { Fingerprint } from "../fingerprint.js";
import type { Codewiki } from "./schema.js";

export type CodewikiBuildWorkerRequest =
	| { kind: "build"; cwd: string; language: Codewiki["language"] }
	| {
			kind: "ensure";
			cwd: string;
			/** Optional when neither state nor an existing artifact identifies the project. */
			language?: Codewiki["language"];
			current: Codewiki | null;
			previous: Fingerprint | null;
	  }
	| { kind: "incremental"; cwd: string; current: Codewiki; paths: string[] };

export interface CodewikiBuildWorkerResult {
	codewiki: Codewiki;
	fingerprint: Fingerprint;
	changed: boolean;
}

export type CodewikiBuildWorkerMessage =
	| { ok: true; result: CodewikiBuildWorkerResult }
	| { ok: false; error: string; stack?: string };
