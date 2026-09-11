import { fingerprint } from "./operations.js";
import { AppProblem } from "./problem.js";

/** Epoch-scoped command admission, including duplicate requests while a command is in flight. */
export class Commands {
	private readonly records = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
	run<T>(scope: string, key: string, input: unknown, execute: () => Promise<T>): Promise<T> {
		const id = JSON.stringify([scope, key]),
			digest = fingerprint(input),
			previous = this.records.get(id);
		if (previous) {
			if (previous.fingerprint !== digest)
				throw new AppProblem("conflict", "Idempotency-Key was already used with different input.");
			return previous.result as Promise<T>;
		}
		const result = Promise.resolve().then(execute);
		this.records.set(id, { fingerprint: digest, result });
		return result;
	}
}
