# PM Bridge - live build progress viewer. Tails the build log in a window.
param([string]$LogFile, [string]$Title = 'PM BRIDGE - Building...')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Size = New-Object System.Drawing.Size(820, 560)
$form.StartPosition = 'Manual'
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Width - 830), 40)
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(16, 18, 24)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Multiline = $true
$txt.ReadOnly = $true
$txt.ScrollBars = 'Both'
$txt.WordWrap = $false
$txt.Font = New-Object System.Drawing.Font('Consolas', 10)
$txt.BackColor = [System.Drawing.Color]::FromArgb(16, 18, 24)
$txt.ForeColor = [System.Drawing.Color]::FromArgb(140, 235, 140)
$txt.Dock = 'Fill'
$txt.BorderStyle = 'None'
$form.Controls.Add($txt)

$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'
$status.Height = 28
$status.Text = '  building... (this window is read-only; closing it does NOT stop the build)'
$status.ForeColor = [System.Drawing.Color]::FromArgb(120, 190, 255)
$status.BackColor = [System.Drawing.Color]::FromArgb(28, 32, 40)
$status.TextAlign = 'MiddleLeft'
$form.Controls.Add($status)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 800
$script:lastLen = -1
$timer.Add_Tick({
    try {
        if (-not (Test-Path $LogFile)) { return }
        $raw = [System.IO.File]::ReadAllText($LogFile)
        if ($raw.Length -eq $script:lastLen) { return }
        $script:lastLen = $raw.Length
        $lines = $raw -split "`r?`n"
        if ($lines.Count -gt 400) { $lines = $lines[-400..-1] }
        $txt.Text = ($lines -join "`r`n")
        $txt.SelectionStart = $txt.Text.Length
        $txt.ScrollToCaret()
        if ($raw -match '===BUILD-COMPLETE===') {
            $status.Text = '  BUILD FINISHED - summary sent to Teams. You can close this window.'
            $status.ForeColor = [System.Drawing.Color]::FromArgb(140, 235, 140)
            $form.TopMost = $false
        } elseif ($raw -match '===BUILD-PAUSED===') {
            $status.Text = '  PAUSED - waiting for the PM to answer a question in Teams.'
            $status.ForeColor = [System.Drawing.Color]::Orange
            $form.TopMost = $false
        }
    } catch { }
})
$timer.Start()
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
$timer.Dispose(); $form.Dispose()
