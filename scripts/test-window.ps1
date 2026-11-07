param([int]$Seconds = 150)
# A harmless window used only to test Momo's actions for real: buttons, a text box, a checkbox,
# a disabled button and a password box. It closes itself after $Seconds.
# (WPF, because it exposes proper UI Automation providers like modern apps do.)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$script:n = 0

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Momo Test Window" Width="440" Height="420" WindowStartupLocation="CenterScreen">
  <StackPanel Margin="20">
    <TextBlock x:Name="Status" Text="Ready" Margin="0,0,0,10"/>
    <StackPanel Orientation="Horizontal">
      <Button x:Name="B1" Content="Click me" Width="150" Margin="0,0,10,10"/>
      <Button x:Name="B2" Content="Delete everything" Width="150" Margin="0,0,10,10"/>
    </StackPanel>
    <Button x:Name="B3" Content="Locked" IsEnabled="False" Width="150" HorizontalAlignment="Left" Margin="0,0,0,10"/>
    <TextBox x:Name="Search" AutomationProperties.Name="Search box" Width="300" HorizontalAlignment="Left" Margin="0,0,0,10"/>
    <CheckBox x:Name="Cb" Content="Enable thing" Margin="0,0,0,10"/>
    <PasswordBox x:Name="Pw" AutomationProperties.Name="Password" Password="hunter2" Width="300" HorizontalAlignment="Left"/>
  </StackPanel>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Parse($xaml)
$status = $win.FindName('Status')
$win.FindName('B1').Add_Click({ $script:n++; $status.Text = "Clicked $($script:n) times" })
$win.FindName('B2').Add_Click({ $status.Text = 'DELETE CLICKED' })

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds($Seconds)
$timer.Add_Tick({ $win.Close() })
$timer.Start()
[void]$win.ShowDialog()
