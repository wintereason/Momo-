param([string]$Spec, [string]$Log, [string]$State, [int]$Aware = 0, [string]$Tag = 'x', [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 6c harness). A borderless owner-drawn window: filled buttons with labels, a status line.
# It LOGS every click it really receives (which button was hit, and where), writes its own state, and can react to a hovering pointer:
#   mode: normal | evasive (the hovered button moves away) | vanish (it disappears) | relabel (it turns into "Delete") | decoy (a twin with the same label appears) | movewin (the window moves)
# spec JSON: { mode, bg:[r,g,b], status:"Ready", buttons:[ { label, x, y, w, h, color:[r,g,b], fg:[r,g,b], font(px), effect:{ status | hide | open }, real:bool } ] }  (logical window units, 820 x 640)
if ($Aware -eq 1) { Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D9 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'; [void][D9]::SetProcessDPIAware() }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$cfg = Get-Content -Path $Spec -Raw | ConvertFrom-Json
$W = 820; $H = 640
$scale = 1.0; if ($Aware -eq 1) { $scale = 2.0 }
$mode = [string]$cfg.mode
$script:status = [string]$cfg.status
$script:btns = New-Object System.Collections.ArrayList
foreach ($b in $cfg.buttons) { [void]$script:btns.Add([pscustomobject]@{ label = [string]$b.label; x = [double]$b.x; y = [double]$b.y; w = [double]$b.w; h = [double]$b.h; color = @([int]$b.color[0], [int]$b.color[1], [int]$b.color[2]); fg = @([int]$b.fg[0], [int]$b.fg[1], [int]$b.fg[2]); font = [double]$b.font; effStatus = [string]$b.effect.status; effHide = [string]$b.effect.hide; effOpen = [string]$b.effect.open; hidden = $false; real = [bool]$b.real; ctl = $null }) }
$script:clicks = 0
function WriteLog([string]$ev, $b, $mx, $my) {
  $o = [pscustomobject]@{ t = [DateTime]::UtcNow.ToString('o'); ev = $ev; label = $(if ($b) { $b.label } else { '' }); mx = $mx; my = $my; status = $script:status }
  [System.IO.File]::AppendAllText($Log, (ConvertTo-Json -Compress -InputObject $o) + "`n")
}
function WriteState() {
  $o = [pscustomobject]@{ status = $script:status; clicks = $script:clicks; buttons = @($script:btns | ForEach-Object { [pscustomobject]@{ label = $_.label; x = $_.x; y = $_.y; w = $_.w; h = $_.h; hidden = $_.hidden } }); left = $f.Left; top = $f.Top }
  [System.IO.File]::WriteAllText($State, (ConvertTo-Json -Compress -Depth 4 -InputObject $o))
}
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'; $f.Text = "$RunId-int-$Tag"
$fw = $W; $fh = $H; if ($Aware -eq 1) { $fw = [int]($W * $scale); $fh = [int]($H * $scale) }
$f.Size = New-Object System.Drawing.Size($fw, $fh)
$bg = [System.Drawing.Color]::FromArgb([int]$cfg.bg[0], [int]$cfg.bg[1], [int]$cfg.bg[2])
$p = New-Object System.Windows.Forms.Panel; $p.Dock = 'Fill'; $p.BackColor = $bg
$p.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($p, $true, $null)
$script:painted = $false
$p.Add_Paint({ param($s, $e)
  if (-not $script:painted) { return }
  $g = $e.Graphics; $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'ClearTypeGridFit'; $g.ScaleTransform([single]$scale, [single]$scale)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $sfont = New-Object System.Drawing.Font('Segoe UI', [single]22, [System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString($script:status, $sfont, [System.Drawing.Brushes]::White, 30, 24)
  foreach ($b in $script:btns) {
    if ($b.hidden -or $b.real) { continue }
    $rect = New-Object System.Drawing.RectangleF([single]$b.x, [single]$b.y, [single]$b.w, [single]$b.h)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($b.color[0], $b.color[1], $b.color[2]))), $rect)
    $font = New-Object System.Drawing.Font('Segoe UI', [single]$b.font, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString($b.label, $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($b.fg[0], $b.fg[1], $b.fg[2]))), $rect, $sf)
  }
})
$f.Controls.Add($p)
# real WinForms buttons (they ARE exposed to Windows' accessibility tree: click_visual must not be used for them)
foreach ($b in $script:btns) { if ($b.real) { $c = New-Object System.Windows.Forms.Button; $c.Text = $b.label; $c.Left = [int]($b.x * $scale); $c.Top = [int]($b.y * $scale); $c.Width = [int]($b.w * $scale); $c.Height = [int]($b.h * $scale); $b.ctl = $c; $c.Add_Click({ param($s2, $e2) $script:clicks++; WriteLog 'click-real' ([pscustomobject]@{ label = $s2.Text }) 0 0; WriteState }); $p.Controls.Add($c) } }
function HitIndex([double]$lx, [double]$ly) { for ($i = $script:btns.Count - 1; $i -ge 0; $i--) { $b = $script:btns[$i]; if ($b.hidden -or $b.real) { continue }; if ($lx -ge $b.x -and $lx -le $b.x + $b.w -and $ly -ge $b.y -and $ly -le $b.y + $b.h) { return $i } }; return -1 }
$script:down = -1
$p.Add_MouseDown({ param($s, $e) $lx = $e.X / $scale; $ly = $e.Y / $scale; $script:down = HitIndex $lx $ly; WriteLog 'down' $(if ($script:down -ge 0) { $script:btns[$script:down] } else { $null }) $lx $ly })
$p.Add_MouseUp({ param($s, $e)
  $lx = $e.X / $scale; $ly = $e.Y / $scale; $i = HitIndex $lx $ly
  if ($i -ge 0 -and $i -eq $script:down) {
    $b = $script:btns[$i]; $script:clicks++
    WriteLog 'click' $b $lx $ly
    if ($b.effStatus) { $script:status = $b.effStatus }
    if ($b.effHide) { foreach ($o in $script:btns) { if ($o.label -eq $b.effHide) { $o.hidden = $true } } }
    if ($b.effOpen) { $d = New-Object System.Windows.Forms.Form; $d.Text = $b.effOpen; $d.Width = 300; $d.Height = 120; $d.StartPosition = 'Manual'; $d.Location = New-Object System.Drawing.Point(10, 10); $d.ShowInTaskbar = $true; $d.Show() }
    $p.Invalidate(); $p.Update(); WriteState
  } else { WriteLog 'miss' $null $lx $ly }
  $script:down = -1
})
# hover reactions: the pointer sits on a button for a moment and the app changes
$script:hoverIdx = -1; $script:hoverSince = [DateTime]::MinValue; $script:fired = @{}
$ht = New-Object System.Windows.Forms.Timer; $ht.Interval = 40
$ht.Add_Tick({
  if ($mode -eq 'normal' -or -not $script:painted) { return }
  $pt = $p.PointToClient([System.Windows.Forms.Cursor]::Position)
  $i = HitIndex ($pt.X / $scale) ($pt.Y / $scale)
  if ($i -ne $script:hoverIdx) { $script:hoverIdx = $i; $script:hoverSince = [DateTime]::UtcNow; $script:fired = @{}; return }
  if ($i -lt 0) { return }
  if (([DateTime]::UtcNow - $script:hoverSince).TotalMilliseconds -lt 150) { return }
  if ($script:fired.ContainsKey($i)) { return }
  $script:fired[$i] = $true
  $b = $script:btns[$i]
  switch ($mode) {
    'evasive' { $b.x = $(if ($b.x + $b.w + 140 -lt $W) { $b.x + 130 } else { $b.x - 130 }) }
    'vanish' { $b.hidden = $true }
    'relabel' { $b.label = 'Delete' }
    'decoy' { [void]$script:btns.Add([pscustomobject]@{ label = $b.label; x = 560.0; y = 520.0; w = $b.w; h = $b.h; color = $b.color; fg = $b.fg; font = $b.font; effStatus = ''; effHide = ''; effOpen = ''; hidden = $false; real = $false; ctl = $null }) }
    'movewin' { $f.Left = $f.Left + 70 }
  }
  $p.Invalidate(); $p.Update(); WriteState
})
$f.Add_Shown({ $ht.Start() })
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 700
$t.Add_Tick({ $t.Stop(); $script:painted = $true; $p.Invalidate(); $p.Update(); WriteState; $f.Text = "$RunId-int-$Tag PAINTED" })
$f.Add_Shown({ $t.Start() })
# self-destruct: a crashed runner can never leave this window behind for long
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ $f.Close() }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
