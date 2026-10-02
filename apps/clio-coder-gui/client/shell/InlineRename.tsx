import { useEffect, useRef, useState } from "react";

/**
 * A title edited in place. Enter or leaving the field saves, Escape and an unchanged value cancel.
 * An empty value is a real answer: the task falls back to its first request as its name.
 */
export function InlineRename({
	value,
	label,
	onCommit,
	onCancel,
	className,
}: {
	value: string;
	label: string;
	onCommit: (next: string) => void;
	onCancel: () => void;
	className?: string;
}) {
	const [draft, setDraft] = useState(value);
	const field = useRef<HTMLInputElement>(null);
	// Enter and the blur it causes when the field unmounts must save once.
	const done = useRef(false);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const finish = (save: boolean) => {
		if (done.current) return;
		done.current = true;
		const next = draft.trim();
		if (save && next !== value.trim()) onCommit(next);
		else onCancel();
	};
	return (
		<input
			ref={field}
			className={className ?? "wb-rename"}
			value={draft}
			maxLength={256}
			aria-label={label}
			placeholder="Name this task"
			spellCheck={false}
			autoComplete="off"
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => finish(true)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					finish(false);
				}
			}}
		/>
	);
}
