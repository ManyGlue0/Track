param([string]$Out = "$PSScriptRoot\screen.png", [switch]$Minimize, [switch]$Restore)
$Repo = (Resolve-Path "$PSScriptRoot\..\..").Path
# Whole-screen screenshot (Holster's cards live outside Track's window).
# -Minimize / -Restore act on Track Dev's window first.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class S { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
"@
[S]::SetProcessDPIAware() | Out-Null
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "$Repo\*" } | Select-Object -First 1).MainWindowHandle
if ($Minimize -and $h) { [S]::ShowWindow($h, 6) | Out-Null; Start-Sleep -Milliseconds 500 }
if ($Restore -and $h) { [S]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 500 }
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out"
