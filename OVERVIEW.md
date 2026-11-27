Coordinator watches the coding agents in the projects you choose and brings you what needs a person: decisions an agent stopped on, permission requests, questions and errors. It also lets you check the decisions agents made on their own, with their evidence, assumptions and diffs. You still start and plan the work yourself; the coordinator does not split requests or start agents. English and Korean.

## How it works

Every agent in a watched project, including the ones you start, gets two tools and a short instruction:

- `record_decision`: before acting on a choice that your messages and the repository do not settle, the agent records what it chose, why, the alternatives, its evidence (checked or assumed), whether the choice rests on an assumption, how hard it is to undo and the files it touches.
- `add_followup`: work for later goes to your follow-up list instead of being done now.

The plugin decides whether a recorded decision stops the agent: scope, data shape, interface or user-visible behavior, anything hard to undo, and anything resting on an assumption stop it. The agent then asks about all stopped decisions at once, with its question tool (such as AskUserQuestion) if it has one or in one message, and waits. Either way it records the decisions first. Other decisions are recorded and the agent goes on; you review them later.

## Screens

- **Inbox.** "Needs my decision" has one card per agent with stopped decisions, plus permission requests, questions and errors. A stopped-decision card shows a context summary (what led here, what you decide now, what each answer leads to, what to watch out for), each decision with its evidence, assumptions and diff, and a box for your answer or "Go ahead as proposed". "To review" groups decisions agents made and kept going with, per workspace.
- **Progress.** A table of every agent on the host: one row per workspace, columns for needs my decision, to review, working and waiting, with agent cards in the cells. Rows of watched projects also show pull request state (checks, conflicts, review), decisions waiting or to review, changed files no decision covers, and files also changed in another workspace; "Decisions and changes" opens what was asked, the decisions and the changes.
- **Follow-ups.** Work for later from agents and from you. Hand one to an agent in the same project (that closes it), or close it yourself.
- **Settings.** Projects to watch, context summaries on or off with their model (default `claude/claude-haiku-5-5`) and effort, summary language, text size.

The sidebar badge counts only cards that wait on you. Permission requests, questions and errors come from every agent on the host, watched project or not; decisions, summaries, pull request state and follow-ups cover the watched projects.

## Setup

Paseo 0.17.4 or later with plugins enabled. Tested on macOS with Claude agents. Choose the projects to watch in Settings; with none chosen the plugin changes no session.

## What it reads, runs and stores

- State (decisions, follow-ups, summaries, messages waiting for a busy agent): `plugin-data/paseo-coordinator/state.json` under the Paseo home (`$PASEO_HOME` or `~/.paseo`).
- It reads each agent's messages to show what was asked and to build summaries.
- It runs read-only `git` commands in watched workspaces (`rev-parse`, `merge-base`, `diff`, `ls-files`), at most four workspaces at a time, to find changed files, overlaps and diffs. Diffs are shown only for files the workspace changed.
- Pull request state comes from what Paseo already attaches to each workspace. The plugin does not call GitHub, merge pull requests, delete branches or archive workspaces.
- A summary starts one background agent on your provider with the summary model, in a single hidden workspace the plugin reuses, and archives the agent when done. With Claude its tools are removed; with any provider it runs in a mode that asks for permission, and the plugin denies every request. Summaries run only when an agent stops for your decision, a turn fails (at most once every 10 minutes per agent), or you ask for one; at most two run at once. Turning summaries off stops the automatic ones; the button on a card still works.
- Your answers and instructions are sent to the agent only when it is idle, so they do not cut into a running turn.

## Limits

- An agent can skip recording a choice. "Not in a decision" lists changed files that no decision covers, so such changes stay visible.
- The decision tools reach only sessions opened after you watch a project; open sessions pick them up when they reopen.
- Paseo 0.17.4 has no plugin notifications, so new cards show only in the sidebar badge.
- Cleaning up workspaces, worktrees or branches is out of scope.
- When the plugin restarts or updates during a turn, that turn loses its decision tools until the session reopens. Failed `record_decision` and `add_followup` calls are recorded from the agent's history when the turn ends or when the agent next asks a question.
- "What was asked" and summaries read the recent part of an agent's history, so in a very long session the original request may be missing.
