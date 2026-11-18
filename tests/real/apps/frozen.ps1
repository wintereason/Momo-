param([int]$Secs = 14, [string]$Tag = 'x', [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 4 harness): a window whose UI thread stops answering for -Secs seconds after it is shown.
# 14 s = stays frozen for the whole check; 7 s = recovers by itself part-way through.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form; $f.Text = "$RunId-$Tag"; $f.Width = 300; $f.Height = 200; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(300, 200)
$f.Add_Shown({ [System.Threading.Thread]::Sleep($Secs * 1000) })
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ [Environment]::Exit(0) }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
