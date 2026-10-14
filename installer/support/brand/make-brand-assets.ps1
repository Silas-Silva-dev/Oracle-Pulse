<#
.SYNOPSIS
    Gera os ícones e imagens da marca Oracle Pulse a partir da fonte vetorial
    (icon-defs.svg), renderizando com o Microsoft Edge em modo headless.

.DESCRIPTION
    Saídas:
      installer\support\OraclePulse.ico            16..256 px (BMP 32 bits; 256 em PNG)
      installer\support\wizard-small-*.png         cabeçalho do assistente
      installer\support\wizard-large-*.png         tela de boas-vindas/conclusão
      public\favicon.ico  e  public\favicon.png    ícone do painel web
    Cada tamanho usa o nível de detalhe adequado (ver icon-defs.svg).

.PARAMETER PreviewDir
    Se informado, salva também uma prancha de conferência (fundo claro e escuro,
    tamanhos pequenos ampliados) nessa pasta.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\support\brand\make-brand-assets.ps1
#>
param([string]$PreviewDir = '')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$BrandDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SupportDir = Split-Path -Parent $BrandDir
$Repo       = Split-Path -Parent (Split-Path -Parent $SupportDir)
$PublicDir  = Join-Path $Repo 'public'

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge não encontrado (necessário para renderizar o SVG).' }

$defs = Get-Content (Join-Path $BrandDir 'icon-defs.svg') -Raw -Encoding UTF8

# ---- Ícone (svg) por tamanho -------------------------------------------------
function N([double]$v) { return $v.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture) }

# Fundo arredondado com borda de no mínimo 1 pixel, alinhada à grade de pixels
# do tamanho final (é isso que deixa os cantos lisos também em 16 px).
function Get-TileSvg([int]$Size) {
    $u = 256.0 / $Size                                   # 1 pixel em unidades do viewBox
    $inset = if ($Size -le 32) { 0.0 } else { [math]::Round(12 / $u) * $u }
    $bw = [math]::Max(3.0, $u)
    $r = if ($Size -le 32) { 3.6 * $u } else { 56.0 * (256 - 2 * $inset) / 232 }
    $box = 256 - 2 * $inset
    return "<rect x='$(N $inset)' y='$(N $inset)' width='$(N $box)' height='$(N $box)' rx='$(N ($r + $bw / 2))' fill='url(#op-tile)'/>" +
        "<rect x='$(N ($inset + $bw / 2))' y='$(N ($inset + $bw / 2))' width='$(N ($box - $bw))' height='$(N ($box - $bw))' rx='$(N $r)' fill='none' stroke='#a9bfdc' stroke-width='$(N $bw)'/>"
}

function Get-IconSvg([int]$Size) {
    if ($Size -le 24) {
        $sym = 'op-tiny'; $tf = 'translate(128 128) translate(-134 -134)'
    } elseif ($Size -le 32) {
        $sym = 'op-compact'; $tf = 'translate(128 128) scale(1.08) translate(-133 -136)'
    } else {
        $sym = 'op-full'; $tf = 'translate(-4 -6)'
    }
    return "<svg width='$Size' height='$Size' viewBox='0 0 256 256'>$(Get-TileSvg $Size)<g transform='$tf'><use href='#$sym'/></g></svg>"
}

function Get-WizardLargeHtml([int]$K) {
    $w = 164 * $K; $h = 314 * $K; $ic = 112 * $K
    $icon = Get-IconSvg $ic
    return "<div style='width:${w}px;height:${h}px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:""Segoe UI"",Arial,sans-serif'>" +
        "<div style='margin-top:-$(18 * $K)px'>$icon</div>" +
        "<div style='margin-top:$(14 * $K)px;font-size:$(20 * $K)px;font-weight:700;color:#0d3f7f;letter-spacing:$(0.3 * $K)px'>Oracle Pulse</div>" +
        "<div style='margin-top:$(2 * $K)px;font-size:$(10.5 * $K)px;font-weight:600;color:#4f6f96'>Database Monitoring</div></div>"
}

# ---- Itens a renderizar --------------------------------------------------------
$items = New-Object System.Collections.Generic.List[object]
$IcoSizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
foreach ($s in $IcoSizes) { $items.Add(@{ Name = "ico-$s"; W = $s; H = $s; Html = (Get-IconSvg $s); Icon = $true }) }
foreach ($s in @(58, 77, 97, 116, 147)) { $items.Add(@{ Name = "wizard-small-$s"; W = $s; H = $s; Html = (Get-IconSvg $s); Icon = $true }) }
$items.Add(@{ Name = 'favicon-192'; W = 192; H = 192; Html = (Get-IconSvg 192); Icon = $true })
foreach ($k in 1, 2) { $items.Add(@{ Name = "wizard-large-$(164 * $k)x$(314 * $k)"; W = 164 * $k; H = 314 * $k; Html = (Get-WizardLargeHtml $k); Icon = $false }) }

# Layout em linhas (posições conhecidas para recortar depois).
$x = 10; $y = 10; $rowH = 0; $maxW = 1400
foreach ($it in $items) {
    if ($x + $it.W + 10 -gt $maxW) { $x = 10; $y += $rowH + 10; $rowH = 0 }
    $it.X = $x; $it.Y = $y
    $x += $it.W + 10; if ($it.H -gt $rowH) { $rowH = $it.H }
}
$pageW = $maxW; $pageH = $y + $rowH + 10

$body = ($items | ForEach-Object { "<div style='position:absolute;left:$($_.X)px;top:$($_.Y)px;width:$($_.W)px;height:$($_.H)px'>$($_.Html)</div>" }) -join "`n"
$html = "<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>`n$defs`n$body`n</body></html>"

$work = Join-Path ([IO.Path]::GetTempPath()) ('op-brand-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$page = Join-Path $work 'sheet.html'
[IO.File]::WriteAllText($page, $html, (New-Object System.Text.UTF8Encoding $false))
$shot = Join-Path $work 'sheet.png'

$p = Start-Process $edge -Wait -PassThru -ArgumentList @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--default-background-color=00000000', '--force-device-scale-factor=1',
    "--user-data-dir=`"$work\profile`"", "--window-size=$pageW,$pageH",
    "--screenshot=`"$shot`"", ([Uri]$page).AbsoluteUri)
if ($p.ExitCode -ne 0 -or -not (Test-Path $shot)) { throw "Edge não gerou a captura (código $($p.ExitCode))." }

# ---- Recorte e validação -------------------------------------------------------
$sheet = [System.Drawing.Bitmap]::FromFile($shot)
$bitmaps = @{}
try {
    foreach ($it in $items) {
        $rect = New-Object System.Drawing.Rectangle $it.X, $it.Y, $it.W, $it.H
        $bmp = $sheet.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        if ($it.Icon) {
            $corner = $bmp.GetPixel(0, 0).A
            $center = $bmp.GetPixel([int]($it.W / 2), [int]($it.H / 2)).A
            if ($corner -ne 0 -or $center -ne 255) { throw "$($it.Name): transparência inesperada (canto=$corner, centro=$center)." }
        }
        $bitmaps[$it.Name] = $bmp
    }
} finally {
    $sheet.Dispose()
}

function Save-Png($bmp, [string]$file) { $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) }

function Get-PngBytes($bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return , $ms.ToArray()
}

# Entrada DIB 32 bits (BGRA de baixo para cima + máscara AND), aceita por todo o Windows.
function Get-DibBytes($bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2)); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
    for ($row = $h - 1; $row -ge 0; $row--) {
        for ($col = 0; $col -lt $w; $col++) {
            $c = $bmp.GetPixel($col, $row)
            $bw.Write([byte]$c.B); $bw.Write([byte]$c.G); $bw.Write([byte]$c.R); $bw.Write([byte]$c.A)
        }
    }
    $maskStride = [int]([math]::Ceiling($w / 32.0) * 4)
    for ($row = $h - 1; $row -ge 0; $row--) {
        $line = New-Object byte[] $maskStride
        for ($col = 0; $col -lt $w; $col++) {
            if ($bmp.GetPixel($col, $row).A -eq 0) { $line[[int][math]::Floor($col / 8)] = $line[[int][math]::Floor($col / 8)] -bor (0x80 -shr ($col % 8)) }
        }
        $bw.Write($line)
    }
    $bw.Flush()
    return , $ms.ToArray()
}

function Write-Ico([string]$file, [int[]]$sizes) {
    $images = @()
    foreach ($s in $sizes) {
        $bmp = $bitmaps["ico-$s"]
        $images += , @{ Size = $s; Data = $(if ($s -ge 256) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }) }
    }
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $ms
    $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($im in $images) {
        $b = if ($im.Size -ge 256) { 0 } else { $im.Size }
        $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
        $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$im.Data.Length); $bw.Write([uint32]$offset)
        $offset += $im.Data.Length
    }
    foreach ($im in $images) { $bw.Write([byte[]]$im.Data) }
    $bw.Flush()
    [IO.File]::WriteAllBytes($file, $ms.ToArray())
}

# ---- Saídas ---------------------------------------------------------------------
Write-Ico (Join-Path $SupportDir 'OraclePulse.ico') $IcoSizes
Write-Ico (Join-Path $PublicDir 'favicon.ico') @(16, 24, 32, 48)
Save-Png $bitmaps['favicon-192'] (Join-Path $PublicDir 'favicon.png')
foreach ($s in @(58, 77, 97, 116, 147)) { Save-Png $bitmaps["wizard-small-$s"] (Join-Path $SupportDir "wizard-small-$s.png") }
foreach ($k in 1, 2) { $n = "wizard-large-$(164 * $k)x$(314 * $k)"; Save-Png $bitmaps[$n] (Join-Path $SupportDir "$n.png") }

# Conferência: lê o diretório do .ico e decodifica cada imagem (DIB pelo
# System.Drawing.Icon; a de 256 px, em PNG, pelo decodificador de imagens).
function Test-Ico([string]$file, [int[]]$expected) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $count = [BitConverter]::ToUInt16($bytes, 4)
    if ($count -ne $expected.Count) { throw "$file tem $count imagens (esperado $($expected.Count))." }
    for ($i = 0; $i -lt $count; $i++) {
        $e = 6 + 16 * $i
        $w = if ($bytes[$e] -eq 0) { 256 } else { $bytes[$e] }
        $len = [BitConverter]::ToUInt32($bytes, $e + 8); $off = [BitConverter]::ToUInt32($bytes, $e + 12)
        if ($w -ne $expected[$i] -or ($off + $len) -gt $bytes.Length) { throw "$file entrada $i inválida." }
        if ($w -ge 256) {
            $img = [System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream (, $bytes[$off..($off + $len - 1)])))
            if ($img.Width -ne 256) { throw "$file PNG de 256 px inválido." }
            $img.Dispose()
        } else {
            $ico = New-Object System.Drawing.Icon $file, $w, $w
            if ($ico.Width -ne $w) { throw "$file sem a imagem de ${w}px." }
            $ico.Dispose()
        }
    }
}
Test-Ico (Join-Path $SupportDir 'OraclePulse.ico') $IcoSizes
Test-Ico (Join-Path $PublicDir 'favicon.ico') @(16, 24, 32, 48)

# ---- Prancha de conferência (opcional) -------------------------------------------
if ($PreviewDir) {
    New-Item -ItemType Directory -Force $PreviewDir | Out-Null
    $sheetW = 1320; $sheetH = 720
    $pv = New-Object System.Drawing.Bitmap $sheetW, $sheetH
    $g = [System.Drawing.Graphics]::FromImage($pv)
    $g.Clear([System.Drawing.Color]::FromArgb(243, 243, 243))
    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(32, 32, 32))), 0, 360, $sheetW, 360)
    foreach ($band in @(0, 360)) {
        $px = 16
        foreach ($s in @(256, 128, 64, 48, 40, 32, 24, 20, 16)) {
            $g.DrawImageUnscaled($bitmaps["ico-$s"], $px, $band + 16); $px += $s + 14
        }
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
        $px = 290
        foreach ($s in @(48, 32, 24, 20, 16)) {
            $z = [int](96 / $s * 1.6); if ($z -lt 2) { $z = 2 }
            $g.DrawImage($bitmaps["ico-$s"], $px, $band + 290 - [int]($s * $z / 2) - 40, $s * $z, $s * $z); $px += $s * $z + 14
        }
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Default
        $g.DrawImageUnscaled($bitmaps['wizard-large-164x314'], 1140, $band + 20)
    }
    $g.Dispose()
    $pv.Save((Join-Path $PreviewDir 'brand-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $pv.Dispose()
}

foreach ($b in $bitmaps.Values) { $b.Dispose() }
try { Remove-Item $work -Recurse -Force -ErrorAction Stop } catch { }
Write-Host 'Ativos da marca gerados:'
Write-Host "  $SupportDir\OraclePulse.ico, wizard-small-*.png, wizard-large-*.png"
Write-Host "  $PublicDir\favicon.ico, favicon.png"
