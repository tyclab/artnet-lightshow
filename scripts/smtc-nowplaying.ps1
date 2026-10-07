<#
.SYNOPSIS
  Stream Windows media-session state as NDJSON for src/smtc-source.ts.
.DESCRIPTION
  Requires Windows PowerShell 5.1 and its WinRT projection; do not use pwsh.
.PARAMETER IntervalMs
  Poll interval in milliseconds; default 500.
.OUTPUTS
  JSON: ok, title, artist, album, appId, isPlaying, positionMs, durationMs.
  Idle: {"ok":true,"title":null}. Error: {"ok":false,"error":"..."}.
#>
[CmdletBinding()]
param([int]$IntervalMs = 500)

$ErrorActionPreference = 'Stop'

# UTF-8 stdout so accented track titles survive the pipe to Node.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT async methods return IAsyncOperation<T>; bridge them to awaitable Tasks.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus, Windows.Media.Control, ContentType = WindowsRuntime]

$mgrType    = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType  = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$PlayingEnum = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing

$manager = Await ($mgrType::RequestAsync()) $mgrType

function Write-Json($obj) {
    [Console]::WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

while ($true) {
    try {
        $session = $manager.GetCurrentSession()
        if (-not $session) {
            Write-Json @{ ok = $true; title = $null }
        }
        else {
            $props    = Await ($session.TryGetMediaPropertiesAsync()) $propsType
            $playback = $session.GetPlaybackInfo()
            $timeline = $session.GetTimelineProperties()

            $isPlaying = ($playback.PlaybackStatus -eq $PlayingEnum)

            # Position/duration are bounded by Start/End; most apps use Start=0.
            $startMs = [double]$timeline.StartTime.TotalMilliseconds
            $endMs   = [double]$timeline.EndTime.TotalMilliseconds
            $posMs   = [double]$timeline.Position.TotalMilliseconds - $startMs
            $durMs   = $endMs - $startMs

            # Treat invalid or uninitialised timeline values as unknown.
            $MAX_MS = 24 * 60 * 60 * 1000   # 24h
            if ($durMs -lt 0 -or $durMs -gt $MAX_MS) { $durMs = 0 }
            if ($posMs -lt 0 -or $posMs -gt $MAX_MS) { $posMs = 0 }

            # Interpolate between SMTC updates only while LastUpdatedTime is fresh.
            $lastUpdated = $timeline.LastUpdatedTime
            if ($isPlaying -and $lastUpdated.Year -gt 2000) {
                $elapsed = ([DateTimeOffset]::Now - $lastUpdated).TotalMilliseconds
                if ($elapsed -gt 0 -and $elapsed -lt 600000) { $posMs += $elapsed }
            }
            if ($durMs -gt 0 -and $posMs -gt $durMs) { $posMs = $durMs }

            Write-Json ([ordered]@{
                ok         = $true
                title      = $props.Title
                artist     = $props.Artist
                album      = $props.AlbumTitle
                appId      = $session.SourceAppUserModelId
                isPlaying  = [bool]$isPlaying
                positionMs = [long][math]::Round($posMs)
                durationMs = [long][math]::Round($durMs)
            })
        }
    }
    catch {
        Write-Json @{ ok = $false; error = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds $IntervalMs
}
