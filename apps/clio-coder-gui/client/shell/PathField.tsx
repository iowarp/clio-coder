import { useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { chosenText, isCurrent, moveHighlight, tabCompletion } from "./path-input-model.js";
import "./path-field.css";

/**
 * A folder path box. A browser cannot hand a page a real folder path, so the machine running Clio
 * Coder does both jobs: it completes what is typed (Tab, arrows, any spelling this host understands,
 * Windows drive paths included under WSL) and, on request, opens the operating system's own folder
 * dialog. The caller owns the form and its submit button.
 */
export function PathField({
	client,
	id,
	value,
	onChange,
	onPicked,
	className,
	placeholder = "~/projects/my-app, /home/…, C:\\Users\\…",
	autoFocusMark = false,
	inputRef,
}: {
	client: Client;
	id: string;
	value: string;
	onChange: (next: string) => void;
	/** The OS dialog returned a folder; callers usually open it at once. */
	onPicked: (path: string) => void;
	className?: string;
	placeholder?: string;
	/** Marks the input for a dialog's `data-autofocus` lookup. */
	autoFocusMark?: boolean;
	inputRef?: React.Ref<HTMLInputElement>;
}) {
	const [highlight, setHighlight] = useState(-1);
	const [listOpen, setListOpen] = useState(true);
	const listId = useId();
	const typed = useDeferredValue(value);
	const completion = useQuery({
		queryKey: ["path-complete", typed],
		queryFn: () => client.call(routes.workspacePathComplete, { params: {}, query: { input: typed }, body: {} }),
		enabled: typed.trim() !== "",
		staleTime: 5_000,
		placeholderData: (previous) => previous,
	});
	const pick = useMutation({
		mutationFn: () => client.call(routes.workspacePick, emptyInput, crypto.randomUUID()),
		onSuccess: (result) => {
			if (result.status === "picked") {
				onChange(result.path);
				onPicked(result.path);
			}
		},
	});
	const current = isCurrent(completion.data, value) ? completion.data : undefined;
	const matches = listOpen && current ? current.matches : [];
	const edit = (next: string) => {
		onChange(next);
		setHighlight(-1);
		setListOpen(true);
	};
	return (
		<div className="path-field">
			<div className="path-field__box">
				<input
					id={id}
					ref={inputRef}
					className={className}
					value={value}
					role="combobox"
					aria-expanded={matches.length > 0}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
					{...(autoFocusMark ? { "data-autofocus": true } : {})}
					onChange={(event) => edit(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Tab" && !event.shiftKey && current) {
							const next = tabCompletion(current, value);
							if (next !== null) {
								event.preventDefault();
								edit(next);
							}
						} else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length > 0) {
							event.preventDefault();
							setHighlight(moveHighlight(highlight, matches.length, event.key === "ArrowDown" ? 1 : -1));
						} else if (event.key === "Enter" && highlight >= 0 && current) {
							event.preventDefault();
							const next = chosenText(current, highlight);
							if (next !== null) edit(next);
						} else if (event.key === "Escape" && matches.length > 0) {
							// The first Escape closes the suggestions; the next one reaches the dialog.
							event.preventDefault();
							event.stopPropagation();
							setListOpen(false);
						}
					}}
					placeholder={placeholder}
					autoComplete="off"
					spellCheck={false}
				/>
				{matches.length > 0 && current ? (
					<div className="path-field__matches" id={listId} role="listbox" aria-label="Matching folders">
						{matches.map((match, index) => (
							// The input keeps focus and owns every key; each row is an activedescendant option.
							// biome-ignore lint/a11y/useFocusableInteractive: an activedescendant option must not be a tab stop.
							<div
								key={match.path}
								className="path-field__option"
								id={`${listId}-${index}`}
								role="option"
								aria-selected={index === highlight}
								onMouseDown={(event) => {
									// Keep focus in the box, so typing continues after a click.
									event.preventDefault();
									edit(chosenText(current, index) ?? value);
								}}
							>
								<Icon name="folder" />
								<span>{match.name}</span>
							</div>
						))}
						{current.truncated ? (
							<p className="path-field__more" role="presentation">
								Type more to narrow the list.
							</p>
						) : null}
					</div>
				) : null}
			</div>
			<p className="path-field__hint">
				<span>Tab completes, arrows choose.</span>
				<button type="button" className="path-field__browse" disabled={pick.isPending} onClick={() => pick.mutate()}>
					<Icon name="folderOpen" />
					{pick.isPending ? "Waiting for the folder dialog…" : "Browse this computer"}
				</button>
			</p>
			{pick.data?.status === "unavailable" ? <p role="status">{pick.data.reason}</p> : null}
			{pick.error ? <p role="alert">{pick.error.message}</p> : null}
		</div>
	);
}
