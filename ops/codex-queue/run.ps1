# Durable Codex task queue (the "loop"). Runs outside any Claude session via Task Scheduler,
# so Codex keeps working while the lead is rate-limited. See ops/codex-queue/README.md.
#
# Task files: pending/<WW>-<name>.md, where WW is a two-digit wave. A wave starts only after
# every lower wave has finished. Up to $MaxParallel tasks of one wave run at once.
param([int]$MaxParallel = 3)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $root "..\..")
$dirs = "pending", "running", "done", "failed", "logs" | ForEach-Object { Join-Path $root $_ }
$pending, $running, $done, $failed, $logs = $dirs
$lock = Join-Path $root "runner.lock"

# Standby: if another runner is alive (e.g. one started inside a Claude session), wait and take over when it dies.
while ((Test-Path $lock) -and (Get-Process -Id ([int](Get-Content $lock)) -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 30 }
Set-Content $lock $PID
$jobs = @{}

function Wave($file) { [int]($file.Name.Substring(0, 2)) }
function Log($msg) {
  try { [IO.File]::AppendAllText((Join-Path $logs "runner.log"), "$(Get-Date -Format s) $msg`r`n") } catch { Write-Host $msg } # a log line must never kill the runner
}

# Header lines in a task file: "<!-- title: ... -->" and "<!-- paths: a b c -->". Commits only those paths.
function Commit-Task($file) {
  $text = Get-Content $file -Raw
  $title = [regex]::Match($text, "<!-- title: (.+?) -->").Groups[1].Value
  $paths = [regex]::Match($text, "<!-- paths: (.+?) -->").Groups[1].Value -split "\s+" | Where-Object { $_ }
  if (-not $title -or -not $paths) { Log "$($file) has no title/paths header; not committed"; return }
  Push-Location $repo
  $ErrorActionPreference = "Continue" # git writes warnings (e.g. LF/CRLF) to stderr; under Stop, PS 5.1 makes them fatal
  try {
    git add -A -- @paths 2>$null | Out-Null
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) { Log "nothing to commit for $title"; return }
    git commit -q -m "$title (Codex queue)" 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "commit FAILED for $title"; return }
    Log "committed: $title"
    if (git remote) { git push -q 2>$null | Out-Null; Log "push exit $LASTEXITCODE" }
  } catch { Log "commit error for ${title}: $_" } finally { Pop-Location }
}

function Finish-Task($name, $exitOk) {
  $base = [IO.Path]::GetFileNameWithoutExtension($name)
  $result = Join-Path $logs "$base.result.md"
  $passed = $exitOk -and (Test-Path $result) -and (Select-String -Path $result -Pattern "RESULT: PASS" -Quiet)
  $target = if ($passed) { $done } else { $failed }
  Move-Item (Join-Path $running $name) (Join-Path $target $name) -Force
  Log "$name -> $(Split-Path -Leaf $target)"
  if ($passed) { Commit-Task (Join-Path $done $name) }
}

try {
  Log "runner started (pid $PID)"
  while ($true) {
    foreach ($name in @($jobs.Keys)) {
      $p = $jobs[$name]
      if (-not $p.HasExited) { continue }
      Log "$name exited $($p.ExitCode)"
      Finish-Task $name ($p.ExitCode -eq 0)
      $jobs.Remove($name)
    }
    # Orphans (left by a dead runner): wait while their codex still holds the file, then finish or re-queue.
    foreach ($f in @(Get-ChildItem $running -Filter *.md)) {
      if ($jobs.ContainsKey($f.Name)) { continue }
      try { ([IO.File]::Open($f.FullName, "Open", "Read", "None")).Close() } catch { continue } # orphaned codex still running
      $result = Join-Path $logs "$([IO.Path]::GetFileNameWithoutExtension($f.Name)).result.md"
      if ((Test-Path $result) -and (Select-String -Path $result -Pattern "RESULT:" -Quiet)) { Finish-Task $f.Name $true }
      else { Move-Item $f.FullName (Join-Path $pending $f.Name) -Force; Log "$($f.Name) re-queued (orphaned)" }
    }

    if (Test-Path (Join-Path $root "HOLD")) { Start-Sleep -Seconds 30; continue } # lead is still merging the previous wave
    $queue = @(Get-ChildItem $pending -Filter *.md | Sort-Object Name)
    if ($queue.Count -eq 0 -and @(Get-ChildItem $running -Filter *.md).Count -eq 0) { break }

    $runningWaves = @(Get-ChildItem $running -Filter *.md | ForEach-Object { Wave $_ })
    $nextWave = if ($queue.Count) { Wave $queue[0] } else { $null }
    $blocked = $runningWaves | Where-Object { $_ -lt $nextWave }
    if ($null -ne $nextWave -and -not $blocked) {
      foreach ($task in $queue | Where-Object { (Wave $_) -eq $nextWave }) {
        if ($jobs.Count -ge $MaxParallel) { break }
        $name = $task.Name
        Move-Item $task.FullName (Join-Path $running $name)
        $base = [IO.Path]::GetFileNameWithoutExtension($name)
        $p = Start-Process -FilePath "codex" -WorkingDirectory $repo -NoNewWindow -PassThru `
          -ArgumentList @("exec", "--sandbox", "workspace-write", "--color", "never", "-o", (Join-Path $logs "$base.result.md"), "-") `
          -RedirectStandardInput (Join-Path $running $name) `
          -RedirectStandardOutput (Join-Path $logs "$base.log") -RedirectStandardError (Join-Path $logs "$base.err")
        $null = $p.Handle # cache the handle now, or ExitCode reads as $null after exit
        $jobs[$name] = $p
        Log "$name started (pid $($p.Id))"
      }
    }
    Start-Sleep -Seconds 20
  }
  Log "runner finished: queue empty"
} finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
