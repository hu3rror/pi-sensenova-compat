# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Release conventions (npm)

- **Trigger**: pushing a `v*` tag runs `.github/workflows/publish.yml` (Trusted Publisher / OIDC, zero token, provenance).
- **Who pushes**: the agent bumps `package.json` version (semver three-question rule), tags, and pushes — but only after the user confirms the push in the current turn.
- **Gate**: staged flow (mode A) — CI runs `npm stage publish --provenance`; the maintainer runs `npm stage approve <stage-id>` locally (2FA) to publish. Rollback: `npm stage reject <stage-id>`.
- **First release exception**: a package that is not on the registry yet cannot use OIDC/stage (no create permission) — the maintainer publishes v0.1.0 locally (`npm login` + `npm publish`), then binds the Trusted Publisher on npmjs.com; the CI flow applies from the next version on.
- **Release notes**: this repo publishes a GitHub Release for every tagged version (confirmed by the maintainer, 2026-09). Written by the agent per the write-release-notes skill, then `gh release create` / `gh release edit` (never rely on CI `--generate-notes` placeholders).