<#
.SYNOPSIS
    Publica uma nova versão do Oracle Pulse no GitHub (Release + instalador anexado)
    num único comando. É o que a tela "Sobre" usa para detectar/baixar atualizações.

.DESCRIPTION
    Faz, em ordem:
      1. (opcional) muda a versão em package.json / package-lock.json e faz commit;
      2. compila o instalador (installer\build.ps1) e calcula o SHA-256;
      3. cria a tag vX.Y.Z e envia (push) main + tag;
      4. cria a Release no GitHub e anexa o .exe, com o SHA-256 nas notas.

    Para o passo 4 usa, nesta ordem de preferência:
      - o GitHub CLI "gh" (se instalado e autenticado) — nada mais é preciso; ou
      - a API do GitHub com um token (-Token ou $env:GITHUB_TOKEN); ou
      - se não houver nenhum, para após o passo 3 e mostra o passo manual.

.EXAMPLE
    # Lança a versão que está no package.json (gh instalado):
    powershell -ExecutionPolicy Bypass -File installer\release.ps1

.EXAMPLE
    # Sobe para 2.3.1 e publica usando um token:
    $env:GITHUB_TOKEN = "ghp_xxx"
    powershell -ExecutionPolicy Bypass -File installer\release.ps1 -Version 2.3.1

.NOTES
    Token (quando não usa gh): crie um Personal Access Token com permissão de
    escrita no repositório (classic: escopo "repo"; fine-grained: Contents RW) e
    informe em -Token ou na variável de ambiente GITHUB_TOKEN.
#>
param(
    [string]$Version = '',          # ex.: 2.3.1 — se vazio, usa a do package.json
    [string]$Token = '',            # senão, usa $env:GITHUB_TOKEN
    [string]$Notes = '',            # notas da release (senão, um texto padrão)
    [switch]$Draft,                 # cria como rascunho
    [switch]$SkipBuild              # não recompila (usa o .exe já existente)
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $Here '..')
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host "ERRO: $m" -ForegroundColor Red; exit 1 }

# ---- repositório (dono/nome) a partir do remote origin -------------------
$originUrl = (& git -C $Root remote get-url origin).Trim()
if ($originUrl -notmatch 'github\.com[:/]+([^/]+)/([^/.]+)') { Die "remote 'origin' não é um repositório do GitHub: $originUrl" }
$Owner = $Matches[1]; $Repo = $Matches[2]
Info "Repositório: $Owner/$Repo"

# ---- versão ---------------------------------------------------------------
$pkgPath = Join-Path $Root 'package.json'
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { Die "versão inválida: $Version (use X.Y.Z)" }
    if ($pkg.version -ne $Version) {
        Info "Mudando a versão $($pkg.version) -> $Version"
        foreach ($f in @($pkgPath, (Join-Path $Root 'package-lock.json'))) {
            (Get-Content $f -Raw) -replace "`"version`":\s*`"$([regex]::Escape($pkg.version))`"", "`"version`": `"$Version`"" | Set-Content $f -NoNewline -Encoding UTF8
        }
        & git -C $Root add package.json package-lock.json
        & git -C $Root commit -m "chore: release v$Version" | Out-Null
    }
} else {
    $Version = $pkg.version
}
$Tag = "v$Version"
Info "Versão: $Version  (tag $Tag)"

# ---- árvore limpa? --------------------------------------------------------
if ((& git -C $Root status --porcelain)) { Die "há alterações não commitadas. Faça commit (ou use -Version para versionar) antes de publicar." }

# ---- build + SHA-256 ------------------------------------------------------
$exe = Join-Path $Root "installer\dist\OraclePulse-Setup-$Version.exe"
if (-not $SkipBuild) {
    Info "Compilando o instalador..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'build.ps1')
    if ($LASTEXITCODE -ne 0) { Die "a compilação falhou." }
}
if (-not (Test-Path $exe)) { Die "instalador não encontrado: $exe" }
$Sha = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
Info "Instalador: $exe"
Info "SHA-256: $Sha"

# ---- notas (o SHA-256 é OBRIGATÓRIO: a tela Sobre confere a integridade) ---
if (-not $Notes) { $Notes = "Oracle Pulse $Tag" }
$Body = "$Notes`n`nSHA-256: $Sha"

# ---- tag + push -----------------------------------------------------------
Info "Enviando commits e a tag..."
& git -C $Root push origin HEAD
if (& git -C $Root tag --list $Tag) { Write-Host "  (a tag $Tag já existe)" } else { & git -C $Root tag $Tag }
& git -C $Root push origin $Tag

# ---- criar a Release e anexar o instalador --------------------------------
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $Token) { $Token = $env:GITHUB_TOKEN }

if ($gh) {
    Info "Publicando a Release com o GitHub CLI (gh)..."
    $notesFile = New-TemporaryFile
    Set-Content -Path $notesFile -Value $Body -Encoding UTF8
    $args = @('release', 'create', $Tag, $exe, '--title', $Tag, '--notes-file', $notesFile)
    if ($Draft) { $args += '--draft' }
    & gh @args
    Remove-Item $notesFile -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { Die "gh release create falhou." }
    Info "Release publicada: https://github.com/$Owner/$Repo/releases/tag/$Tag"
}
elseif ($Token) {
    Info "Publicando a Release pela API do GitHub..."
    $headers = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'Oracle-Pulse-Release'; Accept = 'application/vnd.github+json' }
    $payload = @{ tag_name = $Tag; name = $Tag; body = $Body; draft = [bool]$Draft } | ConvertTo-Json
    try {
        $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $headers -Body $payload -ContentType 'application/json'
    } catch {
        Die "falha ao criar a Release (a tag já tem release? token sem permissão?): $($_.Exception.Message)"
    }
    $uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($rel.id)/assets?name=$([IO.Path]::GetFileName($exe))"
    Info "Enviando o instalador ($([math]::Round((Get-Item $exe).Length/1MB,1)) MB)..."
    Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -InFile $exe -ContentType 'application/octet-stream' | Out-Null
    Info "Release publicada: $($rel.html_url)"
}
else {
    Write-Host ''
    Write-Host 'A tag foi enviada, mas falta criar a Release (sem gh e sem token).' -ForegroundColor Yellow
    Write-Host 'Faça o passo final manualmente OU rode de novo com -Token:' -ForegroundColor Yellow
    Write-Host "  1. Abra: https://github.com/$Owner/$Repo/releases/new?tag=$Tag"
    Write-Host "  2. Anexe o arquivo: $exe"
    Write-Host "  3. Cole nas notas:  SHA-256: $Sha"
    Write-Host '  4. Publique (Publish release).'
    exit 2
}
Info 'Concluído. A tela "Sobre" dos painéis instalados já detecta esta versão.'
