# Builds the workbench for iOS 6 into web\dist: Vite bundle -> ES5 with jsfix (tools\lower.mjs) -> the prelude and the
# test pages next to it. Node is ..\.tools\node\node.exe (portable) when there, else node on the PATH.
#   .\web\build.ps1            the whole build
#   .\web\build.ps1 -SkipVite  lowers the last Vite bundle again (after a change in jsfix.js or lower.mjs)
param([switch]$SkipVite)
$ErrorActionPreference = 'Stop'
$web = $PSScriptRoot
$node = [IO.Path]::Combine((Split-Path $web -Parent), '.tools', 'node', 'node.exe')
if (-not (Test-Path $node)) { $node = 'node' }
$dist = [IO.Path]::Combine($web, 'dist')
$assets = [IO.Path]::Combine($dist, 'assets')

Push-Location $web
try {
    if (-not $SkipVite) {
        & $node ([IO.Path]::Combine($web, 'node_modules', 'vite', 'bin', 'vite.js')) build --logLevel warn
        if ($LASTEXITCODE) { throw "vite build failed ($LASTEXITCODE)" }
    }
    & $node --max-old-space-size=8192 --stack-size=8000 ([IO.Path]::Combine($web, 'tools', 'lower.mjs')) `
        ([IO.Path]::Combine($assets, 'workbench.js')) ([IO.Path]::Combine($assets, 'workbench.es5.js'))
    if ($LASTEXITCODE) { throw "lowering failed ($LASTEXITCODE)" }
    # the web workers (the editor's, the language services'), each lowered on its own
    & $node ([IO.Path]::Combine($web, 'tools', 'build-workers.mjs'))
    if ($LASTEXITCODE) { throw "building the workers failed ($LASTEXITCODE)" }
    Copy-Item ([IO.Path]::Combine($web, 'prelude', 'vsc-prelude.js')) $dist -Force
    Get-ChildItem ([IO.Path]::Combine($web, 'test')) -File | Where-Object { $_.Extension -in '.html', '.js' } | Copy-Item -Destination $dist -Force
    # the app's site as CI puts it into Resources/site (dist\site here, for a look in a desktop browser)
    & $node ([IO.Path]::Combine($web, 'tools', 'assemble-site.mjs')) $dist ([IO.Path]::Combine($dist, 'site'))
    if ($LASTEXITCODE) { throw 'assembling the site failed' }
} finally {
    Pop-Location
}
Get-ChildItem $assets -Filter 'workbench*.js' | ForEach-Object { '{0,-28} {1,6:N1} MB' -f $_.Name, ($_.Length / 1MB) }
