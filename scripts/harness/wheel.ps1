param([int]$X, [int]$Y, [int]$Notches = -10)
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Wh {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[Wh]::SetProcessDPIAware() | Out-Null
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "$Repo\*" } | Select-Object -First 1).MainWindowHandle
$r = New-Object Wh+RECT
[Wh]::GetWindowRect($h, [ref]$r) | Out-Null
[Wh]::SetCursorPos($r.L + $X, $r.T + $Y) | Out-Null
$step = if ($Notches -lt 0) { -120 } else { 120 }
for ($i = 0; $i -lt [Math]::Abs($Notches); $i++) { [Wh]::mouse_event(0x800, 0, 0, $step, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }

