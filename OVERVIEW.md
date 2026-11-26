Coordinator turns one written request into work done by coding agents across your projects, and brings you only the decisions that need a person. It adds a Coordinator screen to the sidebar with a decision inbox and a progress board, in English and Korean.

## How it works

1. You write a request and optionally pick projects.
2. A coordinator agent reads the request and the allowed projects. It answers questions about the code directly, asks everything it needs from you once on a single question card before it starts, or splits a change into tasks, grades it from A (high risk) to D (simple) and starts workers right away.
3. Each task gets a worker agent in its own git worktree and branch, or, when you choose one of your workspaces, in a new session there. Workers that need a decision report it with a tool instead of asking in chat.
4. When the answer is already settled by your request or the repository's conventions, the coordinator proposes it and two or three fresh reviewer agents check it independently. The answer goes to the worker only if every reviewer passes it; it is listed in the request's report, where you can still revert it. Anything else becomes a card for you.
5. When a change needs an investigation first, the report goes back to the coordinator instead of ending as an answer; for grade A it asks you which changes to make. Work outside a worktree (deleting branches or worktrees, deleting a remote branch, running an app) is an operation task that lists exactly what it touches and starts only after you approve the list. Instructions you send while a request runs reach its workers, or become added or dropped tasks.
6. A worker in a new worktree finishes by verifying its work, pushing its branch and opening a pull request. When the request has nothing left to run you get one report with a merge card for each pull request, the workers' reports and the choices they made on their own. Merging squash-merges exactly the commit the card shows, deletes the branch and archives the workspace. In your own workspace a worker only commits; finishing the report closes only the worker's session. You can also ask the coordinator about a result or send the worker back with changes.

## Inbox

- Needs my decision: questions from the coordinator (including approving operation tasks), worker questions that need you, failed reviews, reports with pull requests to merge or work left outside a pull request, stopped tasks, a stopped coordinator, permission requests from agents, and questions and errors from agents you launched yourself. The sidebar badge counts only these.
- To review: answers to read-only requests, and reports with nothing to decide.
- The coordinator asks what it needs once, before it starts. When a request has nothing left to run you get one report: the result of every task, what is left for you (pull requests to merge sit inside it), what the agents decided on their own, and the plan. Starting a request, each finished task and each automatic decision no longer get a card of their own.

A card shows only what to decide and its buttons: the question, its options with the recommended one marked and a one-line risk each. Your request, the situation, reports, verification and how to undo each option are folded under **Details**. Warnings (reviewer objections, pull request conflicts or failing checks, work left outside a pull request), an answer's text, a permission's command and an operation's targets stay outside.

## Setup

- Settings live on the Coordinator screen. Choose the projects the coordinator may use; with none selected it starts no workers.
- Pick the model and thinking effort for the coordinator, the workers and the reviewers. Every agent runs in auto mode. Reviewers must not change the worker's code, so only providers that can also offer a read-only mode are listed (today Claude); their editing tools are removed, and they run at high effort or above.
- By default each task gets a new worktree and a new branch cut from a base branch, and opens its pull request against that base. The base is, in order: the branch the coordinator picks when the request builds on unmerged work, the base branch set per project in settings, then the remote default branch (`origin/HEAD`). To start from a particular branch, say so in the request. A task that depends on an earlier task in the same project continues in that task's worktree and branch, and only the last one opens the pull request. When the local branch is behind origin, the fresh remote tip is used. A base that exists only on your machine has no pull request: the worker commits on its branch and the card keeps the worktree so you can merge it locally.
- Instead of a new worktree you can pick one of your open workspaces per project in the new request panel, or approve one the coordinator proposes. Workers then work there in a new session on the branch checked out there, commit without pushing or opening a pull request, and wait while the workspace has uncommitted changes, another agent works in it, or another unfinished task uses it. A workspace the coordinator proposes cannot be on the default branch for code tasks. The plugin never archives that workspace or deletes its branch.
- Pull request lookup and merging use the GitHub CLI. `gh` must be installed and signed in, and the project needs a GitHub remote.
- If the pstack plugin is loaded in Claude, grade A, B and C workers start with `/poteto-mode`. You can turn this off in settings.

## What it reads, runs and sends

- Requests, plans, decisions and card history are stored on the host in `plugin-data/paseo-coordinator/state.json` under the Paseo home folder.
- The coordinator reads files only inside the allowed projects, through its own tools, and skips secret files such as `.env`, keys and credentials. Its built-in file, search and shell tools are removed.
- All agents run on your own providers and accounts, so every request uses model time and tokens. Reviews add two or three agents per automatic decision.
- Every agent runs in Claude auto mode. Your Claude permission rules still apply to workers; add `ask` rules for commands you want to see, such as `gh pr merge`. Code workers are told never to merge, deploy, write to databases or push to other branches, and they report those needs to you instead. Operation workers may act outside their worktree only on the targets you approved, such as deleting the listed branches or a listed remote branch.
- The plugin archives investigation workspaces once their answer is confirmed or a plan replaces them, and deletes a closed task's local branch only when every commit on it is on a remote.
- The plugin itself calls GitHub through `gh` only to read the task branch's pull request, merge it when you press merge, and delete that branch afterwards.

## Limits

- Tested on macOS with Paseo 0.17.4.
- Grade A changes and operation tasks always wait for your answer. Automatic decisions stop for a rule for the rest of a request after you revert one, and everywhere after you revert two of its last ten; you can switch them off in settings.
- Whether a request is a question or a change is the coordinator's judgment. Once it plans an investigation for a change, the plugin keeps it from ending as an answer; the answer card's button says "End with this answer" so a read request never closes unnoticed.
- For operation tasks, and for a workspace the coordinator proposes, the plugin checks that a question or option you answered showed every target or the workspace directory word for word. The background is folded on the card, so it does not count. Whether your answer approved them is read by the coordinator.
- Investigation workers run in auto mode, so their read-only rule comes from their instructions. If one leaves changes in its worktree, the answer says so and the worktree is kept.
- Paseo 0.17.4 cannot send notifications from a plugin, so a new report shows only as the sidebar count.
- Worker commands do not pass through the plugin. Dangerous commands are stopped by the worker's instructions and your Claude permission rules.
- Canceling a task leaves a pull request it already opened open on GitHub. A request with finished work waiting on a decision cannot be canceled until it is decided.
- A worker waiting on background jobs (for example a build) is given 30 minutes before it is asked to report; a longer build is nudged and may show as stopped until it reports.
- The tests use a fake Paseo API. Two Paseo behaviors are assumed rather than tested: a coordinator that ended with an error works again when it gets a new message, and archiving a workspace removes its worktree.
