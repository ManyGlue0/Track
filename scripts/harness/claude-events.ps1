param(
  [Parameter(Mandatory)] [string]$Event,
  [string]$Json = "{}",
  [int]$Index = 0
)
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
# Sends one Claude Code hook event to a Track Dev terminal from outside it, so
# Track Dev can stay in the background (Holster notifications only show then).
# -Event: session-start | prompt | notification | tool-done | stop | session-end
# -Json: the hook payload, e.g. '{"notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}'
# -Index: which terminal of the active screen (0 = first).
# Leave session_id out of -Json: Track remembers it as the terminal's chat and
# types `claude --resume <id>` there when Track Dev restarts.
$dev = Get-Process track | Where-Object { $_.Path -like "$Repo\*" } | Select-Object -First 1
if (-not $dev) { "Track Dev isn't running"; exit 1 }
$port = (Get-NetTCPConnection -OwningProcess $dev.Id -State Listen | Where-Object LocalAddress -eq "127.0.0.1" | Select-Object -First 1).LocalPort
$ws = Get-Content "$env:APPDATA\app.track.dev\workspace.json" -Raw | ConvertFrom-Json
$screen = $ws.screens | Where-Object id -eq $ws.activeScreen
$env:TRACK_TERM = $screen.terminals[$Index]
$env:TRACK_PORT = $port
$Json | & "$Repo\target\debug\track.exe" --hook $Event
"sent $Event to $($env:TRACK_TERM) on port $port"
