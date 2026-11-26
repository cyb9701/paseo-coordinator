Coordinator turns one written request into work done by coding agents across your projects, and brings you only the decisions that need a person. It adds a Coordinator screen to the sidebar with a decision inbox and a progress board, in English and Korean.

## How it works

1. You write a request and optionally pick projects.
2. A coordinator agent reads the request and the allowed projects. It answers questions about the code directly, asks you when the request can be read more than one way, or splits a change into tasks and grades it from A (high risk) to D (simple).
3. Each task gets a worker agent in its own git worktree and branch. Workers that need a decision report it with a tool instead of asking in chat.
4. When the answer is already settled by your request or the repository's conventions, the coordinator proposes it and two or three fresh reviewer agents check it independently. The answer goes to the worker only if every reviewer passes it; you can review and revert it later. Anything else becomes a card for you.
5. When a change needs an investigation first, the report goes back to the coordinator instead of ending as an answer; for grade A it asks you which changes to make. Work outside a worktree (deleting branches or worktrees, deleting a remote branch, running an app) is an operation task that lists exactly what it touches and starts only after you approve the list. Instructions you send while a request runs reach its workers, or become added or dropped tasks.
6. A worker finishes by verifying its work, pushing its branch and opening a pull request. You get a merge card with the report, the choices the worker made on its own and the pull request. Merging from the card squash-merges it, deletes the branch and archives the workspace. You can also ask the coordinator about the result or send the worker back with changes.

## Inbox

- Needs my decision: questions from the coordinator (including approving operation tasks), worker questions that need you, failed reviews, pull requests to merge, finished work left outside a pull request, stopped tasks, a stopped coordinator, and permission requests from agents. The sidebar badge counts only these.
- To review: requests the coordinator started on its own, answers to read-only requests, decisions made automatically after review, and tasks that finished without a pull request and left nothing behind. "Mark all reviewed" closes all of these except answers, because confirming an answer ends its request.

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
- Change workers run in Claude auto mode. Your Claude permission rules still apply; add `ask` rules for commands you want to see, such as `gh pr merge`. Code workers are told never to merge, deploy, write to databases or push to other branches, and they report those needs to you instead. Operation workers may act outside their worktree only on the targets you approved, such as deleting the listed branches or a listed remote branch.
- The plugin archives investigation workspaces once their answer is confirmed or a plan replaces them, and deletes a closed task's local branch only when every commit on it is on a remote.
- The plugin itself calls GitHub through `gh` only to read the task branch's pull request, merge it when you press merge, and delete that branch afterwards.

## Limits

- Tested on macOS with Paseo 0.17.4.
- Grade A changes and operation tasks always wait for your answer. Automatic decisions stop for a rule for the rest of a request after you revert one, and everywhere after you revert two of its last ten; you can switch them off in settings.
- Whether a request is a question or a change is the coordinator's judgment. Once it plans an investigation for a change, the plugin keeps it from ending as an answer; the answer card's button says "End with this answer" so a read request never closes unnoticed.
- For operation tasks the plugin checks that the question you answered listed every target. Whether your answer approved them is read by the coordinator.
- Worker commands do not pass through the plugin. Dangerous commands are stopped by the worker's instructions and your Claude permission rules.
- Canceling a task leaves a pull request it already opened open on GitHub.
- A worker waiting on background jobs (for example a build) is given 30 minutes before it is asked to report; a longer build is nudged and may show as stopped until it reports.
- The tests use a fake Paseo API. Two Paseo behaviors are assumed rather than tested: a coordinator that ended with an error works again when it gets a new message, and archiving a workspace removes its worktree.
