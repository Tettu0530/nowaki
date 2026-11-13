# Nowaki RFCs

An RFC ("request for comments") is a design document for a change to Nowaki's public surface.
It is written and discussed before the code, so that the API, its compatibility and its cost
are agreed on first.

## When an RFC is required

An accepted RFC is required for any change to the frozen surface listed in
[docs/STABILITY.md](../docs/STABILITY.md#what-is-frozen):

- a new or changed export of `@nowaki-dev/runtime`, or a new subpath
- a new or changed route or island module export
- a new or changed file convention
- a new or changed `nowaki.config` key
- a new CLI command or flag, or a changed default
- a changed default defense, header or cache behavior
- a new environment variable that users set
- any breaking change (it also needs the `breaking` label and targets the next major)

Not required: bug fixes, docs, tests, performance work, refactors, and changes to what is not
covered (internal modules, wire protocols, dev tools). When in doubt, ask in an issue or a
discussion first.

A security fix under the security exception in docs/STABILITY.md does not wait for an RFC; it
is reviewed privately and documented in the CHANGELOG and SECURITY.md.

## Process

1. **Discuss the idea** (optional but recommended) in
   [Discussions](https://github.com/Tettu0530/nowaki/discussions) or a feature request, to check
   it fits the roadmap.
2. **Write the RFC.** Copy [0000-template.md](./0000-template.md) to
   `rfcs/0000-short-name.md` and fill it in.
3. **Open a pull request** that adds only that file. Rename it to the pull request number,
   zero-padded (`rfcs/0042-short-name.md`).
4. **Discussion.** Anyone can comment on the pull request. The author updates the RFC as the
   design changes.
5. **Final comment period (FCP).** When the discussion has settled, the lead maintainer posts a
   comment proposing to accept or to close the RFC. The FCP lasts 7 days. A new concern raised
   during it either gets answered in the RFC or ends the FCP until it is resolved.
6. **Outcome.** After the FCP, the lead maintainer merges the pull request (the RFC is
   **accepted**) or closes it with the reason (**declined**). Accepted RFCs are linked from
   [ROADMAP.md](../ROADMAP.md).
7. **Implementation** follows in separate pull requests that link the RFC. Accepting an RFC does
   not commit anyone to implementing it. If the implementation shows the design must change, the
   change goes in a follow-up pull request to the RFC file.

An accepted RFC that is later abandoned or replaced gets a status line at its top saying so; the
file is not deleted.

## Status

The status is the first line under the RFC's title: `Draft`, `In FCP`, `Accepted`,
`Implemented (vX.Y.Z)`, `Declined` or `Superseded by NNNN`.
