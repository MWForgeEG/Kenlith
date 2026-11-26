# Kenlith 0.12.0 (DEC-PLANCHAT-052), step B of three: creates ONLY the four
# SG6 symbolic links inside the persistent fixture folder that step A
# (prepare-sg6-fixtures.js, NOT elevated) has prepared:
#   %LOCALAPPDATA%\Kenlith\TestFixtures\SG6\fixtures
#
# Creating a symbolic link needs an elevated process (Developer Mode stays off,
# DEC-PLANCHAT-052). This is the only elevated step. It writes nothing else:
# no file, no setting, no permission, no service, no network. The link set is
# hard-coded below; nothing that decides what is written is read from a file.
#
# Run once, in an ELEVATED PowerShell (read this file first):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\test\fixtures-m1\create-sg6-links.ps1" -ExpectedUser "$env:USERDOMAIN\$env:USERNAME"
# Check what it would do, without elevation and without creating anything:
#   ... -ExpectedUser "$env:USERDOMAIN\$env:USERNAME" -DryRun
#
# It refuses if: the elevated identity is not -ExpectedUser (so another
# administrator account cannot write into this profile); LOCALAPPDATA is not
# USERPROFILE\AppData\Local; any folder on the path is a link or junction;
# the sentinel is missing, not a plain file, or names another user; the
# fixture folder is not owned by that user (prepare it NOT elevated); a link
# path already exists (a dangling link included); a target is missing, of the
# wrong kind, a link itself or outside the fixture folder. After creating each
# link it checks it (SymbolicLink, exact target, kind).
# Then verify, NOT elevated: node test/fixtures-m1/check-symlink-fixtures.js --require-persistent

param([Parameter(Mandatory)][string]$ExpectedUser, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($id.Name -ne $ExpectedUser) { throw "refusing: running as $($id.Name), expected $ExpectedUser" }
$local = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$expectedLocal = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'AppData\Local'))
if ($local -ne $expectedLocal) { throw "refusing: LOCALAPPDATA is $local, expected $expectedLocal" }
$root = Join-Path $local 'Kenlith\TestFixtures\SG6'
$base = Join-Path $root 'fixtures'

# Every existing folder from $p up to the drive root: not a link or junction.
function Assert-NoReparse([string]$p) {
  $d = [IO.DirectoryInfo]$p
  while ($d -ne $null) {
    if (-not $d.Exists) { throw "refusing: $($d.FullName) does not exist (run step A first)" }
    if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "refusing: $($d.FullName) is a link or junction" }
    $d = $d.Parent
  }
}
function Assert-Inside([string]$p) {
  if (-not ([IO.Path]::GetFullPath($p)).StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: outside the fixture folder: $p" }
}

Assert-NoReparse $base
$sentinel = Join-Path $root '.kenlith-sg6-root.json'
if (-not (Test-Path -LiteralPath $sentinel)) { throw "refusing: no sentinel at $sentinel (run step A first)" }
$s = Get-Item -LiteralPath $sentinel -Force
if ($s.PSIsContainer -or ($s.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'refusing: the sentinel is not a plain file' }
if ((ConvertFrom-Json ([IO.File]::ReadAllText($sentinel))).userSid -ne $id.User.Value) { throw 'refusing: the sentinel belongs to another user' }
$owner = (Get-Acl -LiteralPath $base).GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $id.User.Value) { throw "refusing: $base is owned by $owner, not by $ExpectedUser (prepare it NOT elevated)" }

# Hard-coded. Targets are absolute, as with the earlier TEMP set.
$links = @(
  @{ Rel = 'project\leak.txt';     Target = 'outside\OUTSIDE.txt'; Dir = $false },
  @{ Rel = 'project\leakdir';      Target = 'outside\dir';         Dir = $true  },
  @{ Rel = 'spare\swap-file-link'; Target = 'outside\OUTSIDE.txt'; Dir = $false },
  @{ Rel = 'spare\swap-dir-link';  Target = 'outside\dir';         Dir = $true  }
)
foreach ($l in $links) {
  $l.Path = Join-Path $base $l.Rel
  $l.Abs = Join-Path $base $l.Target
  Assert-Inside $l.Path
  Assert-Inside $l.Abs
  Assert-NoReparse ([IO.Path]::GetDirectoryName($l.Path))
  if (-not (Test-Path -LiteralPath $l.Abs)) { throw "refusing: target missing: $($l.Abs) (run step A first)" }
  $t = Get-Item -LiteralPath $l.Abs -Force
  if (($t.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($t.PSIsContainer -ne $l.Dir)) { throw "refusing: unexpected target $($l.Abs)" }
  # Anything with the link's name, a dangling link included, blocks the run.
  $e = [IO.Directory]::EnumerateFileSystemEntries([IO.Path]::GetDirectoryName($l.Path), [IO.Path]::GetFileName($l.Path)).GetEnumerator()
  if ($e.MoveNext()) { throw "refusing: $($l.Path) already exists (repair: see docs/kenlith-0.12.0/SG6-FIXTURES.md)" }
}

$elevated = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "fixture folder: $base"
Write-Output "identity: $($id.Name)  elevated: $elevated"
if ($DryRun) {
  Write-Output 'DRY RUN: would create:'
  foreach ($l in $links) { Write-Output ("  {0} symbolic link {1} -> {2}" -f $(if ($l.Dir) { 'dir' } else { 'file' }), $l.Path, $l.Abs) }
  exit 0
}
if (-not $elevated) { throw 'refusing: run this script elevated (Run as administrator)' }

foreach ($l in $links) {
  Assert-NoReparse ([IO.Path]::GetDirectoryName($l.Path))   # again, just before the privileged write
  New-Item -ItemType SymbolicLink -Path ([Management.Automation.WildcardPattern]::Escape($l.Path)) -Value $l.Abs | Out-Null
  $i = Get-Item -LiteralPath $l.Path -Force
  if ($i.LinkType -ne 'SymbolicLink') { throw "verification failed, not a symbolic link: $($l.Path)" }
  if ([IO.Path]::GetFullPath(@($i.Target)[0]) -ne $l.Abs) { throw "verification failed, unexpected target: $($l.Path)" }
  if ([bool]($i.Attributes -band [IO.FileAttributes]::Directory) -ne $l.Dir) { throw "verification failed, wrong kind: $($l.Path)" }
  Write-Output "created SymbolicLink $($l.Path) -> $($l.Abs)"
}
Write-Output 'step B done. Verify NOT elevated: node test/fixtures-m1/check-symlink-fixtures.js --require-persistent'
