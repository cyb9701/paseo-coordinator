# Coordinator for Paseo

> Work in progress. Phases 0–2 of [PLAN.md](PLAN.md) are done; the coordinator agent, automatic review, and pstack integration are not built yet.

A Paseo plugin that keeps the human from becoming the bottleneck when many coding agents run at once.

- **Decision inbox**: every agent that is blocked on you (tool permission, question, plan approval, error) shows up as a card you can resolve in place. Results you have not looked at yet are listed separately.
- **Progress board**: requests and directly launched agents on rows, with columns ordered by how much they wait on you.
- **Coordinator (planned)**: you send a request, a coordinator agent splits it into tasks for coding agents in the right projects, and only decisions that need a human reach your inbox. See [RULES.md](RULES.md) for when it may decide on its own.

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
