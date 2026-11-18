param([string]$Mode = 'msg', [string]$Dir = '', [string]$Tag = 'x', [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900)
# Acceptance-suite fixture (ported from the Phase 5c harness): a real message box (Yes/No) or a real file Open dialog. The owner window's TITLE is its own
# record of the answer: "<base>-answered-No", or "<base>-answered-Cancel-" / "<base>-answered-OK-<file name>" for the file dialog.
# The file dialog starts in -Dir (a folder the suite created under its run directory), so no personal folder is ever shown.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$base = "$RunId-$Tag"
$f = New-Object System.Windows.Forms.Form; $f.Text = $base; $f.Width = 420; $f.Height = 320; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(300, 200)
if ($Mode -eq 'msg') {
  $f.Add_Shown({ $r = [System.Windows.Forms.MessageBox]::Show($f, 'Replace the file?', "$RunId-D-$Tag-confirm", 'YesNo', 'Warning'); $f.Text = "$base-answered-$r" })
} else {
  $f.Add_Shown({
    $o = New-Object System.Windows.Forms.OpenFileDialog; $o.Title = "$RunId-D-$Tag-open-dialog"; $o.CheckFileExists = $false
    if ($Dir) { $o.InitialDirectory = $Dir }
    $r = $o.ShowDialog($f); $f.Text = "$base-answered-$r-" + [IO.Path]::GetFileName($o.FileName)
  })
}
$wd = New-Object System.Windows.Forms.Timer; $wd.Interval = [Math]::Max(1000, $MaxSeconds * 1000); $wd.Add_Tick({ [Environment]::Exit(0) }); $f.Add_Shown({ $wd.Start() })
[void]$f.ShowDialog()
