// One way to print a shortcut, everywhere one is printed: the palette, Help and Settings. Each key
// is a keycap; a chord's keys sit together, while a sequence (`Esc, Esc`) or a choice (`Up / Down`)
// keeps its separator as text. The whole chord is the accessible name, read once.

import "./interaction.css";

export function Keycaps({ chord, className = "" }: { chord: string; className?: string }) {
	const parts = chord.split(/( \+ |, | \/ )/u);
	return (
		<span className={`keycaps ${className}`.trim()} role="img" aria-label={chord}>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					part === " + " ? null : (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed chord never reorder.
						<span key={index}>{part.trim()}</span>
					)
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed chord never reorder.
					<kbd key={index}>{part}</kbd>
				),
			)}
		</span>
	);
}
