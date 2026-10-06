# Pushes the working tree to GitHub through the REST API (no local git needed).
# Usage: .\tools\gh-push.ps1 [-Repo owner/name] [-Token ghp_xxx] -Message "commit message" [-Tag v1.0.0]
# Repo and token default to tools/local.json (see tools/local.example.json). -Tag also puts a tag on the pushed commit
# (the head when nothing changed): a tag v<version> makes the workflow publish a GitHub Release.
# What .gitignore ignores is not pushed (tools/local.json never is), and files of the remote branch that are gone here
# or ignored now are deleted there: the remote tree is the local one. A new empty repository gets a first commit that
# holds the whole tree. Nothing is uploaded while a file holds what looks like a GitHub token.
param(
    [string]$Repo = '',
    [string]$Token = $env:GH_TOKEN,
    [string]$Branch = '',
    [string]$Message = 'Update',
    [string]$Root = '',
    [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$localCfg = Join-Path $PSScriptRoot 'local.json'
if (Test-Path $localCfg) {
    $cfg = Get-Content $localCfg -Raw | ConvertFrom-Json
    if (-not $Repo -and $cfg.repo) { $Repo = $cfg.repo }
    if (-not $Token -and $cfg.token) { $Token = $cfg.token }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $Repo) { throw "Missing repo: pass -Repo or set it in tools/local.json" }
if (-not $Token) { throw "Missing token: pass -Token, set GH_TOKEN or tools/local.json" }

$Headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'kodium-push'
}
$Api = "https://api.github.com/repos/$Repo"

function Invoke-GH {
    param([string]$Method, [string]$Path, $Body)
    $params = @{ Method = $Method; Uri = "$Api$Path"; Headers = $Headers; ContentType = 'application/json; charset=utf-8' }
    if ($null -ne $Body) { $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress)) }
    # Freshly created fine-grained tokens return sporadic 403s while permissions propagate; retry those.
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            return Invoke-RestMethod @params
        } catch {
            $status = 0
            try { $status = [int]$_.Exception.Response.StatusCode } catch {}
            $retryable = ($status -eq 403 -or $status -eq 502 -or $status -eq 503 -or $status -eq 0)
            if ($status -eq 403 -and $_.ErrorDetails.Message -match 'rate limit') { $retryable = $true }
            if (-not $retryable -or $attempt -ge 8) { throw }
            Start-Sleep -Seconds ([Math]::Min(3 * $attempt, 20))
        }
    }
}

# --- What is pushed: the rules of .gitignore -------------------------------------------------------------------------
# (the glob patterns git uses: * and ? within a name, ** across directories, [...] classes, a trailing / for
# directories only, a / at the start or inside anchoring the pattern to the root, ! taking a path back in; a path is
# ignored when it or a directory above it is)
function ConvertTo-IgnoreRule([string]$Line) {
    $p = $Line.Trim()
    if (-not $p -or $p.StartsWith('#')) { return $null }
    $negate = $p.StartsWith('!')
    if ($negate) { $p = $p.Substring(1) }
    $dirOnly = $p.EndsWith('/')
    $p = $p.TrimEnd('/')
    $anchored = $p.Contains('/')
    $p = $p.TrimStart('/')
    if (-not $p) { return $null }
    $sb = New-Object Text.StringBuilder
    $i = 0
    while ($i -lt $p.Length) {
        $c = [string]$p[$i]
        if ($c -eq '*' -and $i + 1 -lt $p.Length -and [string]$p[$i + 1] -eq '*') {
            # '**/' is any number of directories (none too), any other '**' anything
            if ($i + 2 -lt $p.Length -and [string]$p[$i + 2] -eq '/') { [void]$sb.Append('(?:.*/)?'); $i += 3; continue }
            [void]$sb.Append('.*'); $i += 2; continue
        }
        if ($c -eq '*') { [void]$sb.Append('[^/]*') }
        elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
        elseif ($c -eq '[' -and $p.IndexOf(']', $i + 1) -gt $i + 1) {
            $end = $p.IndexOf(']', $i + 1)
            $class = $p.Substring($i + 1, $end - $i - 1)
            if ($class.StartsWith('!')) { $class = '^' + $class.Substring(1) }
            [void]$sb.Append('[' + $class.Replace('\', '\\') + ']')
            $i = $end
        }
        elseif ($c -eq '\' -and $i + 1 -lt $p.Length) { $i++; [void]$sb.Append([Regex]::Escape([string]$p[$i])) }
        else { [void]$sb.Append([Regex]::Escape($c)) }
        $i++
    }
    $prefix = if ($anchored) { '^' } else { '(?:^|/)' }
    $regex = New-Object Text.RegularExpressions.Regex -ArgumentList ($prefix + $sb.ToString() + '$'), ([Text.RegularExpressions.RegexOptions]::IgnoreCase)
    return [pscustomobject]@{ Regex = $regex; Negate = $negate; DirOnly = $dirOnly }
}

$rootFull = (Resolve-Path $Root).Path
$IgnoreRules = New-Object System.Collections.ArrayList
$gitignore = Join-Path $rootFull '.gitignore'
if (Test-Path $gitignore) {
    foreach ($line in [IO.File]::ReadAllLines($gitignore)) {
        $rule = ConvertTo-IgnoreRule $line
        if ($rule) { [void]$IgnoreRules.Add($rule) }
    }
}
Write-Host "$($IgnoreRules.Count) ignore rules from .gitignore"

function Test-OneIgnored([string]$Path, [bool]$IsDir) {
    $ignored = $false
    foreach ($rule in $IgnoreRules) {
        if ($rule.DirOnly -and -not $IsDir) { continue }
        if ($rule.Regex.IsMatch($Path)) { $ignored = -not $rule.Negate }
    }
    return $ignored
}

function Test-Ignored([string]$Rel, [bool]$IsDir = $false) {
    $r = ($Rel -replace '\\', '/').Trim('/')
    # (the local settings and copies of them hold the token, whatever .gitignore says)
    if ($r -match '^tools/local[^/]*\.json' -and $r -ne 'tools/local.example.json') { return $true }
    if ($r -eq '.git' -or $r.StartsWith('.git/')) { return $true }
    $parts = $r.Split('/')
    $path = ''
    for ($n = 0; $n -lt $parts.Length; $n++) {
        if ($n -eq 0) { $path = $parts[0] } else { $path = $path + '/' + $parts[$n] }
        $isDirHere = ($n -lt $parts.Length - 1) -or $IsDir
        if (Test-OneIgnored $path $isDirHere) { return $true }
    }
    return $false
}

# the files to push (ignored directories are not entered at all: node_modules/ and .tools/ are large)
$LocalFiles = New-Object System.Collections.ArrayList
function Add-LocalFiles([string]$Dir, [string]$RelDir) {
    foreach ($item in Get-ChildItem -LiteralPath $Dir -Force) {
        $rel = if ($RelDir) { "$RelDir/$($item.Name)" } else { $item.Name }
        if ($item.PSIsContainer) {
            if (-not (Test-Ignored $rel $true)) { Add-LocalFiles $item.FullName $rel }
        } elseif (-not (Test-Ignored $rel $false)) {
            [void]$LocalFiles.Add([pscustomobject]@{ Rel = $rel; Full = $item.FullName })
        }
    }
}

function Get-GitBlobSha([byte[]]$bytes) {
    $header = [Text.Encoding]::ASCII.GetBytes("blob $($bytes.Length)`0")
    $all = New-Object byte[] ($header.Length + $bytes.Length)
    [Array]::Copy($header, 0, $all, 0, $header.Length)
    [Array]::Copy($bytes, 0, $all, $header.Length, $bytes.Length)
    $sha1 = [Security.Cryptography.SHA1]::Create()
    return ([BitConverter]::ToString($sha1.ComputeHash($all)) -replace '-', '').ToLower()
}

# 0. The repository: its default branch when none was given
$repoInfo = Invoke-GH GET ""
if (-not $Branch) {
    $Branch = $repoInfo.default_branch
    if (-not $Branch) { $Branch = 'main' }
    Write-Host "Using branch '$Branch'"
}

# 1. Current head. A new empty repository has none (it is filled in step 2).
$fresh = $false
$headSha = $null
try {
    $ref = Invoke-GH GET "/git/ref/heads/$Branch"
    $headSha = $ref.object.sha
} catch {
    $status = 0
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    if ($status -eq 409) {
        Write-Host "Repository is empty; the first commit will hold the whole tree"
        $fresh = $true
    } elseif ($status -eq 404) {
        Write-Host "Branch '$Branch' does not exist; creating it from the default branch"
        $def = (Invoke-GH GET "").default_branch
        $dref = Invoke-GH GET "/git/ref/heads/$def"
        Invoke-GH POST "/git/refs" @{ ref = "refs/heads/$Branch"; sha = $dref.object.sha } | Out-Null
        $ref = Invoke-GH GET "/git/ref/heads/$Branch"
        $headSha = $ref.object.sha
    } else {
        throw
    }
}
$remote = @{}
$baseTree = $null
if (-not $fresh) {
    $commit = Invoke-GH GET "/git/commits/$headSha"
    $baseTree = $commit.tree.sha
    $tree = Invoke-GH GET "/git/trees/$baseTree`?recursive=1"
    if ($tree.truncated) { throw "The remote tree listing is truncated; cannot tell which files to delete" }
    foreach ($e in $tree.tree) { if ($e.type -eq 'blob') { $remote[$e.path] = $e.sha } }
    Write-Host "Head $($headSha.Substring(0,7)), $($remote.Count) remote files"
}

# 2. Local files: what changed. Before anything is uploaded, every changed file is searched for GitHub tokens (the
# classic and fine-grained formats, and the configured token itself): a stray copy of the settings or a saved log
# must not reach the repository, least of all in the first push, which publishes the whole tree.
Add-LocalFiles $rootFull ''
$TokenPattern = New-Object Text.RegularExpressions.Regex '(?:gh[pousr])_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}'
$Latin1 = [Text.Encoding]::GetEncoding(28591)
$changed = New-Object System.Collections.ArrayList
$leaks = New-Object System.Collections.ArrayList
$seen = @{}
foreach ($f in $LocalFiles) {
    $bytes = [IO.File]::ReadAllBytes($f.Full)
    $sha = Get-GitBlobSha $bytes
    $seen[$f.Rel] = $true
    if ($remote.ContainsKey($f.Rel) -and $remote[$f.Rel] -eq $sha) { continue }
    $text = $Latin1.GetString($bytes)
    if ($TokenPattern.IsMatch($text) -or $text.Contains($Token)) { [void]$leaks.Add($f.Rel) }
    [void]$changed.Add([pscustomobject]@{ Rel = $f.Rel; Full = $f.Full; Sha = $sha })
}
if ($leaks.Count -gt 0) {
    throw ("Nothing pushed: these files hold what looks like a GitHub token. Remove it, or add the files to .gitignore:`n  " + ($leaks -join "`n  "))
}
if ($fresh) {
    if ($changed.Count -eq 0) { throw "Nothing to push into the empty repository" }
    # The Git data API refuses to work in an empty repository: a placeholder file through the contents API makes it
    # usable, and the first real commit below has no parent, so the placeholder never becomes part of the history.
    $placeholder = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("`n"))
    Invoke-GH PUT "/contents/.first-push" @{ message = 'Placeholder for the first push'; content = $placeholder; branch = $Branch } | Out-Null
}
$entries = New-Object System.Collections.ArrayList
foreach ($f in $changed) {
    $bytes = [IO.File]::ReadAllBytes($f.Full)
    $blob = Invoke-GH POST "/git/blobs" @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' }
    if ($blob.sha -ne $f.Sha) { Write-Warning "sha mismatch for $($f.Rel) (local $($f.Sha), remote $($blob.sha))" }
    [void]$entries.Add(@{ path = $f.Rel; mode = '100644'; type = 'blob'; sha = $blob.sha })
    Write-Host "  + $($f.Rel)"
}
# (deleted here, or ignored now: a stale copy of an ignored directory goes as well)
foreach ($p in $remote.Keys) {
    if (-not $seen.ContainsKey($p)) {
        [void]$entries.Add(@{ path = $p; mode = '100644'; type = 'blob'; sha = $null })
        if (Test-Ignored $p $false) { Write-Host "  - $p (ignored)" } else { Write-Host "  - $p" }
    }
}
if ($entries.Count -eq 0 -and $fresh) { throw "Nothing to push into the empty repository" }
if ($entries.Count -eq 0) {
    Write-Host "Nothing to push."
    $tagSha = $headSha
} else {
    # 3. Tree, commit, ref
    if ($fresh) {
        $newTree = Invoke-GH POST "/git/trees" @{ tree = $entries.ToArray() }
        $newCommit = Invoke-GH POST "/git/commits" @{ message = $Message; tree = $newTree.sha; parents = @() }
        # (the placeholder commit is left behind, unreferenced)
        Invoke-GH PATCH "/git/refs/heads/$Branch" @{ sha = $newCommit.sha; force = $true } | Out-Null
    } else {
        $newTree = Invoke-GH POST "/git/trees" @{ base_tree = $baseTree; tree = $entries.ToArray() }
        $newCommit = Invoke-GH POST "/git/commits" @{ message = $Message; tree = $newTree.sha; parents = @($headSha) }
        Invoke-GH PATCH "/git/refs/heads/$Branch" @{ sha = $newCommit.sha; force = $false } | Out-Null
    }
    Write-Host "Pushed $($entries.Count) changes as $($newCommit.sha.Substring(0,7)): https://github.com/$Repo/commit/$($newCommit.sha)"
    $tagSha = $newCommit.sha
}

# 4. Tag (a lightweight one; an existing tag is never moved)
if ($Tag) {
    Invoke-GH POST "/git/refs" @{ ref = "refs/tags/$Tag"; sha = $tagSha } | Out-Null
    Write-Host "Tagged $($tagSha.Substring(0,7)) as $($Tag): https://github.com/$Repo/releases/tag/$Tag"
}
