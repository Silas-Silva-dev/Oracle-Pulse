<#
.SYNOPSIS
    Gera o instalador Windows do Oracle Pulse: installer\dist\OraclePulse-Setup-<versão>.exe

.DESCRIPTION
    1. Baixa (com SHA-256 conferido) o Node.js portátil, o WinSW e, se não houver
       um Inno Setup 6.3+ na máquina, o Inno Setup portátil. Cache: installer\.cache
    2. Monta installer\build\app (= pasta instalada) com os arquivos do projeto
       que o git enxerga (versionados e novos não ignorados); o que o .gitignore
       exclui (.env, logs, node_modules locais) nunca entra.
    3. Instala as dependências com "npm ci --omit=dev" usando o próprio Node
       empacotado (sem scripts de instalação: nada é compilado na máquina).
    4. Roda os testes (gerador do .env + smoke test do app empacotado).
    5. Compila com o ISCC.

.PARAMETER SkipTests
    Não roda os testes (não recomendado).

.PARAMETER Preview
    Gera também um build de PRÉ-VISUALIZAÇÃO (sem exigir administrador e que não
    instala nada), usado para conferir as telas do assistente.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\build.ps1
#>
param(
    [switch]$SkipTests,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---- Versões fixadas (atualize junto com o SHA-256) -------------------------
$NodeVersion   = '24.21.0'
$NodeZipSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$WinSWVersion  = '2.12.0'
$WinSWSha256   = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f'
$InnoVersion   = '6.7.3'
$InnoSha256    = '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'

# Arquivos/pastas da aplicação que vão para o instalador (somente os versionados).
$AppPaths = @('server.js', 'package.json', 'package-lock.json', 'src', 'public', 'bin', 'README.md', '.env.example')

$Here  = $PSScriptRoot
$Repo  = Split-Path $Here -Parent
$Cache = Join-Path $Here '.cache'
$Build = Join-Path $Here 'build'
$App   = Join-Path $Build 'app'
$Dist  = Join-Path $Here 'dist'

function Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Invoke-Checked([string]$Exe, [string[]]$Arguments, [string]$What) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What falhou (código $LASTEXITCODE)." }
}

function Get-VerifiedDownload([string]$Url, [string]$File, [string]$Sha256) {
    if (Test-Path $File) {
        if ((Get-FileHash $File -Algorithm SHA256).Hash -eq $Sha256) { return }
        Remove-Item $File -Force
    }
    Write-Host "    baixando $Url"
    Invoke-WebRequest -Uri $Url -OutFile "$File.part" -UseBasicParsing
    $actual = (Get-FileHash "$File.part" -Algorithm SHA256).Hash
    if ($actual -ne $Sha256) {
        Remove-Item "$File.part" -Force
        throw "SHA-256 inesperado para $Url`n  esperado: $Sha256`n  obtido:   $actual"
    }
    Move-Item "$File.part" $File -Force
}

function Find-Iscc {
    $candidates = @(
        (Join-Path $Cache 'InnoSetup6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    )
    # A versão mínima (6.3) é conferida pelo próprio OraclePulse.iss na compilação.
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

New-Item -ItemType Directory -Force $Cache, $Dist | Out-Null

# ---- 1. Ferramentas e runtime ----------------------------------------------
Step "Node.js $NodeVersion (portátil), WinSW $WinSWVersion e Inno Setup"
$nodeZip = Join-Path $Cache "node-v$NodeVersion-win-x64.zip"
Get-VerifiedDownload "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $nodeZip $NodeZipSha256
$nodeDir = Join-Path $Cache "node-v$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
    Expand-Archive -Path $nodeZip -DestinationPath $Cache -Force
}
$nodeExe = Join-Path $nodeDir 'node.exe'
$npmCli  = Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js'

$winsw = Join-Path $Cache "WinSW.NET461-$WinSWVersion.exe"
Get-VerifiedDownload "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW.NET461.exe" $winsw $WinSWSha256

$iscc = Find-Iscc
if (-not $iscc) {
    $innoSetup = Join-Path $Cache "innosetup-$InnoVersion.exe"
    $innoTag = 'is-' + ($InnoVersion -replace '\.', '_')
    Get-VerifiedDownload "https://github.com/jrsoftware/issrc/releases/download/$innoTag/innosetup-$InnoVersion.exe" $innoSetup $InnoSha256
    $innoDir = Join-Path $Cache 'InnoSetup6'
    $p = Start-Process -FilePath $innoSetup -Wait -PassThru -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/PORTABLE=1', '/NOICONS', "/DIR=`"$innoDir`"")
    if ($p.ExitCode -ne 0) { throw "Instalação do Inno Setup falhou (código $($p.ExitCode))." }
    $iscc = Find-Iscc
    if (-not $iscc) { throw 'ISCC.exe não encontrado após instalar o Inno Setup.' }
}
Write-Host "    ISCC: $iscc"

# ---- 2. Árvore da aplicação (= pasta instalada) -----------------------------
Step 'Montando installer\build\app a partir dos arquivos do projeto'
if (Test-Path $Build) { Remove-Item $Build -Recurse -Force }
New-Item -ItemType Directory -Force $App | Out-Null

# Versionados + novos ainda não versionados; o que o .gitignore exclui (.env,
# logs, node_modules) nunca entra.
$tracked = @(git -C $Repo ls-files -- @AppPaths)
if ($LASTEXITCODE -ne 0 -or $tracked.Count -eq 0) { throw 'git ls-files falhou (rode dentro do repositório).' }
$untracked = @(git -C $Repo ls-files --others --exclude-standard -- @AppPaths)
foreach ($rel in ($tracked + $untracked)) {
    $src = Join-Path $Repo $rel
    if (-not (Test-Path $src -PathType Leaf)) { continue }  # removido do working tree
    $dst = Join-Path $App $rel
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    Copy-Item $src $dst -Force
}
if ($untracked.Count -gt 0) {
    Write-Warning ("Arquivos novos (ainda não versionados) incluídos no instalador — lembre de fazer git add:`n  " + ($untracked -join "`n  "))
}
$dirty = @(git -C $Repo status --porcelain -- @AppPaths)
if ($dirty.Count -gt 0) {
    Write-Warning ("Há alterações não commitadas incluídas no instalador:`n  " + ($dirty -join "`n  "))
}

$version = (Get-Content (Join-Path $App 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Versão inválida no package.json: $version" }

Step "npm ci --omit=dev (Node $NodeVersion empacotado)"
Push-Location $App
try {
    Invoke-Checked $nodeExe @($npmCli, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error') 'npm ci'
} finally {
    Pop-Location
}
$oraBinary = Join-Path $App 'node_modules\oracledb\build\Release\oracledb-*-win32-x64.node'
if (-not (Test-Path $oraBinary)) { throw 'Binário win32-x64 do oracledb ausente após o npm ci.' }

# Runtime, serviço e ferramentas, já no lugar definitivo.
New-Item -ItemType Directory -Force (Join-Path $App 'runtime'), (Join-Path $App 'service'), (Join-Path $App 'tools') | Out-Null
Copy-Item $nodeExe (Join-Path $App 'runtime\node.exe')
Copy-Item (Join-Path $nodeDir 'LICENSE') (Join-Path $App 'runtime\LICENSE')
Copy-Item $winsw (Join-Path $App 'service\OraclePulse.exe')
Copy-Item (Join-Path $Here 'support\OraclePulse.xml') (Join-Path $App 'service\OraclePulse.xml')
Copy-Item (Join-Path $Here 'support\configure-env.js') (Join-Path $App 'tools\configure-env.js')

# ---- 3. Testes ------------------------------------------------------------
if (-not $SkipTests) {
    Step 'Testes (gerador do .env + smoke test do app empacotado)'
    $env:OP_APP_DIR = $App
    try {
        # Testes da aplicação (test\) + do instalador (installer\tests), todos sobre a árvore empacotada.
        $testFiles = @(Get-ChildItem (Join-Path $Repo 'test'), (Join-Path $Here 'tests') -Filter '*.test.js' | ForEach-Object FullName)
        Invoke-Checked (Join-Path $App 'runtime\node.exe') (@('--test', '--test-concurrency=1') + $testFiles) 'Testes'
    } finally {
        Remove-Item Env:\OP_APP_DIR -ErrorAction SilentlyContinue
    }
}

# Nada gerado em tempo de execução pode ir para o pacote.
foreach ($leak in @('.env', 'logs')) {
    if (Test-Path (Join-Path $App $leak)) { throw "build\app contém '$leak' — não pode ir para o instalador." }
}

# ---- 4. Compilação --------------------------------------------------------
Step "Compilando o instalador (versão $version)"
$isccArgs = @("/DAppVersion=$version", "/DBuildDir=$Build", '/Qp', (Join-Path $Here 'OraclePulse.iss'))
Invoke-Checked $iscc $isccArgs 'ISCC'
$setup = Join-Path $Dist "OraclePulse-Setup-$version.exe"
if ($Preview) {
    Invoke-Checked $iscc (@('/DPREVIEW') + $isccArgs) 'ISCC (preview)'
}

$hash = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Step "Pronto: $setup ($sizeMb MB)"
Write-Host "    SHA-256: $hash"
