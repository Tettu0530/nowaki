# Governance

This document describes how Nowaki is run: who decides, how changes are proposed, and who can
merge and publish. It writes down how the project already works.

## Roles

- **Lead maintainer.** Sets the roadmap, makes the final call on design questions and RFCs,
  adds and removes maintainers, and publishes releases. Listed in [MAINTAINERS.md](./MAINTAINERS.md).
- **Maintainers.** Review and merge pull requests, triage issues, and take part in RFC
  discussions. Listed in [MAINTAINERS.md](./MAINTAINERS.md).
- **Contributors.** Anyone who opens an issue, a discussion, a pull request or an RFC.

## How decisions are made

- Most changes are decided in their pull request: a maintainer reviews it, and it merges once
  it has a maintainer approval and a green `CI OK` check (enforced by the `maintainer-review`
  ruleset and [CODEOWNERS](./.github/CODEOWNERS)).
- Changes to the frozen public surface ([docs/STABILITY.md](./docs/STABILITY.md#what-is-frozen))
  need an accepted RFC first ([rfcs/README.md](./rfcs/README.md)).
- Maintainers try to reach agreement in the open, on the issue, pull request or RFC. When they
  don't agree, the lead maintainer decides and writes the reason down where the discussion
  happened.
- The lead maintainer decides the roadmap ([ROADMAP.md](./ROADMAP.md)). When a contributor pull
  request duplicates roadmap work already in progress, the roadmap work is kept and the
  duplicate is closed with a pointer to it.

## Becoming a maintainer

There is no fixed quota. The usual path:

1. Sustained contributions over several months: merged pull requests, reviews, issue triage,
   docs, or RFCs.
2. Familiarity with the architecture invariants in [AGENTS.md](./AGENTS.md) and the security
   invariants in [SECURITY.md](./SECURITY.md).
3. The lead maintainer nominates the contributor, asks the existing maintainers for objections
   for 7 days, and adds them to MAINTAINERS.md in a pull request.

A maintainer stops being one when they ask to step down, or after 12 months with no activity
(they can come back by asking). The lead maintainer can also remove a maintainer for a Code of
Conduct violation. Former maintainers are listed as emeritus in MAINTAINERS.md.

If the lead maintainer steps down, they name a successor from the maintainers in a pull request
to this file and MAINTAINERS.md.

## Merging and publishing

- **Merge:** maintainers with write access, under the rules above.
- **Publish:** only the lead maintainer publishes releases (npm, crates.io, GitHub Releases),
  following [docs/RELEASING.md](./docs/RELEASING.md). Publishing credentials are not shared.
- **Security advisories:** the lead maintainer handles private reports and publishes advisories
  ([SECURITY.md](./SECURITY.md)).

## Code of Conduct

Everyone in the project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). Report violations
to **contact@tettu.dev**. The lead maintainer handles reports; a report about the lead
maintainer can go to any other maintainer listed in MAINTAINERS.md.

## Changing this document

Changes to GOVERNANCE.md are made by pull request, are open for comment for at least 7 days,
and are merged by the lead maintainer.
