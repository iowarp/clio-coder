---
name: dataset-curation
description: Guidelines and verification procedures for scientific dataset curation, schema compliance, and FAIR data standards.
version: 1.0.0
license: Apache-2.0
clio-coder:
  registry-id: dataset-curation
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/_authoring/templates/plugin
  provenance: designed
  eval-status: scenarios-recorded
triggers:
  - curate dataset
  - fair data check
  - validate dataset schema
  - dataset curation
allowed-tools:
  - read
  - grep
  - find
  - ls
---

# Dataset Curation Skill

Guide for inspecting, curating, and validating scientific datasets against FAIR data standards.

## Reference Guidelines

Consult ${pluginRoot}/assets/curation-guide.md for domain quality invariants and metadata checklists.

## Procedure

1. **Scan Dataset Directory**: Use `ls` and `find` to map all data files and metadata descriptors.
2. **Review Metadata**: Verify existence of licensing, provenance records, and format declarations.
3. **Inspect Content**: Verify column names, missing-value sentinels, and unit definitions against the curation guidelines.
4. **Compile Assessment**: Report missing fields, format violations, and recommendations for FAIR compliance.
