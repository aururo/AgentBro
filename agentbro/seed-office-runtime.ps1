<#
.SYNOPSIS
    预置 Office 运行时的 Python 发行包到本地下载缓存。

.DESCRIPTION
    scripts/office-runtime/prepare.mjs 按 sha256 缓存下载物：
    缓存路径是 .build/office-downloads/<sha256>，命中缓存就跳过网络。

    本机直连 GitHub releases 的落点（release-assets.githubusercontent.com）超时，
    因此这里先从二进制镜像取回同一份产物，校验 sha256 后写入缓存，
    让上游脚本按原样命中缓存，不改动它的下载逻辑。

    幂等：缓存里已有校验通过的同名文件就直接跳过。

.PARAMETER Project
    仓库根目录，默认取脚本上级目录。
#>
[CmdletBinding()]
param(
    [string]$Project
)

$ErrorActionPreference = 'Stop'

if (-not $Project) {
    $Project = Split-Path -Parent $MyInvocation.MyCommand.Path
    $Project = Split-Path -Parent $Project
}

$lock = Get-Content (Join-Path $Project 'scripts\office-runtime\lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$target = $lock.targets.'win-x64'
if (-not $target) { throw 'lock.json 里没有 win-x64 目标' }

$filename = "cpython-$($lock.pythonVersion)+$($lock.pythonRelease)-$($target.pythonTarget)-install_only_stripped.tar.gz"
$source = "https://github.com/astral-sh/python-build-standalone/releases/download/$($lock.pythonRelease)/$([uri]::EscapeDataString($filename))"

$cache = Join-Path $Project '.build\office-downloads'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$destination = Join-Path $cache $target.pythonSha256

if (Test-Path $destination) {
    $existing = (Get-FileHash $destination -Algorithm SHA256).Hash.ToLower()
    if ($existing -eq $target.pythonSha256.ToLower()) {
        Write-Host "缓存已就绪：$destination" -ForegroundColor Green
        exit 0
    }
    Write-Host '缓存文件校验不通过，重新下载。' -ForegroundColor Yellow
}

Write-Host "下载 $filename" -ForegroundColor Cyan

$mirrors = @(
    "https://cdn.npmmirror.com/binaries/python-build-standalone/$($lock.pythonRelease)/$([uri]::EscapeDataString($filename))",
    "https://gh-proxy.com/$source"
)

$downloaded = $false
foreach ($mirror in $mirrors) {
    Write-Host "  尝试：$mirror"
    & curl.exe -sL --connect-timeout 15 --max-time 1800 -o $destination $mirror
    if ($LASTEXITCODE -eq 0 -and (Test-Path $destination) -and (Get-Item $destination).Length -gt 1MB) {
        $downloaded = $true
        break
    }
    Write-Host '    该源不可用，换下一个。' -ForegroundColor Yellow
}
if (-not $downloaded) { throw '所有镜像源都未能下载 Office Python 运行时' }

$actual = (Get-FileHash $destination -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $target.pythonSha256.ToLower()) {
    Remove-Item $destination -Force
    throw "sha256 校验失败：期望 $($target.pythonSha256)，实际 $actual"
}

Write-Host "预置完成：$destination（$([math]::Round((Get-Item $destination).Length/1MB,1)) MB）" -ForegroundColor Green

