param([int]$X, [int]$Y, [switch]$Right, [switch]$Middle, [switch]$Double)
# Clicks at (X, Y) relative to Track's window top-left, in physical pixels.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[M]::SetProcessDPIAware() | Out-Null
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "E:\GitProjects\*" } | Select-Object -First 1).MainWindowHandle
[M]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [M]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[M]::SetForegroundWindow($h) | Out-Null
$r = New-Object M+RECT
[M]::GetWindowRect($h, [ref]$r) | Out-Null
[M]::SetCursorPos($r.L + $X, $r.T + $Y) | Out-Null
Start-Sleep -Milliseconds 120
$down = if ($Right) { 0x8 } elseif ($Middle) { 0x20 } else { 0x2 }
$up = if ($Right) { 0x10 } elseif ($Middle) { 0x40 } else { 0x4 }
$n = if ($Double) { 2 } else { 1 }
for ($i = 0; $i -lt $n; $i++) {
  [M]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  [M]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}

