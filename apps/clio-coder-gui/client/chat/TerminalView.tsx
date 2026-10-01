import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { ClioPulse } from "../shell/ClioMark.js";
import type { PaneSession } from "./pane-model.js";
import { type CommandRun, commandRuns } from "./terminal-model.js";

const TAIL_LINES = 14;

function Run({ run }: { run: CommandRun }) {
	const [all, setAll] = useState(false);
	const lines = run.output === "" ? [] : run.output.replace(/\n$/, "").split("\n");
	const hidden = all ? 0 : Math.max(0, lines.length - TAIL_LINES);
	const shown = hidden > 0 ? lines.slice(-TAIL_LINES) : lines;
	return (
		<li className="term-run" data-tone={run.tone}>
			<div className="term-run__line">
				<span className="term-run__prompt" aria-hidden="true">
					$
				</span>
				<code className="term-run__command">{run.command}</code>
				<span className="term-run__status">
					{run.running ? <ClioPulse size={12} /> : null}
					{run.running ? "running" : (run.digest ?? run.statusLabel)}
				</span>
			</div>
			{shown.length > 0 ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll long command output independently.
				<pre className="term-run__output" tabIndex={0}>
					{hidden > 0 ? (
						<button type="button" className="term-run__more" onClick={() => setAll(true)}>
							… {hidden} earlier {hidden === 1 ? "line" : "lines"}
						</button>
					) : null}
					{shown.join("\n")}
				</pre>
			) : null}
			{run.truncated ? <p className="term-run__note">The producer cut this output short.</p> : null}
		</li>
	);
}

/**
 * The commands Clio ran, in order, with what came back. A log of the task, not a shell: nothing typed
 * here reaches a process. The view follows the newest output until the reader scrolls away.
 */
export function TerminalView({ session, workspaceRoot }: { session: PaneSession; workspaceRoot: string | undefined }) {
	const runs = useMemo(() => commandRuns(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const last = runs.at(-1);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the output length is the trigger; the DOM read happens in the callback.
	useEffect(() => {
		const node = scroller.current;
		if (node && pinned.current) node.scrollTop = node.scrollHeight;
	}, [runs.length, last?.output.length]);
	if (runs.length === 0)
		return (
			<div className="pane-blank">
				<Icon name="terminal" />
				<p>No commands yet.</p>
				<small>Shell commands Clio runs for this task are logged here as they happen.</small>
			</div>
		);
	return (
		<div className="term">
			<div
				className="term__scroll"
				ref={scroller}
				onScroll={(event) => {
					const node = event.currentTarget;
					pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
				}}
			>
				<ol className="term__runs">
					{runs.map((run) => (
						<Run key={run.id} run={run} />
					))}
				</ol>
			</div>
			<p className="term__foot">Read-only. Commands Clio ran in this task.</p>
		</div>
	);
}
