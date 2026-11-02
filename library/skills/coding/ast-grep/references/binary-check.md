# Finding the ast-grep binary

If that fails, try the short alias, but verify it is really ast-grep:

```bash
sg --version
```

Only an output that starts with `ast-grep` counts. On many Linux systems
`sg` is the unrelated shadow-utils "switch group" command and prints a
usage error; that is NOT ast-grep. If neither binary is ast-grep, say so
(`npm i -g @ast-grep/cli` or `cargo install ast-grep`) and stop. Do not
fall back to text grep and present it as a structural result.
