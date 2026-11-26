# Coordinator for Paseo

A Paseo plugin that keeps the human from becoming the bottleneck when many coding agents run at once.

- **Coordinator**: you send a request, a coordinator agent answers it or splits it into graded tasks for worker agents in the right projects, each in its own worktree and branch.
- **Decision inbox**: only decisions that need a human reach you, as cards that read from context to decision. Questions the request already settles are answered by the coordinator and checked by independent reviewer agents first. See [RULES.md](RULES.md).
- **Merge card**: workers finish with verification and a pull request; you squash-merge from the card and the plugin cleans up the branch and workspace.
- **Progress board**: requests and directly launched agents on rows, with columns ordered by how much they wait on you.

See [OVERVIEW.md](OVERVIEW.md) for setup, what the plugin reads and sends, and known limits.

## Install

Requires Paseo 0.17.4 or later with plugins enabled.

```bash
paseo plugin install github:cyb9701/paseo-coordinator
```

## Develop

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-coordinator
paseo plugin reload paseo-coordinator   # after each change
```

## Documents

- [DESIGN.md](DESIGN.md): screens, cards, and data flow (Korean)
- [RULES.md](RULES.md): when the coordinator may decide without a human (Korean)
- [PLAN.md](PLAN.md): implementation phases (Korean)

## License

MIT
