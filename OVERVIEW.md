Coordinator watches the coding agents in the projects you choose and brings you what needs a person: decisions an agent stopped on, permission requests, questions and errors. It also lets you check the decisions agents made on their own, with their evidence, assumptions and diffs. A coordinator session reads the conversations when you ask, finds the sessions waiting on you and drafts a reply you can send. You still start and plan the work yourself; the coordinator does not split requests or start agents. English and Korean.

## How it works

Every agent in a watched project, including the ones you start, gets three tools and a short instruction:

- `record_decision`: before acting on a choice that your messages and the repository do not settle, the agent records a one-line title, what it chose, why, the alternatives, its evidence (checked or assumed), whether the choice rests on an assumption, how hard it is to undo and the files it touches.
- `add_followup`: work outside the request becomes a suggestion on your request list instead of being done now.
- `report_work`: when it finishes or gets blocked, the agent reports once what it did and its evidence.

The plugin decides whether a recorded decision stops the agent: scope, data shape, interface or user-visible behavior, anything hard to undo, and anything resting on an assumption stop it. The agent then asks about all stopped decisions at once, with its question tool (such as AskUserQuestion) if it has one or in one message, and waits. Either way it records the decisions first. Other decisions are recorded and the agent goes on; you review them later.

Cards come from signals first (permission requests, question windows, errors, stopped decisions, work reports). When an agent ends a turn with none of those, a one-off question finder agent reads that session and makes a card if the agent asks you something or says it finished; it never messages the agent. It is always on.

The coordinator is one session in its own workspace (project `coordinator`), started fresh for each "Request digest" (the previous one is archived, so old digests do not pile up in its context) and works only when you press it or send it a message. On a digest it reads the idle sessions in watched projects and marks each as waiting on you (one-sentence question plus a suggested reply, or the information that is missing), a result to check, or nothing due. It answers purely factual questions (which branch, which file, pull request state) for you, only within that digest, and checks each work report against the agent's conversation. It never approves, chooses between options, grants permissions or accepts work.

## Screens

- **Inbox.** The coordinator sits at the top: request a digest, message it or open it, and see the factual answers it gave. "Needs my decision" has one short card per agent with stopped decisions: what to decide now in one line, each decision as a title with the agent's proposal, an assumption warning and alternative chips, then "Go ahead as proposed" or your answer. "Ask first" asks the agent before you decide, and the answer stays on the card. The context, evidence and diffs are folded. Permission requests, questions and errors come here too, and so do the sessions the question finder or the coordinator found waiting on you, with a suggested reply you can edit and send. "To review" lists results the question finder or the coordinator says to check, work reports it could not confirm, and the decisions agents made and kept going with, one line each.
- **Progress.** A table of every agent on the host: one row per workspace, columns for needs my decision, to review, working and waiting, with agent cards in the cells. Rows of watched projects also show pull request state, decision counts, changed files no decision covers and files also changed in another workspace. "Decisions and changes" lists the workspace's decisions one line each, with "Looks right", "Revert" and "Redo differently"; opening a line shows its evidence and diff. "Request" gives the workspace more work.
- **Requests.** Extra work for running workspaces: requests waiting for a busy agent (cancel them before they are sent), agents' suggestions (send or dismiss), and requests already sent.
- **Settings.** Projects to watch, context summaries on or off with their model (default `claude/claude-haiku-5-5`) and effort, the coordinator model (also used by the question finder) (default `claude/claude-sonnet-5-5`) and effort, the language of summaries and the coordinator, text size.

The sidebar badge counts only cards that wait on you. Permission requests, questions and errors come from every agent on the host, watched project or not; decisions, summaries and pull request state cover the watched projects.

## Setup

Paseo 0.17.4 or later with plugins enabled. Tested on macOS with Claude agents. Choose the projects to watch in Settings; with none chosen the plugin changes no session.

## What it reads, runs and stores

- State (decisions, requests, questions you asked agents, summaries, coordinator judgments, factual answers and work reports, messages waiting for a busy agent): `plugin-data/paseo-coordinator/state.json` under the Paseo home (`$PASEO_HOME` or `~/.paseo`), readable only by your account.
- It reads each agent's messages to show what was asked and to build summaries.
- It runs read-only `git` commands in watched workspaces (`rev-parse`, `merge-base`, `diff`, `ls-files`), at most four workspaces at a time, to find changed files, overlaps and diffs. Diffs are shown only for files the workspace changed.
- Pull request state comes from what Paseo already attaches to each workspace. The plugin does not call GitHub, merge pull requests, delete branches or archive workspaces.
- The coordinator session runs on your provider with the coordinator model, in a mode that asks for permission; it may use only its four board tools and the plugin denies every other request. It reads the recent conversation of each idle session in watched projects during a digest. Its factual answers reach an agent as a message marked as information, not a decision by you.
- The question finder starts one hidden agent with the coordinator model in the coordinator's workspace for each turn that ends with no card, reads that session's recent conversation, and archives the agent; at most two run at once and they use no tools.
- A summary starts one hidden agent on your provider with the summary model, in the coordinator's workspace, and archives the agent when done. With Claude its tools are removed; with any provider it runs in a mode that asks for permission, and the plugin denies every request. Summaries run only when an agent stops for your decision, a turn fails (at most once every 10 minutes per agent), or you ask for one; at most two run at once. Turning summaries off stops the automatic ones; the button on a card still works.
- Your answers, requests and instructions are sent to the agent only when it is idle, so they do not cut into a running turn. When the agent is waiting in a question window, "Ask first" answers that window with your question.

## Limits

- An agent can skip recording a choice. "Not in a decision" lists changed files that no decision covers, so such changes stay visible.
- The decision tools reach only sessions opened after you watch a project; open sessions pick them up when they reopen.
- Paseo 0.17.4 has no plugin notifications, so new cards show only in the sidebar badge.
- Cleaning up workspaces, worktrees or branches is out of scope.
- When the plugin restarts or updates during a turn, that turn loses its decision tools until the session reopens. Failed `record_decision` and `add_followup` calls are recorded from the agent's history when the turn ends or when the agent next asks a question.
- Judgments by the question finder and the coordinator come from a model and can be wrong: a card for something the agent did not ask, or a missed question. Signal cards stay the reliable path.
- "What was asked" and summaries read the recent part of an agent's history, so in a very long session the original request may be missing.
