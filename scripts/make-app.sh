#!/bin/zsh
# Builds "Agent Office.app" in ~/Applications and pins it to the Dock.
# Click it to start the office and open it in Safari; click again to open or stop it.
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

# Give it the office icon (needs ImageMagick: brew install imagemagick), then re-sign so macOS accepts the change.
if command -v magick >/dev/null; then
  "$DIR/scripts/make-icon.sh" "$APP/Contents/Resources/applet.icns"
  rm -f "$APP/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
  codesign --force --deep -s - "$APP" 2>/dev/null
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
else
  echo "ImageMagick isn't installed, so the app keeps the default icon (brew install imagemagick)."
fi
echo "Made $APP"

# Pin it to the Dock unless it's already there.
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "Agent%20Office.app"; then
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$APP/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock
  echo "Pinned it to the Dock."
fi
