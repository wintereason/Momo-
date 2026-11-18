param([string]$Mode = 'normal', [int]$Aware = 0, [int]$X = 200, [int]$Y = 100, [string]$Tag = 'x', [string]$Marker = '', [int]$BlockMs = 4000, [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 6d scenarios): a borderless window of 4x4 distinct coloured blocks with a label in each (so a missing region is unmistakable).
#   Mode: animate (repaints every 30 ms with shifting colours: it never settles) | normal (centred) | offscreen (placed so that its lower part is past the screen edge WHILE it paints) | layered (per-pixel/opacity layered window, centred)
if ($Aware -eq 1) { Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D9 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [void][D9]::SetProcessDPIAware() }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$W = 820; $H = 640; $scale = 1.0; if ($Aware -eq 1) { $scale = 2.0 }
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.Text = "$RunId-blocks-$Tag"
if ($Mode -eq 'offscreen') { $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point($X, $Y) } else { $f.StartPosition = 'CenterScreen' }
if ($Mode -eq 'layered') { $f.Opacity = 0.92 }
$fw = $W; $fh = $H; if ($Aware -eq 1) { $fw = [int]($W * $scale); $fh = [int]($H * $scale) }
$f.Size = New-Object System.Drawing.Size($fw, $fh)
$colors = @(@(200,40,40),@(40,160,70),@(50,90,210),@(220,170,30),@(150,50,170),@(30,160,170),@(230,110,30),@(100,100,100),@(180,60,110),@(60,120,60),@(90,60,190),@(200,200,60),@(40,40,120),@(220,90,90),@(70,190,130),@(130,130,200))
$script:painted = $false; $script:phase = 0
$p = New-Object System.Windows.Forms.Panel; $p.Dock = 'Fill'; $p.BackColor = [System.Drawing.Color]::FromArgb(20,20,24)
$p.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($p, $true, $null)
$p.Add_Paint({ param($s, $e)
  if (-not $script:painted) { return }
  $g = $e.Graphics; $g.ScaleTransform([single]$scale, [single]$scale); $g.TextRenderingHint = 'ClearTypeGridFit'
  $font = New-Object System.Drawing.Font('Segoe UI', [single]22, [System.Drawing.GraphicsUnit]::Pixel)
  for ($i = 0; $i -lt 16; $i++) { $c = $colors[($i + $script:phase) % 16]; $bx = ($i % 4) * 205; $by = [Math]::Floor($i / 4) * 160
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($c[0], $c[1], $c[2]))), $bx + 4, $by + 4, 197, 152)
    $g.DrawString("Block " + ($i + 1), $font, [System.Drawing.Brushes]::White, $bx + 20, $by + 60) }
})
$f.Controls.Add($p)
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 700
$t.Add_Tick({ $t.Stop(); $script:painted = $true; $p.Invalidate(); $p.Update(); $f.Text = "$RunId-blocks-$Tag PAINTED" })
$f.Add_Shown({ $t.Start() })
if ($Mode -eq 'animate') { $at = New-Object System.Windows.Forms.Timer; $at.Interval = 30; $at.Add_Tick({ if ($script:painted) { $script:phase++; $p.Invalidate() } }); $f.Add_Shown({ $at.Start() }) }
if ($Mode -eq 'busy') {
  $bt = New-Object System.Windows.Forms.Timer; $bt.Interval = 3000
  $bt.Add_Tick({ $bt.Stop(); [System.IO.File]::WriteAllText($Marker, 'start'); [System.Threading.Thread]::Sleep($BlockMs); [System.IO.File]::WriteAllText($Marker, 'end'); $bt.Interval = 3000; $bt.Start() })
  $f.Add_Shown({ $bt.Start() })
}
# self-destruct: a crashed runner can never leave this window behind for long
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ $f.Close() }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
