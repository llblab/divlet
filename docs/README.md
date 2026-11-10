# divlet documentation

Start with the [project README](../README.md) for the product overview and a working local launch.

## User guides

- [Using the board](board.md): Canvas controls, selection, panels, components, project files, imports and independent static output.
- [Connecting an agent](agents.md): Pi and MCP setup, the workflow skill, the seven tools and JavaScript entry points.

## Technical guides

- [Web-native core contract](web-native.md): Accepted target semantics, the saved model/editor state/browser projection split, and importer/style-plugin boundaries; not a claim of complete implementation.
- [Architecture](architecture.md): Module ownership, accepted-state commits, persistence, undo/redo, preview trust and the Pi bridge.
- [Project format](format.md): Entry point to the canonical shipped format reference; project schemas, frames, components and generated outputs.
- [Markdown sites](site.md): Configuration, template slots, routes, source ownership, links, live updates and current limits.
- [Testing and validation](testing.md): Test layout, every command (unit, browser suites, PEN fidelity, release, Pi RPC), what each check does and does not prove, and the conventions the suites follow.
- [npm publication](publishing.md): Package and command identity, release gates, product-before-wrapper publication order, and verification after publication.

## Contributor context

- [AGENTS.md](../AGENTS.md): Durable engineering rules and task-completion protocol.
- [BACKLOG.md](../BACKLOG.md): Remaining work and external gates.
- [CHANGELOG.md](../CHANGELOG.md): Implemented changes, with unpublished work kept under Unreleased.

## Agent and example references

- [Board workflow skill](../skills/divlet/SKILL.md): How an agent operates the board; not the contributor protocol.
- [Example documentation site](../examples/site/handbook/content/index.md): Markdown sources used by `npm run demo:site`, with a [guide](../examples/site/handbook/content/guide/index.md) and [first-route walkthrough](../examples/site/handbook/content/guide/start.md).
