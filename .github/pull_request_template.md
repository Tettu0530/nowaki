## Summary

<!-- What does this PR change, and why? -->

Closes #

## How I tested it

<!-- Commands you ran and what you checked. -->

## Checklist

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` pass
- [ ] Ran the relevant e2e script from `scripts/ci/` (e.g. `bash scripts/ci/e2e-dev.sh`), or this PR doesn't touch runtime behavior
- [ ] User-facing change → entry under `## [Unreleased]` in `CHANGELOG.md`
- [ ] New or changed defense → covered in `scripts/security-e2e.mjs` and listed in `SECURITY.md`
- [ ] Comments, docs, and messages are in English (AGENTS.md > Conventions)
- [ ] Under 2,000 changed lines, lockfiles excluded (the `PR size` check enforces this for contributor PRs)
- [ ] Commits are signed off (`git commit -s`, per DCO)
