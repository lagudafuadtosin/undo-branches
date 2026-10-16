# Records the demo: starts the demo VS Code, sizes its window, records only
# that window with ffmpeg, then makes images/demo.gif.
param([string]$Ffmpeg)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $env:TEMP ("undo-branches-demo-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $dir | Out-Null
$env:UNDO_BRANCHES_TMP = $dir

Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
}
'@

$demo = Start-Process node -ArgumentList (Join-Path $root '.test-build\demo-run.cjs') -WorkingDirectory $root -PassThru -WindowStyle Hidden
while (-not (Test-Path (Join-Path $dir 'ready'))) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Seconds 2
$win = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*greet.ts*' } | Select-Object -First 1
if (-not $win) { throw 'demo window not found' }
[Win]::ShowWindow($win.MainWindowHandle, 9) | Out-Null
[Win]::MoveWindow($win.MainWindowHandle, 40, 40, 1200, 720, $true) | Out-Null
[Win]::SetForegroundWindow($win.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 1
[Win]::SetProcessDPIAware() | Out-Null
$r = New-Object Win+RECT
[Win]::DwmGetWindowAttribute($win.MainWindowHandle, 9, [ref]$r, 16) | Out-Null
$w = ($r.R - $r.L) - (($r.R - $r.L) % 2); $h = ($r.B - $r.T) - (($r.B - $r.T) % 2)
$grab = "-f gdigrab -framerate 15 -offset_x $($r.L) -offset_y $($r.T) -video_size ${w}x${h} -draw_mouse 0 -i desktop"

$mp4 = Join-Path $dir 'demo.mkv'
$psi = New-Object System.Diagnostics.ProcessStartInfo $Ffmpeg
$psi.Arguments = "-y $grab -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv420p `"$mp4`""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$rec = [System.Diagnostics.Process]::Start($psi)
$errTask = $rec.StandardError.ReadToEndAsync()
Start-Sleep -Milliseconds 1200
New-Item (Join-Path $dir 'recording') | Out-Null
while (-not (Test-Path (Join-Path $dir 'done'))) { Start-Sleep -Milliseconds 200 }
Start-Sleep -Milliseconds 600
$rec.StandardInput.Write('q')
$rec.StandardInput.Close()
$rec.WaitForExit(30000) | Out-Null
Set-Content -Path (Join-Path $dir 'ffmpeg.log') -Value $errTask.Result
$demo.WaitForExit(30000) | Out-Null
Write-Output "recorded $mp4"
Write-Output $dir
