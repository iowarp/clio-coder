import { boundedExternalDiagnostic } from "../../core/external-diagnostic.js";

export function admissionDiagnostic(message: string): string {
	const escaped = message.replace(/[\p{Cc}\p{Cf}]/gu, (character) => `\\u{${character.codePointAt(0)?.toString(16)}}`);
	return boundedExternalDiagnostic(escaped, 4096);
}
