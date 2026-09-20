import { useSyncExternalStore } from "react";
import type { Problem } from "../../contracts/common.js";
import { ApiProblem } from "../api/client.js";

let problems: Problem[] = [];
const listeners = new Set<() => void>();
const snapshot = () => problems;
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export function reportProblem(error: unknown) {
	if (!(error instanceof ApiProblem)) return;
	problems = [...problems.filter((problem) => problem.instance !== error.problem.instance), error.problem].slice(-5);
	for (const listener of listeners) listener();
}
function dismiss(instance: string) {
	problems = problems.filter((problem) => problem.instance !== instance);
	for (const listener of listeners) listener();
}
export function ProblemToasts() {
	const values = useSyncExternalStore(subscribe, snapshot, snapshot);
	return (
		<section className="toast-region" aria-label="Notifications">
			{values.map((problem) => (
				<div className="problem-toast" key={problem.instance} role="alert">
					<div className="toast-heading">
						<strong>{problem.title}</strong>
						<button
							type="button"
							aria-label={`Dismiss ${problem.code} notification`}
							onClick={() => dismiss(problem.instance)}
						>
							×
						</button>
					</div>
					<p>{problem.detail}</p>
					<code>{problem.code}</code>
					<small>Reference: {problem.instance}</small>
				</div>
			))}
		</section>
	);
}
