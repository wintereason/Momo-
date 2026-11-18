param([string]$Layout = 'scroll')
# HEADLESS layout probe for the scroll fixture (apps/basic.ps1): no window is created or shown and no input is sent. It lays out the fixture's own XAML in memory
# and reports where the list sits inside the OUTER window rectangle, which is what scroll_window uses (it aims 60% down the outer window height).
# Used by self-check S14 to prove that the wheel point falls comfortably inside the list with the -Layout scroll fixture.
# The window's non-client metrics are read FIRST, before any WPF assembly loads: loading WPF switches the process to DPI-aware metrics (physical px), which would mix
# units with the DIPs below. Read here, in the DPI-unaware view, they are DIP-like (caption + frame + padded border = 31 at 100%).
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class LpSm { [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); }'
$titleOffset = [LpSm]::GetSystemMetrics(4) + [LpSm]::GetSystemMetrics(33) + [LpSm]::GetSystemMetrics(92)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$src =Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\apps\basic.ps1')
$m = [regex]::Match($src, "(?s)\`$xaml = @'\r?\n(.*?)\r?\n'@")
$h = [regex]::Match($src, '\$ScrollListHeight\s*=\s*(\d+)')
if (-not $m.Success -or -not $h.Success) { '{"error":"could not read the fixture"}'; exit 1 }
$win = [Windows.Markup.XamlReader]::Parse($m.Groups[1].Value)
$files = $win.FindName('Files')
for ($i = 1; $i -le 80; $i++) { [void]$files.Items.Add(('Item {0:000}' -f $i)) }
if ($Layout -eq 'scroll') { $files.Height = [double]$h.Groups[1].Value }
$outerW = $win.Width; $outerH = $win.Height
$panel = $win.Content
$panel.Measure((New-Object Windows.Size ($outerW - 16), ($outerH - 39))); $panel.Arrange((New-Object Windows.Rect 0, 0, ($outerW - 16), ($outerH - 39))); $panel.UpdateLayout()
$pt = $files.TransformToAncestor($panel).Transform((New-Object Windows.Point 0, 0))
$topClient = $pt.Y + $panel.Margin.Top
$files.ApplyTemplate(); $files.UpdateLayout()
function Find-Sv($o) { if ($o -is [System.Windows.Controls.ScrollViewer]) { return $o }; $n = [System.Windows.Media.VisualTreeHelper]::GetChildrenCount($o); for ($i = 0; $i -lt $n; $i++) { $r = Find-Sv ([System.Windows.Media.VisualTreeHelper]::GetChild($o, $i)); if ($r) { return $r } }; return $null }
$sv = Find-Sv $files
$listTopOuter = $topClient + $titleOffset
$listBottomOuter = $listTopOuter + $files.ActualHeight
$wheelY = $outerH * 0.6
[pscustomobject]@{
  layout = $Layout; shown = $win.IsVisible; outerHeight = $outerH; titleOffset = $titleOffset
  listHeight = $files.ActualHeight; listTopOuter = [math]::Round($listTopOuter, 1); listBottomOuter = [math]::Round($listBottomOuter, 1)
  wheelY = $wheelY; marginTop = [math]::Round($wheelY - $listTopOuter, 1); marginBottom = [math]::Round($listBottomOuter - $wheelY, 1)
  scrollableItems = $(if ($sv) { $sv.ScrollableHeight } else { 0 })
} | ConvertTo-Json -Compress
