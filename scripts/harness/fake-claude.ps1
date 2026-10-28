# Stands in for Claude Code: reports a session through Track's hook (as
# Claude's SessionStart hook would), then stays in the foreground.
'{"session_id":"test-session-42","hook_event_name":"SessionStart","source":"startup"}' | & "$PSScriptRoot\..\..\target\debug\track.exe" --hook session-start
Write-Host "fake claude running (session test-session-42)"
Start-Sleep 600
