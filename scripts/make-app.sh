#!/bin/zsh
# Builds "Agent Office.app" in ~/Applications. Click it to start the office; click again to open or stop it.
set -eu

DIR="${0:A:h:h}"
CTL="$DIR/scripts/agent-office.sh"
APP="$HOME/Applications/Agent Office.app"
chmod +x "$CTL"
mkdir -p "$HOME/Applications"

osacompile -o "$APP" <<EOF
set ctl to quoted form of "$CTL"
if (do shell script ctl & " status") is "running" then
	set choice to button returned of (display dialog "Agent Office is running." buttons {"Cancel", "Stop", "Open"} default button "Open" cancel button "Cancel" with title "Agent Office")
	if choice is "Stop" then
		do shell script ctl & " stop"
		display notification "The office is closed." with title "Agent Office"
	else
		do shell script ctl & " open"
	end if
else
	try
		do shell script ctl & " start"
	on error msg
		display dialog msg buttons {"OK"} default button "OK" with title "Agent Office" with icon stop
		return
	end try
	do shell script ctl & " open"
end if
EOF

echo "Made $APP"
echo "Drag it to the Dock to keep it handy."
