param([string]$Out = "$PSScriptRoot\shot.png", [string]$Title = "Track")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process track | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like "E:\GitProjects\*" } | Select-Object -First 1).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output "window not found"; exit 1 }
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
# Downscale big captures so they stay readable but light.
if ($w -gt 1600) {
  $s = 1600 / $w
  $small = New-Object System.Drawing.Bitmap ([int]($w * $s)), ([int]($hh * $s))
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = "HighQualityBicubic"
  $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
  $bmp = $small
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "saved $Out ($w x $hh)"


