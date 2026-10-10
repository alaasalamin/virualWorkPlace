# Agent Office

A local virtual office where AI agents work as characters at desks. You talk to the
orchestrator (Maya, on Claude Fable); she hires teammates only with your approval and
hands them tasks. Every agent is a Claude Code session running on your Max login.

## Run

    npm install
    npm start          # http://localhost:4545

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
- `public/`: the office UI. Characters are generated from each agent's name.

The usage figure in the chat header is the API-equivalent estimate. On Max it
counts against your usage limits, not money.
