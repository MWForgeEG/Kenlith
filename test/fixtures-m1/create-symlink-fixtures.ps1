# SG-M1-1 symbolic-link fixtures (Plan Chat M1).
#
# Creating a symbolic link on Windows needs the "Create symbolic links"
# privilege (an elevated process) or Developer Mode. This script is the ONLY
# step that needs it. It creates genuine NTFS symbolic links between synthetic
# files in one new folder under the current user's temp folder, checks them,
# writes a manifest, and does nothing else: no settings, no permissions, no
# services, no network. The tests then run WITHOUT elevation and only use,
# rename or remove these links.
#
# Run once, elevated (check this file's content first):
#   powershell -NoProfile -ExecutionPolicy Bypass -File create-symlink-fixtures.ps1
# Check what it would do, without elevation and without creating anything:
#   powershell -NoProfile -ExecutionPolicy Bypass -File create-symlink-fixtures.ps1 -DryRun
#
# It refuses to run if anything (a folder, a file or a link) already has the
# fixture name, or if the folder or any folder above it is a link or junction,
# so an elevated write cannot be redirected elsewhere.
# Remove the fixtures with:
#   Remove-Item -LiteralPath "$env:TEMP\plan-chat-sg-m1-1-symlinks" -Recurse -Force
# (removing a link never removes its target).

param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$temp = [IO.Path]::GetFullPath($env:TEMP)
# Only the signed-in user's own temp folder.
$expectedTemp = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'AppData\Local\Temp'))
if ($temp -ne $expectedTemp) { throw "refusing: TEMP is $temp, expected $expectedTemp" }
$base = Join-Path $temp 'plan-chat-sg-m1-1-symlinks'
$outside = Join-Path $base 'outside'
$outsideDir = Join-Path $outside 'dir'
$project = Join-Path $base 'project'
$spare = Join-Path $base 'spare'
$marker = 'OUTSIDE_SECRET'

# Every path this script writes, and every link target, is inside $base.
$links = @(
  @{ Path = (Join-Path $project 'leak.txt');      Target = (Join-Path $outside 'OUTSIDE.txt'); Kind = 'file' },
  @{ Path = (Join-Path $project 'leakdir');       Target = $outsideDir;                        Kind = 'dir' },
  @{ Path = (Join-Path $spare 'swap-file-link');  Target = (Join-Path $outside 'OUTSIDE.txt'); Kind = 'file' },
  @{ Path = (Join-Path $spare 'swap-dir-link');   Target = $outsideDir;                        Kind = 'dir' }
)
foreach ($link in $links) {
  foreach ($p in @($link.Path, $link.Target)) {
    if (-not ([IO.Path]::GetFullPath($p)).StartsWith([IO.Path]::GetFullPath($base) + '\')) { throw "path outside the fixture folder: $p" }
  }
}

# Refuses if the folder or any folder above it is a link or junction.
function Assert-NoReparsePoint([string]$folder) {
  $item = [IO.DirectoryInfo]$folder
  while ($item -ne $null) {
    if ($item.Exists -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "refusing: $($item.FullName) is a link or junction" }
    $item = $item.Parent
  }
}

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "fixture folder: $base"
Write-Output "elevated: $elevated"
if ($DryRun) {
  Write-Output 'DRY RUN: would create:'
  Write-Output "  $outside\OUTSIDE.txt and $outsideDir\OUTSIDE.txt (synthetic text '$marker')"
  Write-Output "  $project\app.js (synthetic)"
  foreach ($link in $links) { Write-Output ("  {0} symbolic link {1} -> {2}" -f $link.Kind, $link.Path, $link.Target) }
  Write-Output "  $base\manifest.json"
  exit 0
}
# Without the privilege nothing is created (no half-built folder).
if (-not $elevated) { throw 'refusing: run this script elevated (Run as administrator)' }
# Anything with the fixture name, including a dangling link, blocks the run.
$existing = [IO.Directory]::EnumerateFileSystemEntries($temp, 'plan-chat-sg-m1-1-symlinks').GetEnumerator()
if ($existing.MoveNext()) { throw "refusing to run: $base already exists" }
Assert-NoReparsePoint $temp

[IO.Directory]::CreateDirectory($base) | Out-Null
Assert-NoReparsePoint $base
foreach ($folder in @($outside, $outsideDir, $project, $spare)) { [IO.Directory]::CreateDirectory($folder) | Out-Null; Assert-NoReparsePoint $folder }
[IO.File]::WriteAllText((Join-Path $outside 'OUTSIDE.txt'), "$marker`r`n")
[IO.File]::WriteAllText((Join-Path $outsideDir 'OUTSIDE.txt'), "$marker`r`n")
[IO.File]::WriteAllText((Join-Path $project 'app.js'), "export const app = 1;`r`n")

$created = @()
foreach ($link in $links) {
  Assert-NoReparsePoint ([IO.Path]::GetDirectoryName($link.Path))
  New-Item -ItemType SymbolicLink -Path ([Management.Automation.WildcardPattern]::Escape($link.Path)) -Value $link.Target | Out-Null
  $item = Get-Item -LiteralPath $link.Path -Force
  $target = @($item.Target)[0]
  if ($item.LinkType -ne 'SymbolicLink') { throw "not a symbolic link: $($link.Path) ($($item.LinkType))" }
  if ([IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath($link.Target)) { throw "unexpected target for $($link.Path): $target" }
  $isDir = [bool]($item.Attributes -band [IO.FileAttributes]::Directory)
  if ($isDir -ne ($link.Kind -eq 'dir')) { throw "wrong link kind for $($link.Path)" }
  $created += [ordered]@{ path = $link.Path; target = $target; kind = $link.Kind; linkType = $item.LinkType }
}

$manifest = [ordered]@{
  purpose = 'Plan Chat SG-M1-1 symbolic-link fixtures (synthetic data only)'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  createdElevated = $elevated
  base = $base; project = $project; outside = $outside; spare = $spare; marker = $marker
  links = $created
}
Assert-NoReparsePoint $base
[IO.File]::WriteAllText((Join-Path $base 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4))
Write-Output 'created and checked:'
foreach ($c in $created) { Write-Output ("  {0} {1} -> {2}" -f $c.linkType, $c.path, $c.target) }
