<#
.SYNOPSIS
    把上游 dataelement/dsh-desktop 的新增提交合入当前分支。

.DESCRIPTION
    把上游 dataelement/dsh-desktop 的新增提交合入当前分支。

    AgentBro 是上游的 GitHub fork，网页端也有 Sync fork 按钮；
    本脚本走本地 upstream remote，便于先看清领先/落后再决定合并策略。

    分支模型：
      main        —— 产品主线，跟随 origin/main
      feature/*   —— 二次开发分支

    默认用 merge 而不是 rebase：main 是长期共享分支，rebase 会改写已推送历史。
    尚未推送的 feature 分支若想保持线性历史，可加 -Rebase。

.PARAMETER Branch
    要同步的本地分支，默认当前分支。

.PARAMETER Rebase
    用 rebase 代替 merge，仅建议用于尚未推送的 feature 分支。

.PARAMETER Push
    同步完成后把该分支推送到 origin。

.EXAMPLE
    ./agentbro/sync-upstream.ps1
    ./agentbro/sync-upstream.ps1 -Branch feature/xxx -Rebase
    ./agentbro/sync-upstream.ps1 -Push
#>
[CmdletBinding()]
param(
    [string]$Branch,
    [switch]$Rebase,
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not $Branch) {
    $Branch = (& git rev-parse --abbrev-ref HEAD).Trim()
}

function Invoke-Git {
    param([string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') 失败（exit=$LASTEXITCODE）"
    }
}

Write-Host "==> 分支 $Branch" -ForegroundColor Cyan

$status = & git status --porcelain
if ($status) {
    Write-Host '工作区存在未提交改动，先提交或 stash 后重试：' -ForegroundColor Yellow
    $status | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host '==> 拉取上游' -ForegroundColor Cyan
Invoke-Git -GitArgs @('fetch', 'upstream', '--prune')

$counts = (& git rev-list --left-right --count 'HEAD...upstream/main').Trim() -split '\s+'
$ahead = [int]$counts[0]
$behind = [int]$counts[1]
Write-Host "  相对 upstream/main：领先 $ahead，落后 $behind" -ForegroundColor DarkGray

if ($behind -eq 0) {
    Write-Host '  已包含上游最新提交，无需合并。' -ForegroundColor Green
} else {
    if ($Rebase) {
        Write-Host "==> rebase upstream/main -> $Branch" -ForegroundColor Cyan
        Invoke-Git -GitArgs @('rebase', 'upstream/main')
    } else {
        Write-Host "==> merge upstream/main -> $Branch" -ForegroundColor Cyan
        Invoke-Git -GitArgs @('merge', '--no-edit', 'upstream/main')
    }
}

if ($Push) {
    Write-Host "==> 推送 $Branch 到 origin" -ForegroundColor Cyan
    Invoke-Git -GitArgs @('push', 'origin', $Branch)
}

Write-Host '完成。' -ForegroundColor Green

