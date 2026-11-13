# RFC NNNN: Title

Status: Draft
Author: your GitHub handle
Pull request: link, once opened
Tracking issue: link, if any

## Summary

One paragraph: what changes, for whom.

## Motivation

The problem, with a concrete example app or use case. What people do today and why it falls
short.

## Design

The exact public shape: the `.d.ts` declarations, route exports, `nowaki.config` keys, CLI
flags, environment variables or file conventions, with their defaults. Show how an app uses it.
Describe behavior on `nowaki dev`, `nowaki start` and each deploy adapter (`node`, `static`,
`bun`, `deno`, `cloudflare`, `vercel`) where it differs.

## Compatibility

Is this additive (a 1.x minor), or breaking (the next major)? For a breaking change: what
breaks, the deprecation path in 1.x (see docs/STABILITY.md "Deprecation"), and the Upgrade note.

## Security impact

Which trust boundary or default defense this touches, and which row of SECURITY.md's
"Defenses enabled by default" table changes. "None" is a valid answer if you say why.

## Performance

The per-request cost when the feature is not used (it should be none), the cost when it is used,
and any change to the client JS that ships by default. How you would measure it.

## Documentation

What gets documented, and where (README, docs/, JSDoc in the `.d.ts`, the scaffold templates).

## Alternatives

Other designs considered, including doing nothing, and how other frameworks handle it.

## Unresolved questions

What needs to be settled during discussion or implementation.
