param([string[]]$Keys, [int]$Delay = 350)
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
# Sends keystrokes to Track: brings it to the front, then SendKeys each item.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class F {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "$Repo\*" } | Select-Object -First 1).MainWindowHandle
# An Alt tap lets this process move the foreground.
if ($env:TRACK_ALT) { [F]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [F]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero) }
[F]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 250
foreach ($k in $Keys) {
  [System.Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds $Delay
}


