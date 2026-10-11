# Uploads your installed Caesar III folder (without the intro videos) to the private R2 bucket.
# Usage: .\web\upload-game-data.ps1 -Source "C:\GOG Games\Caesar 3" [-Bucket augustus-c3-data]
# Needs: Node.js, and `npx wrangler login` done once (or CLOUDFLARE_API_TOKEN set).
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [string]$Bucket = "augustus-c3-data"
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $root "c3.sg2"))) {
    throw "No c3.sg2 in '$root'. Point this at the folder that directly contains the game files."
}

$skipExtensions = @(".exe", ".dll", ".pdf", ".ico", ".url", ".lnk", ".inf", ".ini")
$skipPrefixes = @("goggame", "unins", "webcache")
$count = 0

Get-ChildItem -Path $root -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
    $lower = $relative.ToLowerInvariant()
    $name = $_.Name.ToLowerInvariant()
    if ($lower.StartsWith("smk/")) { return }                              # intro and mission videos, not needed
    if ($skipExtensions -contains $_.Extension.ToLowerInvariant()) { return }
    foreach ($prefix in $skipPrefixes) { if ($name.StartsWith($prefix)) { return } }
    Write-Host "Uploading $relative"
    npx --yes wrangler@4 r2 object put "$Bucket/c3/$relative" --file $_.FullName --remote
    if ($LASTEXITCODE -ne 0) { throw "Upload of $relative failed" }
    $count++
}
Write-Host "Done: $count files uploaded to $Bucket"
