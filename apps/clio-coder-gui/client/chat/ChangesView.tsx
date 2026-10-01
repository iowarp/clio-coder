import { useMemo, useState } from "react";
import { Icon } from "../design/icons.js";
import { extensionBadge, type FileChange, summarizeChanges, touchedFiles } from "./changes-model.js";
import { DiffView } from "./Diff.js";
import type { PaneSession } from "./pane-model.js";

const TOUCHED_SHOWN = 60;

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
 * Every file the task edited or wrote, with the diff of each call, then the other paths its tools
 * reported. It reads the transcript's own tool records, so a file changed outside this task does not
 * appear here.
 */
export function ChangesView({ session, workspaceRoot }: { session: PaneSession; workspaceRoot: string | undefined }) {
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const touched = useMemo(
		() => touchedFiles(session.tools, workspaceRoot, new Set(changes.files.map((file) => file.path))),
		[session.tools, workspaceRoot, changes.files],
	);
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
	if (changes.files.length === 0 && touched.length === 0)
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
			{changes.files.length > 0 ? (
				<div className="changes__head">
					<p>
						{changes.applied > 0 ? (
							<>
								{changes.applied} {changes.applied === 1 ? "file" : "files"} changed{" "}
								<span className="diffstat">
									<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
								</span>
							</>
						) : null}
						{changes.pending > 0 ? `${changes.applied > 0 ? " · " : ""}${changes.pending} waiting for approval` : null}
					</p>
					<button
						type="button"
						className="pane-link"
						onClick={() => setOpened(allOpen ? new Set() : new Set(changes.files.map((file) => file.path)))}
					>
						{allOpen ? "Collapse all" : "Expand all"}
					</button>
				</div>
			) : (
				<p className="pane-note">No file has been changed yet.</p>
			)}
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
			{touched.length > 0 ? (
				<details className="touched" open={changes.files.length === 0}>
					<summary>
						<Icon name="chevronRight" />
						<span>Also touched</span>
						<span className="pane__count">{touched.length}</span>
					</summary>
					<ul className="touched__files">
						{touched.slice(0, TOUCHED_SHOWN).map((file) => (
							<li key={file.path} title={file.label}>
								<span className="change-file__badge" aria-hidden="true">
									{extensionBadge(file.name)}
								</span>
								<span className="change-file__name">
									<strong>{file.name}</strong>
									{file.dir ? <small>{file.dir}</small> : null}
								</span>
								{file.calls > 1 ? <span className="touched__calls">{file.calls}×</span> : null}
							</li>
						))}
					</ul>
					{touched.length > TOUCHED_SHOWN ? (
						<p className="pane-note">{touched.length - TOUCHED_SHOWN} more paths were reported by tools.</p>
					) : null}
				</details>
			) : null}
		</div>
	);
}
