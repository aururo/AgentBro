<#
.SYNOPSIS
    载入本机构建环境变量（Electron 镜像 + 各类缓存落盘位置）。

.DESCRIPTION
    本机直连 github.com / objects.githubusercontent.com / release-assets.githubusercontent.com
    不稳定，构建期下载需要绕行或改落盘位置：

      ELECTRON_MIRROR        —— Electron 二进制改从 npmmirror 镜像取，避开 GitHub releases 302
      electron_config_cache  —— Electron 44 install.js 只读小写变量
      ELECTRON_CACHE         —— electron-builder 读大写变量
      ELECTRON_BUILDER_CACHE —— NSIS / winCodeSign 等 builder 工具缓存
      npm_config_cache       —— npm 包缓存，避开只剩 4GB 的 C 盘

    用法（PowerShell 5.1 需要 ExecutionPolicy 放行一次）：
      Set-ExecutionPolicy -Scope Process Bypass
      . .\agentbro\env.ps1

.PARAMETER CacheRoot
    各类缓存的根目录，默认 E:\temp。
#>
[CmdletBinding()]
param(
    [string]$CacheRoot = 'E:\temp'
)

$ErrorActionPreference = 'Stop'

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CACHE = Join-Path $CacheRoot 'electron-cache'
$env:electron_config_cache = $env:ELECTRON_CACHE
$env:ELECTRON_BUILDER_CACHE = Join-Path $CacheRoot 'electron-builder-cache'
$env:npm_config_cache = Join-Path $CacheRoot 'npm-cache'

foreach ($dir in @($env:ELECTRON_CACHE, $env:ELECTRON_BUILDER_CACHE, $env:npm_config_cache)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

Write-Host '构建环境变量已载入：' -ForegroundColor Green
Write-Host "  ELECTRON_MIRROR        = $env:ELECTRON_MIRROR"
Write-Host "  ELECTRON_CACHE         = $env:ELECTRON_CACHE"
Write-Host "  electron_config_cache  = $env:electron_config_cache"
Write-Host "  ELECTRON_BUILDER_CACHE = $env:ELECTRON_BUILDER_CACHE"
Write-Host "  npm_config_cache       = $env:npm_config_cache"

