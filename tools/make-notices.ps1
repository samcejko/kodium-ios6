# Writes THIRD_PARTY_NOTICES.md: tools\notices-head.md (Kodium's list of components) and the copyright notices and
# licence texts from Surfari's THIRD_PARTY_NOTICES.md (the engine's components), without what only Surfari ships (the
# OISD list and its GPL text, Bootstrap, Pico, browserscore), plus the notices of the workbench's components.
#   .\tools\make-notices.ps1 [-Surfari <path to browser-ios6>]
param([string]$Surfari = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Surfari) { $Surfari = [IO.Path]::Combine((Split-Path $root -Parent), 'browser-ios6') }
$utf8 = New-Object Text.UTF8Encoding $false
$head = [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'notices-head.md'), $utf8).Replace("`r`n", "`n")
$theirs = [IO.File]::ReadAllText([IO.Path]::Combine((Resolve-Path $Surfari).Path, 'THIRD_PARTY_NOTICES.md'), $utf8).Replace("`r`n", "`n")

$at = $theirs.IndexOf('## Copyright notices and licence texts')
if ($at -lt 0) { throw "Surfari's notices have no licence texts section" }
$texts = $theirs.Substring($at)
# sections only Surfari needs
foreach ($section in '### OISD small', '### GNU General Public License v3.0') {
    $a = $texts.IndexOf($section)
    if ($a -lt 0) { continue }
    $b = $texts.IndexOf("`n### ", $a + $section.Length)
    $texts = if ($b -lt 0) { $texts.Substring(0, $a).TrimEnd() + "`n" } else { $texts.Substring(0, $a) + $texts.Substring($b + 1) }
}
$lines = $texts.Split("`n") | Where-Object { $_ -notmatch '^- (Bootstrap|Pico CSS|browserscore/features)' }
$texts = ($lines -join "`n")
# the workbench's components under the MIT text (after acorn's line)
$workbench = @(
    '- Visual Studio Code (Code - OSS): Copyright (c) 2015 - present Microsoft Corporation',
    '- monaco-vscode-api: Copyright (c) 2023 CodinGame',
    '- marked: Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)',
    '- @vscode/diff, @vscode/iconv-lite-umd: Copyright (c) Microsoft Corporation (iconv-lite: Copyright (c) 2011 Alexander Shtuchkin)'
) -join "`n"
$acorn = $texts.IndexOf("`n- acorn:")
if ($acorn -lt 0) { throw "acorn's line is missing in Surfari's MIT list" }
$eol = $texts.IndexOf("`n", $acorn + 1)
$texts = $texts.Substring(0, $eol + 1) + $workbench + "`n" + $texts.Substring($eol + 1)
$texts = [regex]::Replace($texts, 'Surfari(\s+)(uses|compiles)', 'Kodium$1$2')
$texts = [regex]::Replace($texts, 'Surfari(\s+)stores', 'The engine$1stores')
$texts = [regex]::Replace($texts, '\(`vendor/mbedtls_config_ios6\.h`\)', '(`engine/vendor/mbedtls_config_ios6.h`)')
$extra = @"

### DOMPurify

Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53. DOMPurify is dual-licensed under the Apache License 2.0 and the
Mozilla Public License 2.0; Kodium uses it under the Apache License 2.0 (full text above).

### Codicons

The Codicons icon font (``codicon.ttf``), Copyright (c) Microsoft Corporation, is licensed under the Creative Commons
Attribution 4.0 International License, https://creativecommons.org/licenses/by/4.0/ (its code under the MIT License).
Source: https://github.com/microsoft/vscode-codicons. Kodium ships the font as monaco-vscode-api has it, unchanged.
"@
[IO.File]::WriteAllText([IO.Path]::Combine($root, 'THIRD_PARTY_NOTICES.md'), $head + $texts.TrimEnd() + "`n" + $extra.Replace("`r`n", "`n") + "`n", $utf8)
Write-Output ('THIRD_PARTY_NOTICES.md: {0:N0} KB' -f ((Get-Item ([IO.Path]::Combine($root, 'THIRD_PARTY_NOTICES.md'))).Length / 1KB))
