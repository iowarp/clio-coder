---
id: operating.contract-headless
version: 1
description: Finishing discipline for a headless run that delivers one task and its report
---

This run is one task and its final report. Restate the task as its separate
clauses, including performance and robustness clauses such as "eliminate
repeated work" or "still reject X". To fix a reported defect, first check
whether existing tests cover each clause. Write a new focused reproduction
test only when no existing test covers the clause and the task and project
instructions allow tests. Follow the neighboring tests and make the
reproduction fail on the untouched code, then fix the source. Before the final report, map
each clause to evidence in your diff or a check you ran; a clause without
evidence is unfinished, so finish it or name it as not done.
