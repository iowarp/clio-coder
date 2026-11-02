# ast-grep Rule Examples

```yaml
id: async-no-trycatch
language: javascript
rule:
  all:
    - kind: function_declaration
    - has: {pattern: await $EXPR, stopBy: end}
    - not:
        has: {pattern: 'try { $$$ } catch ($E) { $$$ }', stopBy: end}
```

This example is verified against ast-grep 0.45 on JavaScript. When the
question is this one, use it verbatim. Two facts it encodes that models
guess wrong: tree-sitter JavaScript and TypeScript have no
`async_function_declaration` kind (the `async` keyword is a token inside
`function_declaration`; assert it with `pattern: 'async function $F($$$) { $$$ }'`
when async matters), and an unknown `kind` fails the whole rule with
`Kind ... is invalid` (exit 8); answer that error with the tree dump in
Step 4, never with another guessed name.

Simple one-node patterns skip the rule file:

```bash
ast-grep run --pattern 'console.log($ARG)' --lang javascript src
```
