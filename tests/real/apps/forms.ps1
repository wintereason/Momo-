param([string]$Mode = 'content', [string]$Tag = 'x', [int]$W = 820, [int]$H = 640, [int]$X = 300, [int]$Y = 120, [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 6a probes). Modes:
#   white / black : a borderless window that is one solid colour (genuinely blank)
#   late          : solid white at first, real content only after 1.5 s; the title gains ' PAINTED' once the content is on screen
#   content       : always shows content (buttons-like blocks and text)
#   excluded      : content, but the window asks Windows to exclude it from capture
#   hung          : content, then its UI thread stops answering for 25 s
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Aff { [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a); }'
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point($X, $Y); $f.Size = New-Object System.Drawing.Size($W, $H)
$f.Text = "$RunId-forms-$Mode-$Tag"; $f.ShowInTaskbar = $true
$state = @{ painted = ($Mode -ne 'late') }
$p = New-Object System.Windows.Forms.Panel; $p.Dock = 'Fill'
$p.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($p, $true, $null)
if ($Mode -eq 'black') { $p.BackColor = [System.Drawing.Color]::Black } else { $p.BackColor = [System.Drawing.Color]::White }
$p.Add_Paint({ param($s, $e)
  if (-not $state.painted -or $Mode -eq 'white' -or $Mode -eq 'black') { return }
  $g = $e.Graphics
  $g.Clear([System.Drawing.Color]::FromArgb(32, 32, 32))
  $b1 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(59, 130, 246))
  $b2 = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 163, 74))
  $font = New-Object System.Drawing.Font('Segoe UI', 14)
  for ($i = 0; $i -lt 4; $i++) { $g.FillRectangle($b1, 40 + $i * 180, 80, 140, 56); $g.DrawString("Button $i", $font, [System.Drawing.Brushes]::White, 60 + $i * 180, 96) }
  $g.FillRectangle($b2, 40, 200, 200, 80); $g.DrawString('Content area', $font, [System.Drawing.Brushes]::White, 60, 226)
})
$f.Controls.Add($p)
if ($Mode -eq 'late') {
  $t = New-Object System.Windows.Forms.Timer; $t.Interval = 1500
  $t.Add_Tick({ $t.Stop(); $state.painted = $true; $p.Invalidate(); $p.Update(); $f.Text = "$RunId-forms-late-$Tag PAINTED" })
  $f.Add_Shown({ $t.Start() })
}
if ($Mode -eq 'excluded') { $f.Add_Shown({ [void][Aff]::SetWindowDisplayAffinity($f.Handle, 0x11) }) }
if ($Mode -eq 'hung') { $script:ht = New-Object System.Windows.Forms.Timer; $script:ht.Interval = 1500; $script:ht.Add_Tick({ $script:ht.Stop(); [System.Threading.Thread]::Sleep(25000) }); $f.Add_Shown({ $script:ht.Start() }) }
# self-destruct: a crashed runner can never leave this window behind for long
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ $f.Close() }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
