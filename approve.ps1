# PM Bridge - approval dialog helper. Exit codes: 10 = approve, 20 = reject, 0 = no answer.
param([string]$MsgFile, [switch]$Info)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$data = Get-Content $MsgFile -Raw -Encoding UTF8 | ConvertFrom-Json
[System.Media.SystemSounds]::Exclamation.Play()

$form = New-Object System.Windows.Forms.Form
$form.Text = if ($Info) { 'PM BRIDGE' } else { 'PM BRIDGE - New task from Teams' }
$form.Size = New-Object System.Drawing.Size(560, 360)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.FormBorderStyle = 'FixedDialog'
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 32)

$lblFrom = New-Object System.Windows.Forms.Label
$lblFrom.Text = "$($data.title)"
$lblFrom.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$lblFrom.ForeColor = [System.Drawing.Color]::FromArgb(120, 190, 255)
$lblFrom.Location = New-Object System.Drawing.Point(16, 14)
$lblFrom.Size = New-Object System.Drawing.Size(510, 28)
$form.Controls.Add($lblFrom)

$txt = New-Object System.Windows.Forms.TextBox
$txt.Multiline = $true
$txt.ReadOnly = $true
$txt.ScrollBars = 'Vertical'
$txt.Text = $data.body
$txt.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$txt.BackColor = [System.Drawing.Color]::FromArgb(34, 38, 46)
$txt.ForeColor = [System.Drawing.Color]::White
$txt.BorderStyle = 'FixedSingle'
$txt.Location = New-Object System.Drawing.Point(16, 48)
$txt.Size = New-Object System.Drawing.Size(510, 200)
$form.Controls.Add($txt)

$script:code = 0

if ($Info) {
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = 'OK'
    $ok.Size = New-Object System.Drawing.Size(120, 40)
    $ok.Location = New-Object System.Drawing.Point(406, 262)
    $ok.BackColor = [System.Drawing.Color]::FromArgb(60, 120, 210)
    $ok.ForeColor = [System.Drawing.Color]::White
    $ok.FlatStyle = 'Flat'
    $ok.Add_Click({ $script:code = 10; $form.Close() })
    $form.Controls.Add($ok)
    $form.AcceptButton = $ok
} else {
    $yes = New-Object System.Windows.Forms.Button
    $yes.Text = 'APPROVE + BUILD'
    $yes.Size = New-Object System.Drawing.Size(180, 40)
    $yes.Location = New-Object System.Drawing.Point(160, 262)
    $yes.BackColor = [System.Drawing.Color]::FromArgb(40, 160, 80)
    $yes.ForeColor = [System.Drawing.Color]::White
    $yes.FlatStyle = 'Flat'
    $yes.Add_Click({ $script:code = 10; $form.Close() })
    $form.Controls.Add($yes)

    $no = New-Object System.Windows.Forms.Button
    $no.Text = 'REJECT'
    $no.Size = New-Object System.Drawing.Size(120, 40)
    $no.Location = New-Object System.Drawing.Point(356, 262)
    $no.BackColor = [System.Drawing.Color]::FromArgb(180, 60, 60)
    $no.ForeColor = [System.Drawing.Color]::White
    $no.FlatStyle = 'Flat'
    $no.Add_Click({ $script:code = 20; $form.Close() })
    $form.Controls.Add($no)

    $form.AcceptButton = $yes
    $form.CancelButton = $no
}

$form.Add_Shown({ $form.Activate(); $form.BringToFront() })
[void]$form.ShowDialog()
$form.Dispose()
exit $script:code
