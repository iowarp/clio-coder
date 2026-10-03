# Paper Summary Prompt Template

This template demonstrates a valid standalone **prompt** package for Clio Coder.

## Package Structure

```text
paper-summary/
  README.md                     # Documentation (outside resource root)
  plugin.json                   # Portable manifest declaring kind: prompt
  prompts/
    paper-summary.md            # Reusable prompt template
```

> **Important**: Keep `README.md` at the package root, never inside `prompts/`. Single-kind packages expose exactly one public candidate in their declared resource directory.

## Invocation and Parameters

- **Invocation Name**: Derived from the file path relative to `prompts/`. Here, `prompts/paper-summary.md` exposes `/paper-summary`.
- **Positional Arguments**: `$1`, `$2`, etc. select parsed arguments. Any unquoted whitespace, including a newline, separates arguments; single or double quotes preserve whitespace inside an argument. `$@`, `${@:N}` and `${@:N:L}` join selected arguments with single spaces.
- **Full Arguments String**: `$ARGUMENTS` preserves every byte after the command delimiter, including spaces, quotes and line breaks.
- **Defaults**: `${N:-default}` supplies a missing or empty positional value; `${@:-default}` supplies a default when joined arguments are empty. `${ARGUMENTS:-default}` uses the raw payload when parsed arguments exist and the default otherwise. Inserted values are never expanded recursively.
- **Optional Argument Hint**: The frontmatter `argument-hint: "[paper-path-or-url]"` informs interactive autocomplete of expected inputs.

## Validation

```bash
clio-coder library validate .
```
