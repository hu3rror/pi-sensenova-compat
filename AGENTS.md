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
- **Gate**: direct flow — CI runs `npm publish --provenance`; a tag push releases immediately, no human 2FA gate. Rollback: `npm unpublish <version>` within 72h (needs local login); after that `npm deprecate`.
- **First release exception**: a package that is not on the registry yet cannot use OIDC (the Trusted Publisher binding requires an existing package) — the maintainer publishes v0.1.0 locally (`npm login` + `npm publish`), then binds the Trusted Publisher on npmjs.com; the CI flow applies from the next version on.
- **Release notes**: this repo publishes a GitHub Release for every tagged version (confirmed by the maintainer, 2026-09). Written by the agent per the write-release-notes skill, then `gh release create` / `gh release edit` (never rely on CI `--generate-notes` placeholders).