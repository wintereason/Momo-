param([string]$Tag = 'x', [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture: a window with a password box (and an ordinary button). Momo must refuse to take a picture of it or click in it.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object System.Windows.Forms.Form; $f.Text = "$RunId-$Tag"; $f.Width = 600; $f.Height = 360; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(300, 200)
$t = New-Object System.Windows.Forms.TextBox; $t.UseSystemPasswordChar = $true; $t.Left = 40; $t.Top = 40; $t.Width = 300; $t.Name = 'pw'; $t.AccessibleName = 'Password'
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Filter'; $b.Left = 40; $b.Top = 100; $b.Width = 140; $b.Height = 44
$f.Controls.Add($t); $f.Controls.Add($b)
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ [Environment]::Exit(0) }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
