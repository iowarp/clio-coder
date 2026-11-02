# Modules

- Three responsibilities, not three mandatory layers: **domain** (meaning,
  invariants, pure transitions — no I/O, no ambient time or randomness),
  **application service** (policy and effect ordering through narrow,
  application-owned ports), **adapter** (one boundary's technology and
  translation; raw external types never leak out of it). Wire concrete
  adapters to ports at the composition root only.
- Deep modules: substantial behavior behind a low-burden interface.
  Deletion test: removing a module that makes complexity disappear was
  pass-through waste; removing one that spreads complexity across callers
  was earning its keep.
- Audit existing adapters/services before creating one: reuse as-is,
  extend if cohesive, create new only when reuse would couple wrongly.
