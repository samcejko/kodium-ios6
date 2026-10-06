# Copies Surfari's engine into engine\ - the networking with its own TLS stack, the CSS and JavaScript rewriters, the page
# shims, and the build helpers its CI steps use - from a Surfari working tree (default ..\browser-ios6), then applies
# Kodium's transpiler fixes to make web\tp\jsfix.js (web\tools\patch-jsfix.mjs). Run it again to take a newer Surfari.
#   .\tools\sync-engine.ps1 [-Surfari <path to browser-ios6>]
param([string]$Surfari = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Surfari) { $Surfari = [IO.Path]::Combine((Split-Path $root -Parent), 'browser-ios6') }
$Surfari = (Resolve-Path $Surfari).Path
$engine = [IO.Path]::Combine($root, 'engine')

# (what Kodium takes: no browser UI, bookmarks or passwords)
$files = @(
    'src/BRCommon.h', 'src/BRCommon.m', 'src/BRMemory.h', 'src/BRMemory.m', 'src/BRSettings.h', 'src/BRSettings.m',
    'src/BRWatchdog.h', 'src/BRWatchdog.m', 'src/BRProfiler.h', 'src/BRProfiler.m',
    'src/Net/*',
    'Resources/cssfix.js', 'Resources/jsfix.js', 'Resources/shims.js', 'Resources/shims-extra.js', 'Resources/page-prelude.js',
    'Resources/regexp-shim.js', 'Resources/worker-shims.js', 'Resources/adblock-base.txt',
    'vendor/mbedtls_config_ios6.h', 'vendor/mbedtls_glue.c', 'vendor/cxx_glue.cc',
    'tools/minify-page-scripts.js', 'tools/check-es5.js', 'tools/gen-helpers.js', 'tools/gen-unicode.js', 'tools/patch-ofi.js',
    'tools/jsfix-ci.js', 'tools/jsfix-cases.js',
    'LICENSE'
)
if (Test-Path $engine) { Remove-Item -Recurse -Force $engine -Confirm:$false }
$count = 0
foreach ($f in $files) {
    $from = [IO.Path]::Combine($Surfari, $f.Replace('/', '\'))
    $items = @(Get-ChildItem $from -File)
    if (-not $items.Count) { throw "not in Surfari: $f" }
    $dir = [IO.Path]::Combine($engine, [IO.Path]::GetDirectoryName($f.Replace('/', '\')))
    New-Item -ItemType Directory -Force $dir | Out-Null
    foreach ($i in $items) { Copy-Item $i.FullName $dir; $count++ }
}

# which Surfari this is (its version and the newest change among the files taken)
$plist = Get-Content -Raw ([IO.Path]::Combine($Surfari, 'Resources', 'Info.plist'))
$version = if ($plist -match '<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>') { $Matches[1] } else { '?' }
$newest = Get-ChildItem $engine -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$note = @"
Surfari's engine, copied by tools/sync-engine.ps1 - do not edit here, change Surfari and copy again.
Surfari version: $version
Newest file: $($newest.Name), $($newest.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
Copied: $((Get-Date).ToString('yyyy-MM-dd HH:mm')), $count files
"@
[IO.File]::WriteAllText([IO.Path]::Combine($engine, 'SOURCE.txt'), $note + "`n")

# The engine's messages in Czech (network errors and the like): Surfari's translations of the keys the engine uses go
# into Resources\cs.lproj\Localizable.strings between the engine markers (English needs nothing: the keys are English)
$keys = New-Object 'System.Collections.Generic.List[string]'
Get-ChildItem $engine -Recurse -Include *.m, *.mm | ForEach-Object {
    foreach ($m in [regex]::Matches([IO.File]::ReadAllText($_.FullName), 'L\(@"((?:[^"\\]|\\.)*)"\)')) {
        if (-not $keys.Contains($m.Groups[1].Value)) { $keys.Add($m.Groups[1].Value) }
    }
}
$surfariCs = [IO.File]::ReadAllLines([IO.Path]::Combine($Surfari, 'Resources', 'cs.lproj', 'Localizable.strings'), [Text.Encoding]::UTF8)
$lines = New-Object 'System.Collections.Generic.List[string]'
$missing = @()
foreach ($k in $keys) {
    $line = $surfariCs | Where-Object { $_.StartsWith('"' + $k + '"') -and $_ -match '^"((?:[^"\\]|\\.)*)"\s*=' -and $Matches[1] -eq $k } | Select-Object -First 1
    if ($line) { $lines.Add($line) } else { $missing += $k }
}
$csFile = [IO.Path]::Combine($root, 'Resources', 'cs.lproj', 'Localizable.strings')
$cs = [IO.File]::ReadAllText($csFile, [Text.Encoding]::UTF8)
$begin = '/* --- engine: Surfari''s translations of the engine''s messages, copied by tools/sync-engine.ps1 --- */'
$end = '/* --- end of engine --- */'
$a = $cs.IndexOf($begin); $b = $cs.IndexOf($end)
if ($a -lt 0 -or $b -lt $a) { throw "the engine markers are missing in $csFile" }
$cs = $cs.Substring(0, $a + $begin.Length) + "`n" + (($lines | Sort-Object -Unique) -join "`n") + "`n" + $cs.Substring($b)
[IO.File]::WriteAllText($csFile, $cs, (New-Object Text.UTF8Encoding $false))
Write-Output ("Czech engine messages: {0} of {1}" -f $lines.Count, $keys.Count)
if ($missing.Count) { Write-Output ("  without a translation in Surfari: " + ($missing -join ' | ')) }

# Kodium's transpiler: Surfari's with the fixes of patch-jsfix.mjs (the web build and the app use the same file)
$node = [IO.Path]::Combine($root, '.tools', 'node', 'node.exe')
if (-not (Test-Path $node)) { $node = 'node' }
& $node ([IO.Path]::Combine($root, 'web', 'tools', 'patch-jsfix.mjs')) ([IO.Path]::Combine($engine, 'Resources', 'jsfix.js')) ([IO.Path]::Combine($root, 'web', 'tp', 'jsfix.js'))
if ($LASTEXITCODE) { throw 'patch-jsfix failed' }
Write-Output $note
