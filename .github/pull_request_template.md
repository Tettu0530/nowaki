## Summary

<!-- What does this PR change, and why? -->

Closes #

## How I tested it

<!-- Commands you ran and what you checked. -->

## Public API

<!-- The frozen surface is listed in docs/STABILITY.md ("What is frozen"). Check one. -->

- [ ] Doesn't change the public surface
- [ ] Adds to the public surface (new export, route export, config key, flag, env var, event): `api/` snapshots updated, CHANGELOG entry, RFC: <!-- link -->
- [ ] **Breaking change**: removes or changes something in the public surface. The PR has the `breaking` label, targets the next major, updates the `api/` snapshots, has an Upgrade note in the CHANGELOG, and links the accepted RFC: <!-- link -->

## Checklist

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` pass
- [ ] Ran the relevant e2e script from `scripts/ci/` (e.g. `bash scripts/ci/e2e-dev.sh`), or this PR doesn't touch runtime behavior
- [ ] User-facing change → entry under `## [Unreleased]` in `CHANGELOG.md`
- [ ] New or changed defense → covered in `scripts/security-e2e.mjs` and listed in `SECURITY.md`
- [ ] Comments, docs, and messages are in English (AGENTS.md > Conventions)
- [ ] Under 2,000 changed lines, lockfiles excluded (the `PR size` check enforces this for contributor PRs)
- [ ] Commits are signed off (`git commit -s`, per DCO)
