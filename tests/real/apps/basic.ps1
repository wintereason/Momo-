param([string]$State, [string]$Tag = 'x', [int]$Dup = 0, [string]$RunId = 'momo-real-x', [int]$MaxSeconds = 900, [string]$Layout = 'standard')
# Acceptance-suite fixture: an ordinary window with accessible controls (WPF, so UI Automation sees real providers, like a modern app).
# It writes, to the -State file, what it REALLY received: clicks per button, the text in the search box, the check box, how far the list is scrolled,
# the keys pressed (keyLog: a hashtable's own .Keys property would shadow a field called keys), how often it was activated, where the window is, which menu entry and list item were chosen. The tests compare Momo's claims with this.
# -Dup 1 adds a second button with the very same label ("Click me"), to test ambiguity.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:s = [ordered]@{ ready = $false; clicks = 0; status = 'Ready'; deleteClicks = 0; dupClicks = 0; text = ''; checked = $false; scroll = 0.0; keyLog = @(); activated = 0; left = 0.0; top = 0.0; width = 0.0; height = 0.0; winState = 'Normal'; menu = ''; selected = '' }
$script:dirty = $true

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="460" Height="560" WindowStartupLocation="CenterScreen">
  <StackPanel Margin="20">
    <TextBlock x:Name="Status" Text="Ready" Margin="0,0,0,10"/>
    <StackPanel Orientation="Horizontal">
      <Button x:Name="B1" Content="Click me" Width="150" Margin="0,0,10,10"/>
      <Button x:Name="B2" Content="Delete everything" Width="150" Margin="0,0,10,10"/>
    </StackPanel>
    <StackPanel x:Name="Extra" Orientation="Horizontal"/>
    <Button x:Name="B3" Content="Locked" IsEnabled="False" Width="150" HorizontalAlignment="Left" Margin="0,0,0,10"/>
    <TextBox x:Name="Search" AutomationProperties.Name="Search box" Width="300" HorizontalAlignment="Left" Margin="0,0,0,10"/>
    <CheckBox x:Name="Cb" Content="Enable thing" Margin="0,0,0,10"/>
    <ListBox x:Name="Files" AutomationProperties.Name="Files" Height="150" Width="300" HorizontalAlignment="Left" Margin="0,0,0,10"/>
  </StackPanel>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xaml)
$win.Title = "$RunId-basic-$Tag"
$status = $win.FindName('Status')
$files = $win.FindName('Files')
# -Layout scroll (used only by the scroll test): a TALL list, so the point scroll_window aims at (60% down the window) falls well inside it instead of near its bottom edge.
# The value below is read by the layout self-check (S14); every other test keeps the standard layout.
$ScrollListHeight = 300
if ($Layout -eq 'scroll') { $files.Height = $ScrollListHeight }
for ($i = 1; $i -le 80; $i++) { [void]$files.Items.Add(('Item {0:000}' -f $i)) }

$win.FindName('B1').Add_Click({ $script:s.clicks++; $status.Text = "Clicked $($script:s.clicks) times"; $script:s.status = $status.Text; $script:dirty = $true })
$win.FindName('B2').Add_Click({ $script:s.deleteClicks++; $status.Text = 'DELETE CLICKED'; $script:s.status = $status.Text; $script:dirty = $true })
if ($Dup -eq 1) {
  $b = New-Object System.Windows.Controls.Button; $b.Content = 'Click me'; $b.Width = 150; $b.Margin = '0,0,10,10'
  $b.Add_Click({ $script:s.dupClicks++; $script:dirty = $true })
  [void]$win.FindName('Extra').Children.Add($b)
}
$win.FindName('Search').Add_TextChanged({ param($sender, $e) $script:s.text = [string]$sender.Text; $script:dirty = $true })
$win.FindName('Cb').Add_Checked({ $script:s.checked = $true; $script:dirty = $true })
$win.FindName('Cb').Add_Unchecked({ $script:s.checked = $false; $script:dirty = $true })
$files.Add_SelectionChanged({ param($sender, $e) $script:s.selected = [string]$sender.SelectedItem; $script:dirty = $true })
$files.AddHandler([System.Windows.Controls.ScrollViewer]::ScrollChangedEvent, [System.Windows.Controls.ScrollChangedEventHandler]{ param($sender, $e) $script:s.scroll = [double]$e.VerticalOffset; $script:dirty = $true })
# system keys (Alt+F4 and friends) arrive as Key.System; the real key is in SystemKey: log it as Sys:<key> so they are never invisible
$win.Add_PreviewKeyDown({ param($sender, $e) $k = $e.Key.ToString(); if ($k -eq 'System') { $k = 'Sys:' + $e.SystemKey.ToString() }; $script:s.keyLog = @($script:s.keyLog) + $k; $script:dirty = $true })
$win.Add_Activated({ $script:s.activated++; $script:dirty = $true })
$win.Add_LocationChanged({ $script:s.left = [double]$win.Left; $script:s.top = [double]$win.Top; $script:dirty = $true })
$win.Add_SizeChanged({ $script:s.width = [double]$win.ActualWidth; $script:s.height = [double]$win.ActualHeight; $script:dirty = $true })
$win.Add_StateChanged({ $script:s.winState = $win.WindowState.ToString(); $script:dirty = $true })

# a real context menu on the list (its own popup window)
$menu = New-Object System.Windows.Controls.ContextMenu
foreach ($entry in @('Open', 'Rename', 'Delete')) {
  $mi = New-Object System.Windows.Controls.MenuItem
  $mi.Header = $entry
  $mi.Add_Click({ param($sender, $e) $script:s.menu = [string]$sender.Header; $script:dirty = $true })   # no closure: it reads the item from $sender, and a closure would lose $script: scope
  [void]$menu.Items.Add($mi)
}
$files.ContextMenu = $menu

function Save-State { $json = ConvertTo-Json -Compress -Depth 4 -InputObject $script:s; [System.IO.File]::WriteAllText($State, $json) }
$win.Add_Loaded({ $script:s.ready = $true; $script:s.left = [double]$win.Left; $script:s.top = [double]$win.Top; $script:s.width = [double]$win.ActualWidth; $script:s.height = [double]$win.ActualHeight; $script:s.winState = $win.WindowState.ToString(); $script:dirty = $true })
$writer = New-Object System.Windows.Threading.DispatcherTimer
$writer.Interval = [TimeSpan]::FromMilliseconds(80)
$writer.Add_Tick({ if ($script:dirty) { $script:dirty = $false; Save-State } })
$writer.Start()

# self-destruct: a crashed runner can never leave this window behind for long
$wd = New-Object System.Windows.Threading.DispatcherTimer
$wd.Interval = [TimeSpan]::FromSeconds([Math]::Max(1, $MaxSeconds))
$wd.Add_Tick({ [Environment]::Exit(0) })
$wd.Start()
[void]$win.ShowDialog()
