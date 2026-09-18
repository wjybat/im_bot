# Pi source baseline

- Repository: <https://github.com/earendil-works/pi>
- Local reference checkout: `../../research/pi`
- Commit: `dcd461925db2edf69a43c8135db1180d418afd54`
- npm packages: `@earendil-works/pi-agent-core@0.84.3`, `@earendil-works/pi-ai@0.84.3`
- License: MIT; retain the upstream license when redistributing modified Pi code.

The Demo currently extends Pi through its public `Agent`, tool, skill-loading, provider, and event APIs. No upstream source file is modified. If an internal Pi change becomes necessary, develop it in the pinned checkout/fork, add tests there, and consume the built package through a reviewed workspace or internal package version rather than editing `node_modules`.
