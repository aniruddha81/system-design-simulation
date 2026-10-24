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

if ((Test-Path $lock) -and (Get-Process -Id ([int](Get-Content $lock)) -ErrorAction SilentlyContinue)) { exit 0 } # already running
Set-Content $lock $PID
$jobs = @{}

function Wave($file) { [int]($file.Name.Substring(0, 2)) }
function Log($msg) {
  try { [IO.File]::AppendAllText((Join-Path $logs "runner.log"), "$(Get-Date -Format s) $msg`r`n") } catch { Write-Host $msg } # a log line must never kill the runner
}

try {
  Log "runner started (pid $PID)"
  # Only one runner exists (lock), so anything left in running/ was orphaned by a dead runner: re-queue it.
  Get-ChildItem $running -Filter *.md | ForEach-Object { Move-Item $_.FullName (Join-Path $pending $_.Name) -Force; Log "$($_.Name) re-queued (orphaned)" }
  while ($true) {
    foreach ($name in @($jobs.Keys)) {
      $p = $jobs[$name]
      if (-not $p.HasExited) { continue }
      $target = if ($p.ExitCode -eq 0) { $done } else { $failed }
      Move-Item (Join-Path $running $name) (Join-Path $target $name) -Force
      Log "$name exited $($p.ExitCode) -> $(Split-Path -Leaf $target)"
      $jobs.Remove($name)
    }

    $queue = @(Get-ChildItem $pending -Filter *.md | Sort-Object Name)
    if ($queue.Count -eq 0 -and $jobs.Count -eq 0) { break }

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
