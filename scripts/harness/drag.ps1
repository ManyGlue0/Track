param([int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [string]$ShotMid = "")
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
# Drags with the left button from (X1,Y1) to (X2,Y2), window-relative physical px.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class D {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[D]::SetProcessDPIAware() | Out-Null
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "$Repo\*" } | Select-Object -First 1).MainWindowHandle
$r = New-Object D+RECT
[D]::GetWindowRect($h, [ref]$r) | Out-Null
[D]::SetCursorPos($r.L + $X1, $r.T + $Y1) | Out-Null
Start-Sleep -Milliseconds 100
[D]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le 30; $i++) {
  $x = $X1 + ($X2 - $X1) * $i / 30; $y = $Y1 + ($Y2 - $Y1) * $i / 30
  [D]::SetCursorPos($r.L + [int]$x, $r.T + [int]$y) | Out-Null
  Start-Sleep -Milliseconds 16
}
Start-Sleep -Milliseconds 250
if ($ShotMid) { & "$PSScriptRoot\shot.ps1" -Out $ShotMid | Out-Null }
[D]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)

