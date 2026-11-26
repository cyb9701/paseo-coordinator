Coordinator turns one written request into work done by coding agents across your projects, and brings you only the decisions that need a person. It adds a Coordinator screen to the sidebar with a decision inbox and a progress board, in English and Korean.

## How it works

1. You write a request and optionally pick projects.
2. A coordinator agent reads the request and the allowed projects. It answers questions about the code directly, asks you when the request can be read more than one way, or splits a change into tasks and grades it from A (high risk) to D (simple).
3. Each task gets a worker agent in its own git worktree and branch. Workers that need a decision report it with a tool instead of asking in chat.
4. When the answer is already settled by your request or the repository's conventions, the coordinator proposes it and two or three fresh reviewer agents check it independently. The answer goes to the worker only if every reviewer passes it; you can review and revert it later. Anything else becomes a card for you.
5. A worker finishes by verifying its work, pushing its branch and opening a pull request. You get a merge card with the report, the choices the worker made on its own and the pull request. Merging from the card squash-merges it, deletes the branch and archives the workspace. You can also ask the coordinator about the result or send the worker back with changes.

## Inbox

- Needs reaction: questions from the coordinator, worker questions that need you, failed reviews, pull requests to merge, and permission requests or errors from agents.
- To review: requests the coordinator started on its own, answers to read-only requests, and decisions made automatically after review.

Every card reads top to bottom: your request, the task, what was found, the recommendation with evidence and risks, then the decision and its buttons.

## Setup

- Settings live on the Coordinator screen. Choose the projects the coordinator may use; with none selected it starts no workers.
- Pick the model and thinking effort for the coordinator, the workers and the reviewers. Reviewers must run read-only, so only Claude models in plan mode are offered, at high effort or above.
- Each worker gets a new worktree cut from a base branch, and opens its pull request against that branch. The base is, in order: the branch you pick per project in the new request panel, the branch the coordinator picks when the request builds on unmerged work, the base branch set per project in settings, then the remote default branch (`origin/HEAD`). When the local branch is behind origin, the fresh remote tip is used. A base that exists only on your machine has no pull request: the worker commits on its branch and the card keeps the worktree so you can merge it locally.
- Pull request lookup and merging use the GitHub CLI. `gh` must be installed and signed in, and the project needs a GitHub remote.
- If the pstack plugin is loaded in Claude, grade A, B and C workers start with `/poteto-mode`. You can turn this off in settings.

## What it reads, runs and sends

- Requests, plans, decisions and card history are stored on the host in `plugin-data/paseo-coordinator/state.json` under the Paseo home folder.
- The coordinator reads files only inside the allowed projects and skips secret files such as `.env`, keys and credentials.
- All agents run on your own providers and accounts, so every request uses model time and tokens. Reviews add two or three agents per automatic decision.
- Change workers run in Claude auto mode. Your Claude permission rules still apply; add `ask` rules for commands you want to see, such as `gh pr merge`. Workers are told never to merge, deploy, write to databases or push to other branches, and they report those needs to you instead.
- The plugin itself calls GitHub through `gh` only to read the task branch's pull request, merge it when you press merge, and delete that branch afterwards.

## Limits

- Tested on macOS with Paseo 0.17.4.
- Grade A changes always wait for you, and automatic decisions stop for a rule after you revert two of its last ten.
