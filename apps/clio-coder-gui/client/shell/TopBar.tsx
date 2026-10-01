import type { ReactNode } from "react";
import { Icon } from "../design/icons.js";
import { chordHint } from "./chords.js";
import { InlineRename } from "./InlineRename.js";
import { useShell } from "./shell-context.js";

/**
 * The strip above a task screen. While the rail is collapsed, or on a phone, it carries the two
 * controls the rail would have offered: reveal it, and start a task.
 */
export function TopBar({
	title,
	children,
	titleLabel,
	rename,
}: {
	title?: string;
	titleLabel?: string;
	children?: ReactNode;
	/** Makes the title editable in place: a click, F2 or the caller's own trigger starts it. */
	rename?: { active: boolean; onStart: () => void; onSave: (label: string) => void; onCancel: () => void };
}) {
	const shell = useShell();
	return (
		<header className="wb-bar">
			<div className="wb-bar__lead">
				<button
					type="button"
					className="wb-icon"
					aria-label="Show sidebar"
					title={`Show sidebar (${chordHint("sidebar")})`}
					onClick={() => shell?.revealSidebar()}
				>
					<Icon name="sidebar" />
				</button>
				<button
					type="button"
					className="wb-icon"
					aria-label="New task"
					title={`New task (${chordHint("newTask")})`}
					disabled={shell?.starting}
					onClick={() => shell?.startTask()}
				>
					<Icon name="compose" />
				</button>
			</div>
			{title ? (
				<h1 className="wb-bar__title" title={titleLabel ?? title}>
					{rename?.active ? (
						<InlineRename value={title} label="Task name" onCommit={rename.onSave} onCancel={rename.onCancel} />
					) : rename ? (
						<button
							type="button"
							className="wb-bar__rename"
							title="Rename task (F2)"
							onClick={rename.onStart}
							onKeyDown={(event) => {
								if (event.key === "F2") {
									event.preventDefault();
									rename.onStart();
								}
							}}
						>
							{title}
						</button>
					) : (
						title
					)}
				</h1>
			) : null}
			{children}
		</header>
	);
}
