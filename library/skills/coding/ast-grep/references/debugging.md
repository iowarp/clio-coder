# Debugging a rule that fails its test

Work through these in order, changing the rule file with `edit`.

1. Strip the rule to its simplest positive key; re-add parts one at a time.
2. Confirm every `has`/`inside` has `stopBy: end`.
3. Dump the tree to check node kinds; never guess a `kind` name:

```bash
ast-grep run --pattern 'async function f() { await g(); }' --lang javascript --debug-query=cst
```

(`cst` = every node; `ast` = named nodes only; `pattern` = how ast-grep
parsed your pattern.) Pipe long dumps through `head -80`. Dump the tree
only after a test has failed; a dump before the first test is a wasted
turn.
