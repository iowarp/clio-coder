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
- **Positional Arguments**: `$1`, `$2`, etc. are replaced by space-separated positional arguments passed to the slash command.
- **Full Arguments String**: `$ARGUMENTS` expands to the full remainder argument string.
- **Optional Argument Hint**: The frontmatter `argument-hint: "[paper-path-or-url]"` informs interactive autocomplete of expected inputs.

## Validation

```bash
clio-coder library validate .
```
