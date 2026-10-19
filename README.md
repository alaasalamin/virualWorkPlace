# Agent Office

A local virtual office where AI agents work as characters at desks. The office is a map
of teams. Each team has its own building, project and orchestrator. You talk to an
orchestrator, who hires teammates only with your approval and hands them tasks.
Teammates review each other's work and message each other, and you watch them walk
over and talk in speech bubbles. Every agent is a Claude Code session running on your
Max login.

Drag or scroll to move around the map, and ctrl+scroll or the +/− buttons to zoom.
Click an empty lot to build a new team, or click a team's sign to rename it.

Each building has a whiteboard: click it for the team's task board, which fills in on
its own as work is assigned, reviewed and finished. Stopped tasks can be retried.
Click a worker's laptop to see the files they changed as diffs, and the TV for a live
preview of the team's site. Previews are served on the next port (4546), sandboxed so
pages agents write can't control the office. For projects with their own server, type
its address in the preview bar. Turn on alerts for a chime and notifications when
someone needs your OK.

Each team has a safe (bottom-left of its office) for environment variables per
environment (local, prod, …). It's encrypted with AES-256-GCM in `data/vaults/`, with
the key in your macOS Keychain under "agent-office-vault". Team members can list keys,
save values and write `.env` files straight from the safe; anything outside `local`,
and reading a value into an agent's context, needs your OK. Safe values are replaced
with `[secret env:KEY]` in chats, task cards and messages between agents. Open
`/#demo` to watch a pretend conversation without using any usage.

## Run

    npm install
    npm start          # http://localhost:4545

Or make a Mac app for it with `scripts/make-app.sh`. It puts "Agent Office" in
`~/Applications`: click it to start the office and open it in the browser, and click
it again to open or stop it. From a terminal, `scripts/agent-office.sh start|stop|status`
does the same. The server's output goes to `data/server.log`.

Requires Node 24+ and Claude Code logged in (`claude` → `/login`). Don't set
`ANTHROPIC_API_KEY`; the server strips it so agents use your subscription.

## How it works

- `server/runtime.ts`: runs each agent through the Claude Agent SDK. The orchestrator
  gets three tools: `list_team`, `propose_agent` (blocks until you approve) and
  `assign_task`.
- Workers can read anything and edit files inside their own project folder
  (`../projects/<project>`). Anything else, such as commands that change things,
  shows an approval memo.
- `server/store.ts`: agents and chat history in `data/state.json`. Sessions resume
  after a restart.
- When an agent's conversation passes 100k tokens, its next task starts a fresh
  session, which keeps turns fast and cheap. Set `AGENT_OFFICE_CLEAR_AT` to change
  the limit. A team's Reset button clears everyone's session at once.
- `public/`: the office UI. Characters are generated from each agent's name.

The usage figure in the chat header is the API-equivalent estimate. On Max it
counts against your usage limits, not money.
