# A static file server on localhost for testing the web build in a desktop browser (default: web\dist on port 8767).
# POST /save?name=<file> writes the body to <Root>\out\<file> (pages that measure something send it back this way).
# .../__kd/fs/<operation> is the app's Documents folder as the app answers it (src/KDFiles.m), here a folder on the PC
# (default .tools\documents, which a build does not empty).
#   .\tools\serve.ps1 [-Root <folder>] [-Documents <folder>] [-Port 8767] [-Minutes 120]
param([string]$Root = '', [string]$Documents = '', [int]$Port = 8767, [int]$Minutes = 120)
if (-not $Root) { $Root = [IO.Path]::Combine((Split-Path $PSScriptRoot -Parent), 'web', 'dist') }
$Root = (Resolve-Path $Root).Path
if (-not $Documents) { $Documents = [IO.Path]::Combine((Split-Path $PSScriptRoot -Parent), '.tools', 'documents') }
[IO.Directory]::CreateDirectory($Documents) | Out-Null
$Documents = (Resolve-Path $Documents).Path

# the app's file operations (KDFiles.m) on $Documents: status, body bytes, content type
function Invoke-Files([string]$op, $request) {
    $q = $request.QueryString
    $rel = [string]$q['path']
    if (-not $rel.StartsWith('/')) { return 403, $null, $null }
    $file = [IO.Path]::GetFullPath([IO.Path]::Combine($Documents, $rel.TrimStart('/').Replace('/', '\')))
    if ($file -ne $Documents -and -not $file.StartsWith($Documents + '\')) { return 403, $null, $null }
    $isDir = [IO.Directory]::Exists($file); $isFile = [IO.File]::Exists($file); $exists = $isDir -or $isFile
    $ms = { param($d) [long]($d.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds }
    switch ($op) {
        'stat' {
            if (-not $exists) { return 404, $null, $null }
            $info = if ($isDir) { New-Object IO.DirectoryInfo $file } else { New-Object IO.FileInfo $file }
            $size = if ($isDir) { 0 } else { $info.Length }
            $json = '{{"type":{0},"size":{1},"mtime":{2},"ctime":{3}}}' -f $(if ($isDir) { 2 } else { 1 }), $size, (& $ms $info.LastWriteTime), (& $ms $info.CreationTime)
            return 200, [Text.Encoding]::UTF8.GetBytes($json), 'application/json'
        }
        'list' {
            if (-not $isDir) { return $(if ($isFile) { 400 } else { 404 }), $null, $null }
            $items = @(foreach ($e in (New-Object IO.DirectoryInfo $file).GetFileSystemInfos()) {
                '[{0},{1}]' -f (ConvertTo-Json $e.Name -Compress), $(if ($e -is [IO.DirectoryInfo]) { 2 } else { 1 })
            })
            return 200, [Text.Encoding]::UTF8.GetBytes('[' + ($items -join ',') + ']'), 'application/json'
        }
        'read' {
            if (-not $isFile) { return $(if ($isDir) { 400 } else { 404 }), $null, $null }
            return 200, [IO.File]::ReadAllBytes($file), 'application/octet-stream'
        }
        'write' {
            if ($isDir) { return 400, $null, $null }
            if (-not $isFile -and $q['create'] -ne '1') { return 404, $null, $null }
            if ($isFile -and $q['overwrite'] -ne '1') { return 409, $null, $null }
            if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($file))) { return 404, $null, $null }
            $ms2 = New-Object IO.MemoryStream
            $request.InputStream.CopyTo($ms2)
            [IO.File]::WriteAllBytes($file, $ms2.ToArray())
            return 200, $null, $null
        }
        'mkdir' {
            if ($exists) { return 409, $null, $null }
            if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($file))) { return 404, $null, $null }
            [IO.Directory]::CreateDirectory($file) | Out-Null
            return 200, $null, $null
        }
        'delete' {
            if (-not $exists) { return 404, $null, $null }
            if ($file -eq $Documents) { return 403, $null, $null }
            if ($isDir) {
                if ($q['recursive'] -ne '1' -and (New-Object IO.DirectoryInfo $file).GetFileSystemInfos().Count) { return 400, $null, $null }
                [IO.Directory]::Delete($file, $true)
            } else { [IO.File]::Delete($file) }
            return 200, $null, $null
        }
        'rename' {
            $toRel = [string]$q['to']
            $to = [IO.Path]::GetFullPath([IO.Path]::Combine($Documents, $toRel.TrimStart('/').Replace('/', '\')))
            if (-not $toRel.StartsWith('/') -or -not $to.StartsWith($Documents + '\') -or $file -eq $Documents) { return 403, $null, $null }
            if (-not $exists) { return 404, $null, $null }
            if ([IO.File]::Exists($to) -or [IO.Directory]::Exists($to)) {
                if ($q['overwrite'] -ne '1') { return 409, $null, $null }
                if ([IO.Directory]::Exists($to)) { [IO.Directory]::Delete($to, $true) } else { [IO.File]::Delete($to) }
            }
            if ($isDir) { [IO.Directory]::Move($file, $to) } else { [IO.File]::Move($file, $to) }
            return 200, $null, $null
        }
    }
    return 400, $null, $null
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "serving $Root on http://localhost:$Port/ for $Minutes minutes (Documents: $Documents)"
$until = (Get-Date).AddMinutes($Minutes)
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8';
            '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png';
            '.ttf' = 'font/ttf'; '.wasm' = 'application/wasm' }
while ((Get-Date) -lt $until) {
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(1000)) { if ((Get-Date) -ge $until) { break } }
    if (-not $task.IsCompleted) { break }
    $ctx = $task.Result
    try {
        if ($ctx.Request.HttpMethod -eq 'POST' -and $ctx.Request.Url.AbsolutePath -eq '/save') {
            $outDir = [IO.Path]::Combine($Root, 'out')
            [IO.Directory]::CreateDirectory($outDir) | Out-Null
            $target = [IO.Path]::Combine($outDir, [IO.Path]::GetFileName($ctx.Request.QueryString['name']))
            $fs = [IO.File]::Create($target)
            $ctx.Request.InputStream.CopyTo($fs)
            $fs.Close()
            Write-Output ("saved {0} ({1:N0} bytes)" -f $target, (New-Object IO.FileInfo $target).Length)
            $ctx.Response.Close()
            continue
        }
        $fsAt = $ctx.Request.Url.AbsolutePath.IndexOf('/__kd/fs/')
        if ($fsAt -ge 0) {
            $status, $bytes, $type = Invoke-Files $ctx.Request.Url.AbsolutePath.Substring($fsAt + 9) $ctx.Request
            $ctx.Response.StatusCode = $status
            $ctx.Response.Headers.Add('Cache-Control', 'no-store')
            if ($type) { $ctx.Response.ContentType = $type }
            if ($bytes) { $ctx.Response.ContentLength64 = $bytes.Length; $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length) }
            $ctx.Response.Close()
            continue
        }
        $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
        if (-not $path) { $path = 'index.html' }
        $file = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $path))
        if ($file.StartsWith($Root) -and [IO.File]::Exists($file)) {
            $ext = [IO.Path]::GetExtension($file).ToLower()
            $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers.Add('Cache-Control', 'no-store')
            $fs = [IO.File]::OpenRead($file)
            $ctx.Response.ContentLength64 = $fs.Length
            $fs.CopyTo($ctx.Response.OutputStream)
            $fs.Close()
        } else {
            $ctx.Response.StatusCode = 404
        }
    } catch {
        Write-Output "error: $_"
        try { $ctx.Response.StatusCode = 500 } catch {}
    }
    try { $ctx.Response.Close() } catch {}
}
$listener.Stop()
