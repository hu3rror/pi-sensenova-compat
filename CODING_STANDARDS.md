# Coding Standards

Rules for code written in this repository. Agent behavior rules live in `AGENTS.md`; trade-off rationale and rejected alternatives live in ADRs. Extend this file as the repo's conventions crystallize.

## Comments

- Default to no comments. Let names and structure make the code self-explanatory.
- Write comments only for reasons the code itself cannot express: hidden constraints, counterintuitive behavior, historical pitfalls, and special compatibility requirements.
- Put trade-off rationale and rejected alternatives in ADRs, not in code comments.

## Out of scope

- Updating or merging an existing standards file: the human decides what changes.
- Writing ADRs: rationale belongs in ADRs, and the doc points there.