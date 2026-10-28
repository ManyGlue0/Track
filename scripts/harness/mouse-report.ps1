# Acts like a TUI that reads the mouse (Claude Code's fullscreen mode): turns on
# mouse reporting for 6 s and prints what the terminal sent. A right-click
# should arrive as a report (ESC[<2;x;yM), never as pasted clipboard text.
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class C {
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
}
"@
$h = [C]::GetStdHandle(-10); $old = 0; [C]::GetConsoleMode($h, [ref]$old) | Out-Null
# VT input (0x200) without line input/echo/processed input: reports arrive as characters.
[C]::SetConsoleMode($h, 0x200) | Out-Null
[Console]::Write("`e[?1000h`e[?1006h")
$end = (Get-Date).AddSeconds(6)
$got = ""
while ((Get-Date) -lt $end) {
  while ([Console]::KeyAvailable) { $got += [Console]::ReadKey($true).KeyChar }
  Start-Sleep -Milliseconds 50
}
[Console]::Write("`e[?1000l`e[?1006l")
[C]::SetConsoleMode($h, $old) | Out-Null
"received: " + ($got -replace "`e", "ESC")
