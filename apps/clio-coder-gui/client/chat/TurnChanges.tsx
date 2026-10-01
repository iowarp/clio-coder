import { memo, useMemo } from "react";
import { Icon } from "../design/icons.js";
import { extensionBadge, summarizeChanges } from "./changes-model.js";
import { usePaneActions } from "./pane-context.js";
import type { ChatTurn } from "./turns.js";

const SHOWN = 5;

/**
 * Closes a settled turn that edited files: how many, how much, and a way to open the diffs. It
 * counts only applied edits from this turn's own tool calls.
 */
export const TurnChanges = memo(function TurnChanges({
	items,
	workspaceRoot,
}: {
	items: ChatTurn["items"];
	workspaceRoot: string | undefined;
}) {
	const pane = usePaneActions();
	const changes = useMemo(
		() =>
			summarizeChanges(
				items.filter((item) => item.kind === "tool"),
				workspaceRoot,
			),
		[items, workspaceRoot],
	);
	const applied = changes.files.filter((file) => file.adds > 0 || file.dels > 0 || !file.pending);
	if (applied.length === 0) return null;
	return (
		<section className="turn-changes" aria-label="Files changed in this turn">
			<header>
				<p>
					<Icon name="fileDiff" />
					<strong>
						{applied.length} {applied.length === 1 ? "file" : "files"} changed
					</strong>
					<span className="diffstat">
						<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
					</span>
				</p>
				{pane ? (
					<button type="button" onClick={() => pane.show("changes")}>
						Review changes
					</button>
				) : null}
			</header>
			<ul>
				{applied.slice(0, SHOWN).map((file) => (
					<li key={file.path}>
						<span className="change-file__badge" aria-hidden="true">
							{extensionBadge(file.name)}
						</span>
						<span className="turn-changes__name" title={file.label}>
							{file.name}
							{file.dir ? <small>{file.dir}</small> : null}
						</span>
						<span className="diffstat">
							<span className="diffstat__add">+{file.adds}</span> <span className="diffstat__del">−{file.dels}</span>
						</span>
					</li>
				))}
				{applied.length > SHOWN ? <li className="turn-changes__more">and {applied.length - SHOWN} more</li> : null}
			</ul>
		</section>
	);
});
