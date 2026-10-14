<#
.SYNOPSIS
    Teste da instalação INTERATIVA real (EXIGE ADMINISTRADOR): percorre o
    assistente até a tela "Concluir" capturando as telas (incluindo o aviso de
    falha de conexão com o banco), confere o serviço e desinstala tudo.
#>
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Report,
    [Parameter(Mandatory = $true)][string]$ShotsDir,
    [string]$InstallPwd = ''   # senha do dia; vazio = calcula via install-key.js
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$results = New-Object System.Collections.Generic.List[string]
$failures = 0
function Log([string]$m) { $results.Add($m); Write-Host $m }
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Log "  [OK]    $name" } else { $script:failures++; Log "  [FALHA] $name $detail" }
}
function Get-FreePort { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); $p }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Log 'ERRO: execute como administrador.'; $results | Set-Content $Report -Encoding UTF8; exit 2 }
if (Get-Service OraclePulse -ErrorAction SilentlyContinue) { Log 'ERRO: já existe um serviço OraclePulse.'; $results | Set-Content $Report -Encoding UTF8; exit 2 }

$Dir = Join-Path $env:ProgramFiles 'OraclePulse E2E GUI'
$port = Get-FreePort
$dead = Get-FreePort
$setupLog = Join-Path $ShotsDir 'gui-setup.log'
if (-not $InstallPwd) {
    $keyJs = Join-Path $PSScriptRoot '..\generator\install-key.js'
    $InstallPwd = (& node -e "process.stdout.write(require(process.argv[1]).today())" $keyJs) 2>$null
    if (-not $InstallPwd) { Log 'ERRO: não foi possível calcular a senha de instalação; passe -InstallPwd.'; $results | Set-Content $Report -Encoding UTF8; exit 2 }
}
try {
    Log "== Instalação interativa (porta $port, banco inacessível em 127.0.0.1:$dead)"
    # /INSTALLPWD preenche a página de senha; o driver só clica em Avançar.
    $argLine = "/INSTALLPWD=`"$InstallPwd`" /LOG=`"$setupLog`" /DIR=`"$Dir`" /PORT=$port /DBHOST=127.0.0.1 /DBPORT=$dead /DBSERVICE=orcl /DBUSER=monitor /DBPASSWORD=Db#Senha1 /AUTHPASSWORD=Gui#Senha1"
    $driver = Join-Path $PSScriptRoot 'wizard-screens.ps1'
    $out = & $driver -OutDir $ShotsDir -Prefix 'gui' -Setup $Setup -SetupArgs $argLine -FollowInstall -MaxPages 80
    $out | ForEach-Object { Log ("  " + ($_ -replace '^PAGINA \d+ -> \S+ :: ', 'PAGINA: ').Substring(0, [Math]::Min(240, ($_ -replace '^PAGINA \d+ -> \S+ :: ', 'PAGINA: ').Length))) }
    Check 'assistente chegou à tela Concluir' (($out -join "`n") -match 'Tela final')
    Check 'aviso de falha do banco exibido' (($out -join "`n") -match 'DIALOGO.*teste de conexão com o Oracle falhou')
    Check 'tela final com o endereço do painel' (($out -join "`n") -match "Acesse:\s+http://[^:]+:$port/")
    Check 'serviço em execução' ((Get-Service OraclePulse -ErrorAction SilentlyContinue).Status -eq 'Running')
    $ok = $false; for ($i = 0; $i -lt 20 -and -not $ok; $i++) { try { $ok = (Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { Start-Sleep 1 } }
    Check 'painel responde' $ok
    $logText = Get-Content $setupLog -Raw -ErrorAction SilentlyContinue
    Check 'log do setup sem exceções do script' (-not ($logText -match 'Runtime error|Exception message|Internal error'))
} catch {
    $failures++; Log "ERRO INESPERADO: $($_.Exception.Message)"
} finally {
    Log '== Desinstalação completa'
    $unins = Get-ChildItem $Dir -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($unins) {
        Start-Process $unins.FullName -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /REMOVEDATA=1' -Wait
        for ($i = 0; $i -lt 60 -and (Test-Path $unins.FullName); $i++) { Start-Sleep 1 }
    }
    Start-Sleep 2
    if (Get-Service OraclePulse -ErrorAction SilentlyContinue) { & sc.exe stop OraclePulse | Out-Null; Start-Sleep 3; & sc.exe delete OraclePulse | Out-Null }
    Get-NetFirewallRule -DisplayName 'Oracle Pulse' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Check 'serviço removido' ($null -eq (Get-Service OraclePulse -ErrorAction SilentlyContinue))
    Check 'pasta removida' (-not (Test-Path $Dir))
    Log ("RESULTADO GUI: {0}" -f $(if ($failures -eq 0) { 'TODOS OS TESTES PASSARAM' } else { "$failures FALHA(S)" }))
    $results | Set-Content $Report -Encoding UTF8
}
exit $(if ($failures -eq 0) { 0 } else { 1 })
