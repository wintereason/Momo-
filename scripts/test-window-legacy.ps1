param([int]$Seconds = 45)
# A legacy WinForms window with a password box, to prove Momo's password detection on old toolkits.
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Momo Legacy Window'; $f.Width = 400; $f.Height = 260; $f.StartPosition = 'CenterScreen'
$tb = New-Object System.Windows.Forms.TextBox
$tb.Left = 20; $tb.Top = 20; $tb.Width = 300; $tb.Text = 'plain visible text 12345'
$pw = New-Object System.Windows.Forms.TextBox
$pw.Left = 20; $pw.Top = 60; $pw.Width = 300; $pw.UseSystemPasswordChar = $true; $pw.Text = 'hunter2-secret'
$pw2 = New-Object System.Windows.Forms.TextBox
$pw2.Left = 20; $pw2.Top = 100; $pw2.Width = 300; $pw2.PasswordChar = '*'; $pw2.Text = 'second-secret'
$f.Controls.AddRange(@($tb, $pw, $pw2))
$t = New-Object System.Windows.Forms.Timer; $t.Interval = $Seconds * 1000; $t.Add_Tick({ $f.Close() }); $t.Start()
[System.Windows.Forms.Application]::Run($f)
