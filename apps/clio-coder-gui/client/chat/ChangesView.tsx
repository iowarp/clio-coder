import { useMemo, useState } from "react";
import { Icon } from "../design/icons.js";
import { extensionBadge, type FileChange, summarizeChanges } from "./changes-model.js";
import { DiffView } from "./Diff.js";
import type { PaneSession } from "./pane-model.js";

function FileRow({ file, open, toggle }: { file: FileChange; open: boolean; toggle: () => void }) {
	return (
		<li className="change-file" data-open={open}>
			<button type="button" className="change-file__row" aria-expanded={open} onClick={toggle} title={file.label}>
				<Icon name={open ? "chevronDown" : "chevronRight"} />
				<span className="change-file__badge" aria-hidden="true">
					{extensionBadge(file.name)}
				</span>
				<span className="change-file__name">
					<strong>{file.name}</strong>
					{file.dir ? <small>{file.dir}</small> : null}
				</span>
				{file.pending ? <span className="change-file__pending">pending</span> : null}
				<span className="diffstat">
					<span className="diffstat__add">+{file.adds}</span> <span className="diffstat__del">−{file.dels}</span>
				</span>
			</button>
			{open ? (
				<div className="change-file__diffs">
					{file.calls.map((call) => (
						<DiffView key={call.id} panel={call.panel} />
					))}
				</div>
			) : null}
		</li>
	);
}

/**
 * Every file the task edited or wrote, with the diff of each call. It reads the transcript's own
 * tool records, so a file changed outside this task does not appear here.
 */
export function ChangesView({ session, workspaceRoot }: { session: PaneSession; workspaceRoot: string | undefined }) {
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	if (changes.files.length === 0)
		return (
			<div className="pane-blank">
				<Icon name="fileDiff" />
				<p>No files changed yet.</p>
				<small>When Clio edits or writes a file, its diff appears here.</small>
			</div>
		);
	const allOpen = changes.files.every((file) => opened.has(file.path));
	return (
		<div className="changes">
			<div className="changes__head">
				<p>
					{changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed{" "}
					<span className="diffstat">
						<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
					</span>
				</p>
				<button
					type="button"
					className="pane-link"
					onClick={() => setOpened(allOpen ? new Set() : new Set(changes.files.map((file) => file.path)))}
				>
					{allOpen ? "Collapse all" : "Expand all"}
				</button>
			</div>
			{session.timelineTruncated ? (
				<p className="pane-note">Earlier records are not in this snapshot, so older edits may be missing.</p>
			) : null}
			<ul className="change-files">
				{changes.files.map((file) => (
					<FileRow
						key={file.path}
						file={file}
						open={opened.has(file.path)}
						toggle={() =>
							setOpened((current) => {
								const next = new Set(current);
								if (!next.delete(file.path)) next.add(file.path);
								return next;
							})
						}
					/>
				))}
			</ul>
		</div>
	);
}
