<#
.SYNOPSIS
    从定制主线切出一条主题分支。

.DESCRIPTION
    仓库分支拓扑：
      main                    —— 上游基线镜像，跟随 upstream/main，不写业务定制
      feature/agentbro-custom —— 定制主线，长期存在，承载全部定制
      feature/<topic>         —— 主题分支，从定制主线切出，做完合回定制主线

    本脚本先把定制主线同步到最新上游，再从它切出主题分支，
    避免从过期的基线开工。基线同步失败时中止，不留下半截分支。

.PARAMETER Name
    主题名。自动补 feature/ 前缀；已带前缀则原样使用。

.PARAMETER NoSync
    跳过基线同步，直接从定制主线当前状态切出。

.EXAMPLE
    ./agentbro/new-topic.ps1 -Name chat-panel
    ./agentbro/new-topic.ps1 -Name feature/ppt-export
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [switch]$NoSync
)

$ErrorActionPreference = 'Stop'

Set-Location (Split-Path -Parent $PSScriptRoot)

$custom = 'feature/agentbro-custom'

if ($Name -notmatch '^[a-z0-9][a-z0-9._/-]*$') {
    throw "分支名只能用小写字母、数字、点、下划线和短横线：$Name"
}

$branch = if ($Name.StartsWith('feature/')) { $Name } else { "feature/$Name" }

if (@(git branch --list $branch).Count -gt 0) {
    throw "分支已存在：$branch"
}

if (-not $NoSync) {
    Write-Host "==> 同步上游到 $custom" -ForegroundColor Cyan
    & git switch $custom
    if ($LASTEXITCODE -ne 0) { throw "切换到 $custom 失败" }
    & git fetch upstream --prune
    if ($LASTEXITCODE -ne 0) { throw '拉取上游失败' }
    & git merge --no-edit upstream/main
    if ($LASTEXITCODE -ne 0) { throw '合并上游失败，请手工处理冲突后重试' }
}

Write-Host "==> 切出 $branch" -ForegroundColor Cyan
& git switch -c $branch $custom
if ($LASTEXITCODE -ne 0) { throw "创建 $branch 失败" }

Write-Host "已切到 $branch，基线为 $custom。" -ForegroundColor Green
Write-Host "做完后合回定制主线：" -ForegroundColor DarkGray
Write-Host "  git switch $custom" -ForegroundColor DarkGray
Write-Host "  git merge --no-ff $branch" -ForegroundColor DarkGray

