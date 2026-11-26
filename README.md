# Coordinator for Paseo

A [Paseo](https://paseo.sh) plugin that keeps you from becoming the bottleneck when many coding agents work at once. You write one request; a coordinator agent turns it into work for coding agents in the right projects, and only the decisions that need a person reach you.

[한국어 소개](OVERVIEW.ko.md)

![Progress board: one row per request with its grade and projects, and task cards in columns ordered by how much they wait on you](assets/progress-board.png)

*Progress board. Each request is a row; its tasks sit in the column that says who they are waiting on: you, the coordinator and its reviewers, a worker, or nothing yet.*

## How it works

```
You write a request
  → Coordinator agent reads it and the allowed projects
      ├─ answers questions about the code directly
      ├─ asks you when the request can be read more than one way
      └─ splits a change into tasks, grades it A (high risk) to D (simple), and starts workers
  → Each worker runs in its own git worktree and branch
      ├─ needs a decision → report_blocker
      │     ├─ settled by your request or the repo's conventions → coordinator proposes an answer,
      │     │     2–3 fresh read-only reviewer agents check it, all must pass → sent to the worker
      │     └─ otherwise → a decision card for you
      └─ done → verifies, pushes, opens a pull request, report_done
  → Merge card: you squash-merge; the plugin deletes the branch and archives the workspace
```

Grade A changes always wait for you. Automatic answers for a rule stop after you revert two of its last ten.

## Decision inbox

| Needs reaction (work is waiting on you) | To review (work continues) |
| --- | --- |
| Questions from the coordinator | Requests the coordinator started on its own |
| Worker questions that need a person | Answers to read-only requests |
| Answers that failed independent review | Decisions made automatically after review |
| Pull requests to merge | |
| Stopped tasks, permission requests and errors | |

<p>
  <img src="assets/inbox-needs-reaction.png" alt="Needs reaction: a coordinator question card with options and a recommendation for each question, followed by a worker question card" width="49%">
  <img src="assets/inbox-to-review.png" alt="To review: an automatic decision card with its evidence and three passing reviewers, an answer card for a read-only request, and a started-request card with the plan" width="49%">
</p>

Every card reads top to bottom: your request, the task, what was found, the recommendation with evidence, risks and how to undo it, then the decision and its buttons. You can pick the recommendation, write your own instruction, or ask the coordinator first; the questions and answers stay in the task's decision record.

<p>
  <img src="assets/worker-question-card.png" alt="Worker question card: what the worker reported and checked, the coordinator's view with the rule that sent it to you, options with result, risk and undo, and a question already answered by the coordinator" width="49%">
  <img src="assets/merge-card.png" alt="Merge card: the worker's report with verification and the choices it made on its own, the pull request with its size and checks, and a squash-merge button" width="49%">
</p>

*Left: a worker question that needs a person, with a question you already asked the coordinator. Right: a finished task waiting for you to merge its pull request.*

## Requirements

- Paseo 0.17.4 or later with plugins enabled. Tested on macOS.
- A provider for the coordinator and workers. Reviewers need a provider with a read-only mode; today that is Claude (plan mode), at high effort or above.
- The GitHub CLI (`gh`), installed and signed in, and a GitHub remote on each project. The plugin uses it to find the task branch's pull request, merge it when you press merge, and delete the branch.
- Optional: the pstack Claude plugin. Grade A, B and C change workers then start with `/poteto-mode`. You can turn this off in settings.

## Install

```bash
paseo plugin install github:cyb9701/paseo-coordinator
```

A registry listing is under review ([getpaseo/plugins#3341](https://github.com/getpaseo/plugins/issues/3341)).

## Setup

Open **Coordinator** from the sidebar. The badge counts cards that need your reaction.

<img src="assets/sidebar.png" alt="Sidebar with the Coordinator item and a badge showing 4" width="240">

Go to **Settings** (top right):

1. Choose the projects the coordinator may use. With none selected it starts no workers.
2. Pick the model and effort for the coordinator, the workers and the reviewers.
3. Choose whether workers use `/poteto-mode`, and the output language for workspace names and cards.

<img src="assets/settings.png" alt="Settings: coordinator model and effort, worker model and effort, the /poteto-mode switch, and reviewer models" width="60%">

Then press **+ New request**, describe what you want, and optionally pick projects and a done criterion. Leave projects empty to let the coordinator choose among the allowed ones.

<img src="assets/new-request.png" alt="New request panel: a text box for the request, project choices limited to the allowed projects, and an optional done criterion" width="60%">

Change workers run in Claude auto mode, so your Claude permission rules still decide which commands ask you. Add `ask` rules for anything you want to see first, such as `Bash(gh pr merge *)`. Workers are told never to merge, deploy, write to databases or push to other branches, and to report such needs instead.

## What it stores and reads

- Requests, plans, decisions and card history: `plugin-data/paseo-coordinator/state.json` under the Paseo home (`$PASEO_HOME` or `~/.paseo`).
- The coordinator reads files only inside allowed projects, through its own read-only tools. Secret files such as `.env`, keys and credentials, and anything under `.git`, are refused.
- All agents run on your own providers and accounts, so every request uses model time and tokens. Each automatic decision adds two or three reviewer agents.

See [OVERVIEW.md](OVERVIEW.md) for the full list and known limits.

## Develop

```bash
npm install
npm run typecheck
npm test                                # server flow tests, no Paseo needed
paseo plugin install /absolute/path/to/paseo-coordinator
paseo plugin reload paseo-coordinator   # after each change
```

The plugin has no build step and no runtime dependencies beyond what Paseo provides. `npm test` runs the server code against a fake Paseo API: review failures and timeouts, auto-stop, races between hooks and the reconcile pass, dispatch during cancel, and merge-card flows.

## Documents

- [OVERVIEW.md](OVERVIEW.md) / [OVERVIEW.ko.md](OVERVIEW.ko.md): what the plugin does, setup, data and limits
- [RULES.md](RULES.md): when the coordinator may decide without you, and the A–D grades (Korean)
- [DESIGN.md](DESIGN.md): screens, cards and data flow (Korean)
- [PLAN.md](PLAN.md): implementation phases (Korean)

## License

MIT
