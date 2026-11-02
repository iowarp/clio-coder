# ast-grep Arguments

```text
/skill ast-grep [--lang <language>] [--path <dir>] <structural question>
```

- `--lang`: tree-sitter language name (`javascript`, `typescript`, `python`,
  `rust`, `go`, ...). Omit to infer from the files under `--path`.
- `--path`: directory or file to scan. Omit to scan the project source
  directory (`src/` when it exists, otherwise `.`).
- Everything else is the question: what shape to find, what to exclude.

Examples:

- `/skill ast-grep find async functions that await but have no try/catch`
- `/skill ast-grep --lang python --path app/ find calls to open() outside a with block`
