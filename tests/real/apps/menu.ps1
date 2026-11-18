param([string]$Tag = 'x', [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 5b harness): a real context menu with submenus. The window's TITLE is its own record of what it
# received: "<base>" while waiting, "<base>-clicked-<item>" once an item was really clicked; it then resets itself and shows the menu again.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$base = "$RunId-$Tag"
$f = New-Object System.Windows.Forms.Form; $f.Text = $base; $f.Width = 520; $f.Height = 360; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(300, 200)
$cms = New-Object System.Windows.Forms.ContextMenuStrip
$h = { param($s, $e) $f.Text = "$base-clicked-" + $s.Text }
foreach ($n in @('Open', 'Properties', 'Refresh')) { $i = $cms.Items.Add($n); $i.Add_Click($h) }
$m = $cms.Items.Add('More'); foreach ($n in @('Sub one', 'Sub two')) { $s = $m.DropDownItems.Add($n); $s.Add_Click($h) }
$g = $cms.Items.Add('Sort by'); foreach ($n in @('Name', 'Date')) { $s = $g.DropDownItems.Add($n); $s.Add_Click($h) }
$dis = $cms.Items.Add('Disabled item'); $dis.Enabled = $false
[void]$cms.Items.Add('-'); $x = $cms.Items.Add('Exit later'); $x.Add_Click($h)
$script:n = 0; $script:wait = 0
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 400
$t.Add_Tick({
  if ($cms.Visible) { return }
  if ($f.Text -like '*-clicked-*') {
    if (-not $script:wait) { $script:wait = [Environment]::TickCount + 1800 }
    elseif ([Environment]::TickCount -gt $script:wait) { $script:wait = 0; $f.Text = $base }
  } else {
    $script:n++
    $cms.Show($f, (New-Object System.Drawing.Point((40 + ($script:n % 5) * 20), (60 + ($script:n % 4) * 20))))
  }
})
$f.Add_Shown({ $t.Start() })
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ [Environment]::Exit(0) }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
