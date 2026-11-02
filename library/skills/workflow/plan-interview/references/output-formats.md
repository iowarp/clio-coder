# Plan Interview Output Formats

## `ask_user` Complete Call

```json
{
  "action": "complete",
  "summary": "Short interview closeout.",
  "decisions": [
    {
      "key": "primary_outcome",
      "value": "Smallest useful slice",
      "rationale": "The user prioritized fast validation over broad architecture.",
      "confidence": "high",
      "source_question": "What should this plan optimize for first?"
    }
  ]
}
```

## Final Decision Log

```markdown
## Decision Log: <topic>
1. <decision>. Chosen over <alternative> because <reason>
2. ...

Deferred:
- <item>. Safe because <reason>

Open risks:
- <risk or unresolved branch>

Recommended next step:
- <prd | sprint-plan | direct implementation>: <why>
```
