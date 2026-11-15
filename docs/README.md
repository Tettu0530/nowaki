# Nowaki documentation

Nowaki is a full-stack web framework with a Rust toolchain: pages render to HTML on the server,
only components in `islands/` ship JavaScript, and Jetstream live islands keep their state on
the server. Start an app with `npm create nowaki`, then read the guides in the order that
fits what you are building.

## Guides

Task-oriented pages, one per feature area, each with a working example from
[`examples/`](../examples).

| Guide | Covers |
| --- | --- |
| [Routing](./guides/routing.md) | `routes/` files, dynamic segments, route groups, API and file routes, special files, typed links, parallel and intercepting routes |
| [Data](./guides/data.md) | loaders, actions, API routes, server functions, `ctx.formData()` and body limits, streaming |
| [Layouts and middleware](./guides/layouts-and-middleware.md) | `_layout`, `_middleware`, nesting, groups |
| [Islands and hydration](./guides/islands.md) | client islands, `client:*` strategies, page scripts, JS budgets |
| [Jetstream live islands](./guides/jetstream.md) | server state, events, `publish()`, rooms, `shared`, presence, transports per server |
| [Content](./guides/content.md) | content collections, Markdown, MDX, Markdoc |
| [Images and fonts](./guides/images-and-fonts.md) | `?image` and `<Image>`, remote images, self-hosted fonts |
| [SEO and metadata](./guides/seo.md) | `meta`, Open Graph, JSON-LD, `<html>` attributes, sitemap.xml, robots.txt |
| [Routing config](./guides/routing-config.md) | redirects, rewrites, headers, `basePath`, `trailingSlash` |
| [i18n](./guides/i18n.md) | locale prefixes, links, detection, localized content |
| [Sessions and env](./guides/sessions-and-env.md) | `ctx.session`, `session.ts`, `.env`, typed `env.ts` |
| [Caching](./guides/caching.md) | ISR, `revalidate`, tags, `revalidatePath` / `revalidateTag`, CDN purge per adapter |
| [View Transitions](./guides/view-transitions.md) | `<Link viewTransition>`, `export const viewTransition`, `transitionName()` |
| [Observability](./guides/observability.md) | Server-Timing, JSON logs, OpenTelemetry, `/__nowaki/health` |
| [Security](./guides/security.md) | CSRF and `csrf = false`, security headers, CSP and `nonce()`, proxies |
| [Dev experience](./guides/dev-experience.md) | `nowaki dev`, HMR, the dev toolbar, MCP, typegen, `nowaki upgrade` |
| [Plugins](./guides/plugins.md) | `transform`, `resolveId`, `load`, virtual modules |

## Deploy

[Deploying Nowaki](./deploy/README.md) compares the targets: what works where, and the
production environment variables.

- [`nowaki start`](./deploy/self-hosted.md): self-hosted, Docker, behind a proxy, several
  instances
- [Node](./deploy/node.md), [Bun](./deploy/bun.md), [Deno](./deploy/deno.md)
- [Cloudflare Workers](./deploy/cloudflare.md)
- [Vercel](./deploy/vercel.md)
- [Static output](./deploy/static.md)

## Reference

Generated from the source and checked in CI:

- [Runtime API](./reference/runtime.md): every export of `@nowaki-dev/runtime` and its subpaths
- [Route module exports](./reference/route-exports.md)
- [File conventions](./reference/file-conventions.md)
- [Config](./reference/config.md): every `nowaki.config` key
- [CLI](./reference/cli.md): commands and flags
- [Environment variables](./reference/env-vars.md)
- [Endpoints](./reference/endpoints.md): `/__nowaki/health`, `/__nowaki/revalidate`, reserved
  prefixes
- [Client events and attributes](./reference/client-events.md)
- [Headers](./reference/headers.md): cache, security and CSP headers

## Upgrading and migrating

- [Upgrade to 1.0](./upgrade-to-1.0.md): from any 0.17+ release
- [Migrate from Next.js](./migrate-from-nextjs.md)
- [Migrate from Astro](./migrate-from-astro.md)
- [CHANGELOG](../CHANGELOG.md): every release, with upgrade notes

## When something goes wrong

[Troubleshooting](./troubleshooting.md) lists the errors people run into, with the cause and
the fix.

## Policies

- [Stability and versioning](./STABILITY.md): what semver covers from 1.0, what counts as
  breaking, deprecation, supported platforms
- [Support](../SUPPORT.md): where to ask, supported release lines, supported adapters
- [Security](../SECURITY.md): reporting a vulnerability, trust boundaries, defenses enabled by
  default
- [Releasing](./RELEASING.md) (maintainers)

## Working on Nowaki itself

[AGENTS.md](../AGENTS.md) (layout, commands, invariants, where each feature lives),
[DESIGN.md](../DESIGN.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
