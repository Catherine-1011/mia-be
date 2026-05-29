# Fix all req. references to request. in controllers
$files = @(
    ".\controllers\sellerOnboarding.js",
    ".\controllers\sellerOrders.js",
    ".\routes\userRoute.js"
)

foreach ($file in $files) {
    if (Test-Path $file) {
        $content = Get-Content $file -Raw
        $content = $content -replace '\breq\.', 'request.'
        Set-Content $file $content
        Write-Host "✓ Fixed $file" -ForegroundColor Green
    }
}

Write-Host "`nAll req. references fixed!" -ForegroundColor Cyan
