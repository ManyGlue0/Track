param([string]$Folder = (Resolve-Path "$PSScriptRoot\..\..").Path, [string]$Out = "$PSScriptRoot\explorer.png", [switch]$Invoke)
# Opens an Explorer window on $Folder, right-clicks its background, and screenshots the menu.
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class X {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[X]::SetProcessDPIAware() | Out-Null
$shell = New-Object -ComObject Shell.Application
$before = @($shell.Windows() | ForEach-Object { $_.HWND })
Start-Process explorer.exe $Folder
$win = $null
for ($i = 0; $i -lt 40 -and -not $win; $i++) {
  Start-Sleep -Milliseconds 250
  $win = $shell.Windows() | Where-Object { $before -notcontains $_.HWND } | Select-Object -First 1
}
if (-not $win) { "no explorer window"; exit 1 }
$h = [IntPtr]$win.HWND
[X]::MoveWindow($h, 120, 120, 1000, 640, $true) | Out-Null
[X]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1500
# Empty background near the bottom-right of the file list.
[X]::SetCursorPos(120 + 900, 120 + 580) | Out-Null
Start-Sleep -Milliseconds 200
[X]::mouse_event(0x8, 0, 0, 0, [UIntPtr]::Zero); [X]::mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1500
$bmp = New-Object System.Drawing.Bitmap 1500, 900
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(100, 100, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"hwnd=$($win.HWND)"
