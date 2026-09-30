$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  throw 'Unsupported operating system'
}

if ($env:EXTRABRAIN_WAIT_PID) {
  $waitPid = [int]$env:EXTRABRAIN_WAIT_PID
  while (Get-Process -Id $waitPid -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 200
  }
}

$repository = 'ExtraBrainApp/ExtraBrain-cli'
$releaseBase = if ($env:EXTRABRAIN_RELEASE_BASE) { $env:EXTRABRAIN_RELEASE_BASE } else { "https://github.com/$repository/releases" }
$installDir = if ($env:EXTRABRAIN_INSTALL_DIR) { $env:EXTRABRAIN_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ExtraBrain\bin' }
$arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
  'X64' { 'x64' }
  default { throw 'Unsupported architecture' }
}
if ($env:EXTRABRAIN_VERSION) {
  $version = $env:EXTRABRAIN_VERSION
} else {
  $release = Invoke-RestMethod "https://api.github.com/repos/$repository/releases/latest"
  $version = $release.tag_name
}
if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid release version' }

$asset = "extrabrain-$version-win32-$arch.zip"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("extrabrain-install-" + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
  $manifest = Join-Path $temporary 'SHA256SUMS'
  $archive = Join-Path $temporary $asset
  Invoke-WebRequest "$releaseBase/download/$version/SHA256SUMS" -OutFile $manifest
  Invoke-WebRequest "$releaseBase/download/$version/$asset" -OutFile $archive
  $matches = @(Get-Content $manifest | Where-Object { $_ -match ('^[a-fA-F0-9]{64}  ' + [regex]::Escape($asset) + '$') })
  if ($matches.Count -ne 1) { throw 'Release checksum is missing or invalid' }
  $expected = $matches[0].Substring(0, 64).ToLowerInvariant()
  $stream = [IO.File]::OpenRead($archive)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
  if ($actual -ne $expected) { throw 'Release checksum mismatch' }

  Expand-Archive -LiteralPath $archive -DestinationPath $temporary -Force
  $source = Join-Path $temporary 'extrabrain.exe'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Release executable is missing' }
  [IO.Directory]::CreateDirectory($installDir) | Out-Null
  $target = Join-Path $installDir 'extrabrain.exe'
  $staging = Join-Path $installDir ('.extrabrain.' + [guid]::NewGuid().ToString('N') + '.exe')
  $backup = Join-Path $installDir ('.extrabrain.backup.' + [guid]::NewGuid().ToString('N') + '.exe')
  try {
    [IO.File]::Copy($source, $staging)
    if ([IO.File]::Exists($target)) {
      [IO.File]::Replace($staging, $target, $backup)
    } else {
      [IO.File]::Move($staging, $target)
    }
  } finally {
    if ([IO.File]::Exists($staging)) { [IO.File]::Delete($staging) }
    if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
  }
  if (-not $env:EXTRABRAIN_INSTALL_DIR) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($userPath -split ';' | Where-Object { $_ })
    if ($pathEntries -notcontains $installDir) {
      [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $installDir) -join ';'), 'User')
    }
    if (@($env:PATH -split ';') -notcontains $installDir) { $env:PATH += ";$installDir" }
  }
  Write-Output "Installed extrabrain $version at $target"
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
