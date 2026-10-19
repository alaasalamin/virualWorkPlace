#!/bin/zsh
# Start, stop or check the office from outside a terminal: agent-office.sh start|stop|status|open
set -u

DIR="${0:A:h:h}"
PORT="${PORT:-4545}"
PID_FILE="$DIR/data/server.pid"
LOG="$DIR/data/server.log"
URL="http://localhost:$PORT"

# Apps opened from Finder don't get the terminal's PATH, so look where Node usually lives.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pid() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

case "${1:-status}" in
  status)
    [[ -n "$(pid)" ]] && echo running || echo stopped
    ;;
  start)
    if [[ -n "$(pid)" ]]; then echo running; exit 0; fi
    if ! command -v node >/dev/null; then echo "Node isn't installed. Get it from https://nodejs.org" >&2; exit 1; fi
    [[ -d "$DIR/node_modules" ]] || (cd "$DIR" && npm install >>"$LOG" 2>&1)
    mkdir -p "$DIR/data"
    cd "$DIR" && nohup node server/index.ts >>"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in {1..40}; do
      [[ -n "$(pid)" ]] && { echo running; exit 0; }
      sleep 0.5
    done
    echo "The office didn't start. Last lines of $LOG:" >&2
    tail -5 "$LOG" >&2
    exit 1
    ;;
  stop)
    p="$(pid)"
    [[ -z "$p" && -f "$PID_FILE" ]] && p="$(cat "$PID_FILE")"
    [[ -n "$p" ]] && kill "$p" 2>/dev/null
    # The server saves its state on the way out; give it a moment.
    for _ in {1..20}; do
      [[ -z "$(pid)" ]] && break
      sleep 0.5
    done
    rm -f "$PID_FILE"
    echo stopped
    ;;
  open)
    open "$URL"
    ;;
  *)
    echo "usage: $0 start|stop|status|open" >&2
    exit 2
    ;;
esac
