# UI test harness

Small PowerShell scripts for driving the dev build (`pnpm dev:app`, "Track Dev")
and checking it with screenshots. They target the `track.exe` under
this repo, never the installed one. Coordinates are window-relative
physical pixels (1280×800 window, scale 1.0).

- `shot.ps1 [-Out file.png]`: screenshot of the Track window.
- `click.ps1 -X -Y [-Right] [-Middle] [-Double]`: click inside the window (middle-click closes a tab).
- `keys.ps1 -Keys @("text{ENTER}", "^+n")`: SendKeys. Escape `{ } ( ) [ ] + ^ % ~`
  as `{{}` etc.; for complex commands put them in a .ps1 and type `& path.ps1`.
  Set `$env:TRACK_ALT=1` to tap Alt first (only if the window won't come forward).
- `drag.ps1 -X1 -Y1 -X2 -Y2 [-ShotMid file]`: left-drag (carrying terminals).
- `wheel.ps1 -X -Y -Notches n`: mouse wheel (hold Ctrl yourself via keybd_event for Ctrl+scroll).
- `explorer-test.ps1`: opens an Explorer window and right-clicks its background
  (to see "Open in Track"); Explorer may open behind Track.
- `fake-claude.ps1`: reports a fake Claude session (`test-session-42`) through
  the hook and stays in the foreground, like `claude` would; for testing resume.
- `claude-events.ps1 -Event <name> -Json <payload> -Index n`: sends a Claude Code hook
  event to a Track Dev terminal from outside, so Track Dev can stay in the
  background (Holster notifications only show then). No `session_id` in the payload.
- `screen.ps1 [-Minimize] [-Restore]`: whole-screen screenshot (Holster's cards), optionally
  minimizing or restoring Track Dev first.
- `mouse-report.ps1`: run inside a terminal; turns on mouse reporting for 6 s and prints
  what arrives (a right-click must come through as a report, not a paste).
- Admin terminals without a UAC prompt: start Track Dev with
  `TRACK_ADMIN_WITHOUT_UAC=1 pnpm dev:app` (dev builds only). The helper then runs
  unelevated but takes the same path (pipe, spawn, input, resize, exit).
