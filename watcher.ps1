<#
 PM Bridge Watcher v2
 Teams DM -> popup approve -> Copilot CLI build -> status/questions/summary back
 to Teams (via outbox flow) -> demo video link (via media flow).
 Usage:  watcher.ps1              (loop; popup approval)
         watcher.ps1 -Once        (single pass)
         watcher.ps1 -Once -AutoApprove   (test mode, no popup)
#>
param(
    [switch]$Once,
    [switch]$AutoApprove,
    [string]$ConfigPath = "$PSScriptRoot\config.json"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName System.Windows.Forms

# ---------- config ----------
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$inbox    = $cfg.inbox
$outbox   = $cfg.outbox
$media    = $cfg.media
$workspace= $cfg.workspace
$logsDir  = $cfg.logs
$archive  = $cfg.archive
$rejected = $cfg.rejected
$stateDir = $cfg.state
$pollSec  = [int]$cfg.pollSeconds
$maxRounds= [int]$cfg.maxQuestionRounds
$stateFile= Join-Path $stateDir 'pending-question.json'
foreach ($d in @($inbox,$outbox,$media,$workspace,$logsDir,$archive,$rejected,$stateDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# ---------- helpers ----------
function ConvertFrom-HtmlText([string]$html) {
    if (-not $html) { return '' }
    $t = $html -replace '(?i)<br\s*/?>', "`n"
    $t = $t -replace '(?i)</p>', "`n"
    $t = $t -replace '<[^>]+>', ''
    $t = [System.Web.HttpUtility]::HtmlDecode($t)
    return ($t -replace '[ \t]+', ' ').Trim()
}

function Write-Box([string]$title, [string[]]$lines, [ConsoleColor]$color = 'Cyan') {
    $w = 78
    Write-Host ("+" + ("-" * ($w-2)) + "+") -ForegroundColor $color
    Write-Host ("| " + $title.PadRight($w-4) + " |") -ForegroundColor $color
    Write-Host ("+" + ("-" * ($w-2)) + "+") -ForegroundColor $color
    foreach ($l in $lines) {
        foreach ($chunk in ($l -split "`n")) {
            $c = $chunk
            while ($c.Length -gt ($w-4)) {
                Write-Host ("| " + $c.Substring(0, $w-4) + " |")
                $c = $c.Substring($w-4)
            }
            Write-Host ("| " + $c.PadRight($w-4) + " |")
        }
    }
    Write-Host ("+" + ("-" * ($w-2)) + "+") -ForegroundColor $color
}

function Move-Safe([string]$path, [string]$destDir, [string]$suffix) {
    $name = [IO.Path]::GetFileNameWithoutExtension($path)
    $ext  = [IO.Path]::GetExtension($path)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    # OneDrive may briefly lock files while syncing - retry, then copy+delete as fallback
    for ($i = 0; $i -lt 5; $i++) {
        try {
            Move-Item -Path $path -Destination (Join-Path $destDir "$name.$stamp$suffix$ext") -Force -ErrorAction Stop
            return
        } catch { Start-Sleep -Seconds 3 }
    }
    try {
        Copy-Item -Path $path -Destination (Join-Path $destDir "$name.$stamp$suffix$ext") -Force -ErrorAction Stop
        Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
    } catch { Write-Host "!! could not move $path (locked)" -ForegroundColor Red }
}

function Send-Teams([string]$fileName, [string]$text) {
    # Any .txt dropped in outbox is posted to the Teams chat by Power Automate
    Set-Content -Path (Join-Path $outbox $fileName) -Value $text -Encoding UTF8
}

function Get-MessageInfo($file) {
    $raw = $null; $msg = $null
    for ($i = 0; $i -lt 5; $i++) {
        try {
            $raw = Get-Content $file.FullName -Raw -Encoding UTF8 -ErrorAction Stop
            if ($raw -and $raw.Trim()) { break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $raw -or -not $raw.Trim()) { return $null }

    if ($file.Extension -eq '.txt') {
        return @{ id = $file.BaseName; from = 'manual drop'; fromId = 'manual'; task = $raw.Trim(); time = $file.LastWriteTime.ToString('s') }
    }
    try { $msg = $raw | ConvertFrom-Json } catch { return $null }

    $text = $null; $fromName = 'unknown'; $fromId = ''
    if ($msg.body -and $msg.body.content) { $text = $msg.body.content }
    elseif ($msg.text)                    { $text = $msg.text }
    if ($msg.from -and $msg.from.user) {
        $fromName = $msg.from.user.displayName
        $fromId   = $msg.from.user.id
    } elseif ($msg.from -is [string])     { $fromName = $msg.from }
    if ($msg.fromId) { $fromId = $msg.fromId }
    $id = if ($msg.id) { ($msg.id -replace '[^\w\-]', '') } else { $file.BaseName }
    $time = if ($msg.createdDateTime) { $msg.createdDateTime } elseif ($msg.timestamp) { $msg.timestamp } else { $file.LastWriteTime.ToString('s') }

    if (-not $text) { return $null }
    return @{ id = $id; from = $fromName; fromId = $fromId; task = (ConvertFrom-HtmlText $text); time = $time }
}

function Test-SenderAllowed($info) {
    $allow = @($cfg.allowedSenders)
    if ($allow.Count -eq 0) { return $true }
    foreach ($a in $allow) {
        if ($info.from -like "*$a*" -or $info.fromId -eq $a) { return $true }
    }
    return $false
}

function Show-ApprovalPopup($info) {
    # Runs the dialog in a dedicated STA process so it ALWAYS renders on the
    # interactive desktop (a hidden engine cannot reliably own a dialog).
    # Exit codes: 10 approve, 20 reject, anything else = NO ANSWER (never reject).
    $task = $info.task
    if ($task.Length -gt 1500) { $task = $task.Substring(0, 1500) + '...' }
    $tmp = Join-Path $stateDir "approval-req.json"
    @{ title = "New task from $($info.from)"; body = "$($info.time)`r`n`r`n$task`r`n`r`nAPPROVE = build now    REJECT = decline (PM is notified)" } |
        ConvertTo-Json | Set-Content $tmp -Encoding UTF8
    $p = Start-Process powershell -ArgumentList @('-STA','-NoProfile','-NoLogo','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$PSScriptRoot\approve.ps1`"",'-MsgFile',"`"$tmp`"") -PassThru -Wait
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $p.ExitCode
}

function Show-InfoPopup([string]$title, [string]$text, [bool]$ok = $true) {
    if ($AutoApprove) { return }
    $tmp = Join-Path $stateDir "info-$([guid]::NewGuid().ToString('n').Substring(0,8)).json"
    @{ title = $title; body = $text } | ConvertTo-Json | Set-Content $tmp -Encoding UTF8
    Start-Process powershell -ArgumentList @('-STA','-NoProfile','-NoLogo','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$PSScriptRoot\approve.ps1`"",'-MsgFile',"`"$tmp`"",'-Info') | Out-Null
}

function Get-LastCopilotBlock([string]$logFile) {
    # copilot flushes the --share transcript at teardown - wait for it (race fix)
    $md = ''
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Path $logFile) {
            $md = Get-Content $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($md -and $md -match '### Copilot') { break }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $md) { return '' }
    # return everything after the LAST '### Copilot' marker that has real content
    $mm = [regex]::Matches($md, '(?s)### Copilot\r?\n(.*?)(?=\r?\n---|\z)')
    for ($j = $mm.Count - 1; $j -ge 0; $j--) {
        $v = $mm[$j].Groups[1].Value.Trim()
        if ($v) { return $v }
    }
    # fallback: scan whole file (SUMMARY/QUESTION/APP_ENTRY searches still work)
    return $md
}

function Get-SessionIdFromLog([string]$logFile) {
    if (-not (Test-Path $logFile)) { return $null }
    $m = [regex]::Match((Get-Content $logFile -Raw -Encoding UTF8), 'Session ID:\*\*\s*`([0-9a-fA-F\-]+)`')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function New-DemoVideo([string]$entryAbs, [string]$outFile, [string]$title) {
    $script = Join-Path $PSScriptRoot 'tools\record-demo2.js'
    if (-not (Test-Path $script)) { return $false }
    $demoScript = Join-Path (Split-Path $entryAbs -Parent) 'demo-script.json'
    if (-not (Test-Path $demoScript)) { $demoScript = '' }
    try {
        & node $script $entryAbs $outFile $demoScript $title 2>&1 | ForEach-Object { Write-Host "   [video] $_" }
        return (($LASTEXITCODE -eq 0) -and (Test-Path $outFile) -and ((Get-Item $outFile).Length -gt 10kb))
    } catch { return $false }
}

$buildRules = @"
RULES:
- FIRST output a short section starting exactly with 'PLAN:' - list the architecture,
  the files/folders you will create, and the approach, in a few bullet lines. Then build.
- Work ONLY inside the current directory (the build workspace).
- New app/feature: scaffold in a clearly named subfolder. Existing code: modify in place.
- Do not push to any remote, do not touch anything outside this folder.
- If you truly need information from the PM before you can proceed, output exactly
  one line starting with 'QUESTION: ' followed by your question, then STOP immediately.
  Do not ask more than one question at a time. Only ask if genuinely blocking.
- Otherwise finish with a section starting exactly with 'SUMMARY:' describing what you
  built, where it lives, and how to run it.
- If the result is a web app, also add a final line exactly like:
  APP_ENTRY: <relative path to the main html file>
  AND create a file named demo-script.json in the app folder: a valid JSON array of up
  to 12 demo steps showcasing the app's main features. Each step is an object with keys:
  action (one of: click, type, scroll, wait), selector (a CSS selector), text (only for
  type steps), caption (a plain-English sentence explaining the feature to the PM).
  Captions must explain WHAT the feature is and WHY it matters. Use reliable selectors.
"@

function Complete-Build($state, [string]$logFile, [int]$exit, [string]$liveLog) {
    $block = Get-LastCopilotBlock $logFile
    if (-not $block) { $block = "(no transcript captured - see $logFile)" }

    # Question? -> ask the PM in Teams and pause
    $qm = [regex]::Match($block, '(?m)^\s*QUESTION:\s*(.+)$')
    if ($qm.Success -and $state.round -lt $maxRounds) {
        $q = $qm.Groups[1].Value.Trim()
        $state | ConvertTo-Json | Set-Content $stateFile -Encoding UTF8
        Send-Teams "$($state.stamp)-$($state.id).q$($state.round).txt" "[PM Bridge] The build needs your input:`r`n`r`n$q`r`n`r`n(Just reply in this chat - your next message resumes the build.)"
        if ($liveLog) { Add-Content -Path $liveLog -Value "`r`n===BUILD-PAUSED===`r`nQUESTION SENT TO PM: $q" -Encoding UTF8 }
        Write-Host ">> PAUSED - question sent to PM: $q" -ForegroundColor Yellow
        return
    }

    # Final -> commit, summary, video, reply  (git warnings must never abort delivery)
    Push-Location $workspace
    $oldEap2 = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        if (Test-Path (Join-Path $workspace '.verify-tmp')) { Remove-Item (Join-Path $workspace '.verify-tmp') -Recurse -Force -ErrorAction SilentlyContinue }
        git add -A 2>$null | Out-Null
        git commit -m "PM build $($state.id): $($state.task.Substring(0, [Math]::Min(60, $state.task.Length)))" --quiet 2>$null | Out-Null
        if ($cfg.pushRemote) {
            Write-Host ">> Pushing to $($cfg.pushRemote)..." -ForegroundColor Yellow
            git push $cfg.pushRemote main 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Host ">> Pushed to remote repo." -ForegroundColor Green }
            else { Write-Host "!! push failed (network?) - will retry after next build" -ForegroundColor Red }
        }
    } finally { $ErrorActionPreference = $oldEap2; Pop-Location }

    $summary = $block
    $sm = [regex]::Match($block, '(?s)SUMMARY:.*$')
    if ($sm.Success) { $summary = $sm.Value }
    if ($summary.Length -gt 3000) { $summary = $summary.Substring(0, 3000) + '...' }

    $videoNote = ''
    $am = [regex]::Match($block, '(?m)^\s*APP_ENTRY:\s*(.+)$')
    if ($cfg.video -and $am.Success) {
        $entry = Join-Path $workspace $am.Groups[1].Value.Trim()
        if (Test-Path $entry) {
            Write-Host ">> Recording demo video..." -ForegroundColor Yellow
            $vid = Join-Path $media "$($state.stamp)-$($state.id)-demo.webm"
            if (New-DemoVideo $entry $vid $state.task.Substring(0, [Math]::Min(40, $state.task.Length))) {
                $videoNote = "`r`n`r`nA demo video is being shared with you now (separate message with a link)."
            } else {
                $videoNote = "`r`n`r`n(Demo video recording failed - see logs.)"
                Remove-Item $vid -Force -ErrorAction SilentlyContinue
            }
        }
    }

    $status = if ($exit -eq 0) { 'DONE' } else { "FAILED (exit $exit)" }
    Send-Teams "$($state.stamp)-$($state.id).done.txt" "[PM Bridge] Build $status for:`r`n`"$($state.task)`"`r`n`r`n$summary$videoNote"
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    if ($liveLog) { Add-Content -Path $liveLog -Value "`r`n===BUILD-COMPLETE===`r`nSTATUS: $status`r`nOutput: $workspace" -Encoding UTF8 }
    Write-Host ">> Build $status. Reply sent to Teams outbox." -ForegroundColor $(if ($exit -eq 0) { 'Green' } else { 'Red' })
    Show-InfoPopup 'PM BRIDGE - Build finished' "Build $status`n`nTask: $($state.task)`n`nOutput: $workspace`nSummary sent to Teams." ($exit -eq 0)
}

function Start-FileMonitor([string]$liveLog) {
    # Streams workspace file activity into the live log while a build runs
    $monScript = Join-Path $stateDir "_mon-$([guid]::NewGuid().ToString('n').Substring(0,6)).ps1"
    $body = @"
`$ws='$workspace'; `$log='$liveLog'; `$seen=@{}
Get-ChildItem `$ws -Recurse -File -EA SilentlyContinue | Where-Object { `$_.FullName -notmatch '\\\.git\\' } | ForEach-Object { `$seen[`$_.FullName]=`$_.LastWriteTime.Ticks }
`$idle=0
while (`$true) {
  `$active = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -match 'copilot' } | Measure-Object).Count
  Get-ChildItem `$ws -Recurse -File -EA SilentlyContinue | Where-Object { `$_.FullName -notmatch '\\(\.git|node_modules|\.verify-tmp)\\' } | ForEach-Object {
    `$k=`$_.FullName; `$v=`$_.LastWriteTime.Ticks
    if (-not `$seen.ContainsKey(`$k)) { Add-Content `$log "[+] created  `$(`$k.Replace(`$ws+'\',''))" -EA SilentlyContinue }
    elseif (`$seen[`$k] -ne `$v)      { Add-Content `$log "[~] updated  `$(`$k.Replace(`$ws+'\',''))" -EA SilentlyContinue }
    `$seen[`$k]=`$v }
  if (`$active -eq 0) { `$idle++ } else { `$idle=0 }
  if (`$idle -ge 3) { break }
  Start-Sleep 3 }
Remove-Item '$monScript' -Force -EA SilentlyContinue
"@
    Set-Content $monScript -Value $body -Encoding UTF8
    Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$monScript`"") | Out-Null
}

function Invoke-CopilotRound([string]$prompt, [string]$logFile, [string]$resumeId, [string]$liveLog) {
    # Native arg-passing mangles embedded double quotes -> replace with single quotes
    $prompt = $prompt -replace '"', "'"
    $cliArgs = @()
    if ($resumeId) { $cliArgs += @('--session-id', $resumeId) }
    $cliArgs += @('-p', $prompt, '--allow-all-tools', '--no-ask-user', '--no-color', '--stream', 'on', "--share=$logFile") + @($cfg.extraCopilotArgs)
    if ($cfg.model) { $cliArgs += @('--model', $cfg.model) }
    if ($liveLog) { Start-FileMonitor $liveLog }
    Push-Location $workspace
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'   # copilot writes progress to stderr; don't treat as crash
    try {
        & copilot @cliArgs 2>&1 | ForEach-Object {
            Write-Host $_
            if ($liveLog) { Add-Content -Path $liveLog -Value "$_" -Encoding UTF8 -ErrorAction SilentlyContinue }
        }
        return [int]$LASTEXITCODE
    } finally { $ErrorActionPreference = $oldEap; Pop-Location }
}

function Start-LiveViewer([string]$liveLog, [string]$title) {
    Set-Content -Path $liveLog -Value "PM BRIDGE LIVE BUILD`r`n$title`r`n$('=' * 70)" -Encoding UTF8
    $safeTitle = ($title -replace '"', "'")
    Start-Process powershell -ArgumentList @('-STA','-NoProfile','-NoLogo','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$PSScriptRoot\progress-viewer.ps1`"",'-LogFile',"`"$liveLog`"",'-Title',"`"$safeTitle`"") | Out-Null
}

function Start-Build($info) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $state = @{ id = $info.id; task = $info.task; from = $info.from; stamp = $stamp; round = 1; sessionId = $null }
    Send-Teams "$stamp-$($info.id).started.txt" "[PM Bridge] APPROVED - started building:`r`n`"$($info.task)`"`r`nI'll post updates here."
    $logFile = Join-Path $logsDir "$stamp-$($info.id).r1.md"
    $liveLog = Join-Path $logsDir "$stamp-$($info.id).live.log"
    Start-LiveViewer $liveLog "PM BRIDGE - Building: $($info.task.Substring(0, [Math]::Min(50, $info.task.Length)))"
    $prompt = "You are executing a build task requested by the project manager ($($info.from)) via Microsoft Teams.`n`nTASK:`n$($info.task)`n`n$buildRules"
    Write-Host "`n>> Building (round 1, log: $logFile)" -ForegroundColor Yellow
    $exit = Invoke-CopilotRound $prompt $logFile $null $liveLog
    $state.sessionId = Get-SessionIdFromLog $logFile
    Complete-Build $state $logFile $exit $liveLog
}

function Resume-Build($answerInfo) {
    $state = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $state = @{ id = $state.id; task = $state.task; from = $state.from; stamp = $state.stamp; round = ([int]$state.round + 1); sessionId = $state.sessionId }
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
    Send-Teams "$($state.stamp)-$($state.id).resume$($state.round).txt" "[PM Bridge] Got your answer - resuming the build."
    $logFile = Join-Path $logsDir "$($state.stamp)-$($state.id).r$($state.round).md"
    $liveLog = Join-Path $logsDir "$($state.stamp)-$($state.id).live.log"
    Start-LiveViewer $liveLog "Resumed: $($state.task.Substring(0, [Math]::Min(60, $state.task.Length)))"
    Add-Content -Path $liveLog -Value "PM ANSWERED: $($answerInfo.task)`r`n$('=' * 70)" -Encoding UTF8
    $prompt = "The PM answered your question with:`n`"$($answerInfo.task)`"`n`nContinue the original task. Same rules as before:`n$buildRules"
    Write-Host "`n>> Resuming build (round $($state.round), log: $logFile)" -ForegroundColor Yellow
    $exit = Invoke-CopilotRound $prompt $logFile $state.sessionId $liveLog
    if (-not $state.sessionId) { $state.sessionId = Get-SessionIdFromLog $logFile }
    Complete-Build $state $logFile $exit $liveLog
}

# ---------- main loop ----------
Write-Box "PM BRIDGE WATCHER v2" @(
    "inbox    : $inbox",
    "workspace: $workspace",
    "approval : $(if ($AutoApprove) { 'AUTO (test mode)' } elseif ($cfg.popupApproval) { 'popup' } else { 'terminal' })",
    "senders  : $(if (@($cfg.allowedSenders).Count) { $cfg.allowedSenders -join ', ' } else { 'anyone' })",
    "features : status->Teams, Q&A->Teams, video->Teams",
    "poll     : every $pollSec s"
) 'Cyan'

$quit = $false
while (-not $quit) {
    $files = Get-ChildItem -Path $inbox -File -ErrorAction SilentlyContinue |
             Where-Object { $_.Extension -in '.json', '.txt' } | Sort-Object LastWriteTime
    foreach ($f in $files) {
      try {
        $info = Get-MessageInfo $f
        if (-not $info) {
            Write-Host "!! Could not parse $($f.Name)" -ForegroundColor Red
            Move-Safe $f.FullName $rejected '.unparsed'
            continue
        }
        if (-not (Test-SenderAllowed $info)) {
            Write-Host "!! Sender '$($info.from)' not allowed" -ForegroundColor Red
            Move-Safe $f.FullName $rejected '.sender'
            continue
        }

        # Waiting on an answer? Any new message from the PM resumes the build.
        if (Test-Path $stateFile) {
            Write-Box "ANSWER FROM PM" @("From : $($info.from)", "", "$($info.task)") 'Green'
            Move-Safe $f.FullName $archive '.answer'
            Resume-Build $info
            continue
        }

        Write-Box "NEW TASK FROM TEAMS" @(
            "From : $($info.from)",
            "Time : $($info.time)",
            "",
            "$($info.task)"
        ) 'Magenta'

        $approved = $false
        if ($AutoApprove -or -not $cfg.requireApproval) {
            $approved = $true
        } elseif ($cfg.popupApproval) {
            $code = Show-ApprovalPopup $info
            if ($code -eq 10) {
                $approved = $true
            } elseif ($code -eq 20) {
                # explicit human rejection - fall through to reject path
            } else {
                # dialog closed/crashed/no answer: FAIL-SAFE = keep task, ask again next poll
                Write-Host "  (no answer from approval dialog, exit $code - will ask again)" -ForegroundColor DarkYellow
                continue
            }
        } else {
            $choice = ''
            while ($choice -notin @('a','r','q')) {
                $choice = (Read-Host "  [A]pprove & build   [R]eject   [Q]uit").ToLower()
            }
            if ($choice -eq 'a') { $approved = $true }
            if ($choice -eq 'q') { $quit = $true; break }
        }

        if (-not $approved) {
            Move-Safe $f.FullName $rejected '.rejected'
            Send-Teams "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$($info.id).rejected.txt" "[PM Bridge] Task was REJECTED by the developer:`r`n`"$($info.task)`""
            Write-Host "  Rejected." -ForegroundColor Yellow
            continue
        }

        Move-Safe $f.FullName $archive '.approved'
        Start-Build $info
      } catch {
        $emsg = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR on $($f.Name): $($_.Exception.Message)"
        Write-Host "!! $emsg" -ForegroundColor Red
        try { Add-Content -Path (Join-Path $logsDir 'watcher-errors.log') -Value $emsg } catch { }
        try { if (Test-Path $f.FullName) { Move-Safe $f.FullName $rejected '.error' } } catch { }
      }
    }
    if ($Once -or $quit) { break }
    Start-Sleep -Seconds $pollSec
}
Write-Host "Watcher stopped." -ForegroundColor Cyan
