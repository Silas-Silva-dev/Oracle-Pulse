<#
.SYNOPSIS
    Teste ponta a ponta do instalador (EXIGE ADMINISTRADOR): instala de verdade
    o serviço numa pasta de teste, verifica, atualiza, reconfigura, testa uma
    entrada inválida e desinstala, deixando a máquina limpa.

.EXAMPLE
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File installer\tests\e2e-install.ps1 -Setup <exe> -Report <arquivo>'
#>
param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [Parameter(Mandatory = $true)][string]$Report,
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
function Save { $results | Set-Content -Path $Report -Encoding UTF8 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Log 'ERRO: execute como administrador.'; Save; exit 2 }
if (Get-Service OraclePulse -ErrorAction SilentlyContinue) { Log 'ERRO: já existe um serviço OraclePulse nesta máquina; teste abortado para não interferir.'; Save; exit 2 }

$Dir = Join-Path $env:ProgramFiles 'OraclePulse E2E Teste'
$LogDir = Join-Path $env:TEMP ('op-e2e-logs-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Get-FreePort {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0); $l.Start()
    $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}
# Senha de instalação do dia (gate do instalador). Calcula via install-key.js se não informada.
if (-not $InstallPwd) {
    $keyJs = Join-Path $PSScriptRoot '..\generator\install-key.js'
    $InstallPwd = (& node -e "process.stdout.write(require(process.argv[1]).today())" $keyJs) 2>$null
    if (-not $InstallPwd) { Log 'ERRO: não foi possível calcular a senha de instalação (node/install-key.js). Passe -InstallPwd.'; Save; exit 2 }
}
Log "  senha de instalação do dia: $InstallPwd"

function Run-Setup([string]$Name, [string]$ExtraArgs, [string]$Pwd = $InstallPwd) {
    $log = Join-Path $LogDir "$Name.log"
    $argLine = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /INSTALLPWD=`"$Pwd`" /LOG=`"$log`" /DIR=`"$Dir`" $ExtraArgs"
    $t0 = Get-Date
    $p = Start-Process -FilePath $Setup -ArgumentList $argLine -Wait -PassThru
    Log ("  setup '{0}' terminou com código {1} em {2:n0}s (log: {3})" -f $Name, $p.ExitCode, ((Get-Date) - $t0).TotalSeconds, $log)
    return $p.ExitCode
}
function Run-Uninstall([string]$Name, [string]$ExtraArgs = '') {
    $unins = Get-ChildItem $Dir -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $unins) { Log '  desinstalador não encontrado'; return -1 }
    $log = Join-Path $LogDir "$Name.log"
    $p = Start-Process -FilePath $unins.FullName -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$log`" $ExtraArgs" -Wait -PassThru
    # O desinstalador se copia para o TEMP e termina antes: aguarda a remoção da pasta/serviço.
    for ($i = 0; $i -lt 60 -and (Test-Path $unins.FullName); $i++) { Start-Sleep 1 }
    Log "  desinstalação '$Name' código $($p.ExitCode) (log: $log)"
    return $p.ExitCode
}
function Http([string]$Method, [string]$Url, $Body = $null, [string]$Token = '') {
    $h = @{}; if ($Token) { $h.Authorization = "Bearer $Token" }
    try {
        if ($Body) { $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $h -Body ($Body | ConvertTo-Json) -ContentType 'application/json' -UseBasicParsing -TimeoutSec 10 }
        else { $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $h -UseBasicParsing -TimeoutSec 10 }
        return @{ Status = [int]$r.StatusCode; Json = ($(try { $r.Content | ConvertFrom-Json } catch { $null })); Text = $r.Content }
    } catch {
        $resp = $_.Exception.Response
        if ($resp) { return @{ Status = [int]$resp.StatusCode; Json = $null; Text = '' } }
        return @{ Status = 0; Json = $null; Text = $_.Exception.Message }
    }
}
function Login([int]$Port, [string]$User, [string]$Pass) {
    $r = Http 'POST' "http://127.0.0.1:$Port/api/login" @{ user = $User; password = $Pass }
    if ($r.Status -eq 200 -and $r.Json) { return $r.Json } else { return $null }
}
function Wait-Http([int]$Port, [int]$Seconds = 30) {
    for ($i = 0; $i -lt $Seconds; $i++) { if ((Http 'GET' "http://127.0.0.1:$Port/").Status -eq 200) { return $true }; Start-Sleep 1 }
    return $false
}
function Env-Map {
    $m = @{}
    foreach ($line in Get-Content (Join-Path $Dir '.env')) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $m[$Matches[1]] = $Matches[2] }
    }
    return $m
}
function Status-Map {
    $m = @{}
    $f = Join-Path $Dir 'logs\install-status.txt'
    if (Test-Path $f) { foreach ($l in Get-Content $f) { if ($l -match '^(\w+)=(.*)$') { $m[$Matches[1]] = $Matches[2] } } }
    return $m
}
function Fw-Port {
    $rule = Get-NetFirewallRule -DisplayName 'Oracle Pulse' -ErrorAction SilentlyContinue
    if (-not $rule) { return $null }
    return (($rule | Get-NetFirewallPortFilter).LocalPort -join ',')
}
function Node-Pids {
    $node = Join-Path $Dir 'runtime\node.exe'
    @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $node } | ForEach-Object Id)
}
function Check-Acl([string]$File) {
    $acl = Get-Acl $File
    $sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
    $okSids = ($sids -join ',') -eq ((@('S-1-5-18', 'S-1-5-32-544') | Sort-Object) -join ',')
    Check "ACL de $(Split-Path $File -Leaf) só Administradores+SYSTEM" ($okSids -and $acl.AreAccessRulesProtected) "(SIDs: $($sids -join ', '))"
}

try {
    $port0 = Get-FreePort
    Log '== Fase 0: senha de instalação incorreta deve ser RECUSADA'
    $codeBad = Run-Setup 'fase0-senha-errada' "/PORT=$port0 /DEMO=1 /AUTHPASSWORD=E2e#Senha1" 'SENHA-ERRADA'
    Check 'setup com senha errada retornou != 0' ($codeBad -ne 0) "(código $codeBad)"
    Check 'senha errada NÃO instalou o serviço' ($null -eq (Get-Service OraclePulse -ErrorAction SilentlyContinue))

    $port1 = Get-FreePort
    Log "== Fase 1: instalação nova (silenciosa, DEMO, porta $port1, pasta com espaços)"
    $code = Run-Setup 'fase1-instalacao' "/PORT=$port1 /DEMO=1 /AUTHPASSWORD=E2e#Senha1 /VIEWERUSER=leitor /VIEWERPASSWORD=Leitura#1 /TASKS=`"firewall`""
    Check 'setup retornou 0' ($code -eq 0)
    $svc = Get-Service OraclePulse -ErrorAction SilentlyContinue
    Check 'serviço OraclePulse existe' ($null -ne $svc)
    Check 'serviço em execução' ($svc -and $svc.Status -eq 'Running') "($($svc.Status))"
    $reg = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\OraclePulse' -ErrorAction SilentlyContinue
    Check 'início automático (atrasado)' ($reg -and $reg.Start -eq 2 -and $reg.DelayedAutostart -eq 1) "(Start=$($reg.Start) Delayed=$($reg.DelayedAutostart))"
    Check 'ImagePath aponta para a pasta instalada' ($reg -and $reg.ImagePath -like "*$Dir\service\OraclePulse.exe*") "($($reg.ImagePath))"
    Check 'conta do serviço = LocalSystem' ($reg -and $reg.ObjectName -eq 'LocalSystem') "($($reg.ObjectName))"
    $qf = (& sc.exe qfailure OraclePulse) -join ' '
    Check 'recuperação: reinicia em caso de falha' ($qf -match 'RESTART|REINICIAR') $qf
    Check 'painel responde HTTP 200' (Wait-Http $port1)
    $s = Login $port1 'DBA' 'E2e#Senha1'
    Check 'login DBA' ($s -and $s.role -eq 'dba')
    $v = Login $port1 'leitor' 'Leitura#1'
    Check 'login somente leitura' ($v -and $v.role -eq 'viewer')
    Check 'login com senha errada recusado' ($null -eq (Login $port1 'DBA' 'errada'))
    $d = Http 'GET' "http://127.0.0.1:$port1/api/dashboard" -Token $s.token
    Check 'API /dashboard (DEMO)' ($d.Status -eq 200 -and $d.Json.success)
    Check-Acl (Join-Path $Dir '.env')
    Check 'regra de firewall com a porta' ((Fw-Port) -eq "$port1") "(porta: $(Fw-Port))"
    $st = Status-Map
    Check 'install-status: config/serviço/http ok, banco=demo' ($st.config_ok -eq '1' -and $st.servico_ok -eq '1' -and $st.http_ok -eq '1' -and $st.banco -eq 'demo') ($st | ConvertTo-Json -Compress)
    $out = Get-Content (Join-Path $Dir 'logs\OraclePulse.out.log') -Raw -ErrorAction SilentlyContinue
    Check 'log do serviço registra o painel no ar' ($out -match "rodando em http://localhost:$port1")
    Check 'atalho no Menu Iniciar' (Test-Path (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Oracle Pulse\Abrir o Oracle Pulse.lnk'))
    $url = Get-Content (Join-Path $Dir 'Abrir Oracle Pulse.url') -Raw
    Check 'atalho .url com a porta certa' ($url -match "URL=http://localhost:$port1/")
    $uninst = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like '*8F3C2A51-6B7D-4E0A-9C1E-5D2B7A4F9E31*' }
    Check 'registrado em Programas e Recursos' ($null -ne $uninst)
    Check 'nenhum arquivo temporário de entrada sobrou' (-not (Test-Path (Join-Path $Dir '.env.tmp-*')))
    $envHash1 = (Get-FileHash (Join-Path $Dir '.env')).Hash
    $pids1 = Node-Pids

    Log "== Fase 2: atualização mantendo a configuração (silenciosa, sem parâmetros)"
    $code = Run-Setup 'fase2-atualizacao' ''
    Check 'setup retornou 0' ($code -eq 0)
    Check '.env intocado' ((Get-FileHash (Join-Path $Dir '.env')).Hash -eq $envHash1)
    Check 'nenhum backup criado' (-not (Get-ChildItem $Dir -Filter '.env.bak-*' -Force))
    Check 'serviço em execução' ((Get-Service OraclePulse).Status -eq 'Running')
    Check 'processo Node reiniciado' ((Node-Pids).Count -eq 1 -and -not ($pids1 -contains (Node-Pids)[0])) "(antes: $pids1, depois: $(Node-Pids))"
    Check 'painel responde' (Wait-Http $port1)
    Check 'login com a senha antiga' ($null -ne (Login $port1 'DBA' 'E2e#Senha1'))
    Check-Acl (Join-Path $Dir '.env')

    $port2 = Get-FreePort
    $deadPort = Get-FreePort
    Log "== Fase 3: reconfiguração (sai do DEMO; banco inacessível; porta $port2; senha do painel mantida)"
    $code = Run-Setup 'fase3-reconfig' "/KEEPCONFIG=0 /PORT=$port2 /DEMO=0 /DBHOST=127.0.0.1 /DBPORT=$deadPort /DBSERVICE=orcl /DBUSER=monitor /DBPASSWORD=Db#Senha'1 /TASKS=`"firewall`""
    Check 'setup retornou 0' ($code -eq 0)
    $e = Env-Map
    Check '.env com a nova porta e LIVE' ($e.PORT -eq "$port2" -and $e.DEMO_MODE -eq 'false') "(PORT=$($e.PORT) DEMO=$($e.DEMO_MODE))"
    Check 'senha do banco gravada exatamente' ($e.DB_PASSWORD -in @("Db#Senha'1", "`"Db#Senha'1`"")) "($($e.DB_PASSWORD))"
    $bak = Get-ChildItem $Dir -Filter '.env.bak-*' -Force
    Check 'backup do .env anterior criado' ($bak.Count -eq 1)
    if ($bak) { Check-Acl $bak[0].FullName }
    Check-Acl (Join-Path $Dir '.env')
    Check 'regra de firewall atualizada' ((Fw-Port) -eq "$port2") "(porta: $(Fw-Port))"
    Check 'painel responde na nova porta' (Wait-Http $port2)
    Check 'porta antiga liberada' ((Http 'GET' "http://127.0.0.1:$port1/").Status -eq 0)
    $s = Login $port2 'DBA' 'E2e#Senha1'
    Check 'login com a senha mantida' ($null -ne $s)
    $h = Http 'GET' "http://127.0.0.1:$port2/api/health" -Token $s.token
    Check '/api/health responde erro tratado (banco inacessível)' ($h.Status -eq 500)
    $st = Status-Map
    Check 'install-status: banco=falha (teste de conexão rodou)' ($st.banco -eq 'falha' -and $st.http_ok -eq '1') ($st | ConvertTo-Json -Compress)
    Start-Sleep 3
    Check 'serviço segue rodando com o banco fora' ((Get-Service OraclePulse).Status -eq 'Running')
    $envHash3 = (Get-FileHash (Join-Path $Dir '.env')).Hash

    Log '== Fase 4: entrada inválida (porta 99999) deve abortar SEM alterar nada'
    $code = Run-Setup 'fase4-invalida' '/KEEPCONFIG=0 /PORT=99999'
    Check 'setup recusou (código diferente de 0)' ($code -ne 0) "(código $code)"
    Check '.env inalterado' ((Get-FileHash (Join-Path $Dir '.env')).Hash -eq $envHash3)
    Check 'serviço continua rodando' ((Get-Service OraclePulse).Status -eq 'Running')
    Check 'painel continua respondendo' (Wait-Http $port2 5)

    Log '== Fase 5: desinstalação (mantém .env e logs por padrão)'
    Run-Uninstall 'fase5-desinstalacao' | Out-Null
    Start-Sleep 2
    Check 'serviço removido' ($null -eq (Get-Service OraclePulse -ErrorAction SilentlyContinue))
    Check 'regra de firewall removida' ($null -eq (Fw-Port))
    Check 'nenhum node.exe da instalação rodando' ((Node-Pids).Count -eq 0)
    Check 'programa removido (runtime, node_modules, src)' (-not (Test-Path (Join-Path $Dir 'runtime')) -and -not (Test-Path (Join-Path $Dir 'node_modules')) -and -not (Test-Path (Join-Path $Dir 'src')))
    Check '.env e logs preservados' ((Test-Path (Join-Path $Dir '.env')) -and (Test-Path (Join-Path $Dir 'logs\audit.log')))
    Check 'removido de Programas e Recursos' ($null -eq (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { $_.PSChildName -like '*8F3C2A51*' }))

    Log '== Fase 6: reinstalação reaproveitando o .env, depois desinstalação completa (/REMOVEDATA=1)'
    $code = Run-Setup 'fase6-reinstalacao' ''
    Check 'setup retornou 0' ($code -eq 0)
    Check 'serviço em execução' ((Get-Service OraclePulse -ErrorAction SilentlyContinue).Status -eq 'Running')
    Check 'painel responde com a config preservada' (Wait-Http $port2)
    Run-Uninstall 'fase6-desinstalacao-total' '/REMOVEDATA=1' | Out-Null
    Start-Sleep 2
    Check 'serviço removido' ($null -eq (Get-Service OraclePulse -ErrorAction SilentlyContinue))
    Check 'pasta removida por completo' (-not (Test-Path $Dir)) "($(if (Test-Path $Dir) { (Get-ChildItem $Dir -Recurse -Force | ForEach-Object FullName) -join '; ' }))"
} catch {
    $failures++
    Log "ERRO INESPERADO: $($_.Exception.Message) @ $($_.InvocationInfo.PositionMessage)"
} finally {
    # Limpeza garantida
    if (Get-Service OraclePulse -ErrorAction SilentlyContinue) {
        Log '  (limpeza) removendo serviço remanescente'
        & sc.exe stop OraclePulse | Out-Null; Start-Sleep 3; & sc.exe delete OraclePulse | Out-Null
    }
    foreach ($id in (Node-Pids)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Get-NetFirewallRule -DisplayName 'Oracle Pulse' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (Test-Path $Dir) {
        $unins = Get-ChildItem $Dir -Filter 'unins*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($unins) { Start-Process $unins.FullName -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /REMOVEDATA=1' -Wait; Start-Sleep 5 }
        if (Test-Path $Dir) { Log "  (limpeza) pasta de teste remanescente: $Dir" }
    }
    Log ''
    Log ("RESULTADO: {0}" -f $(if ($failures -eq 0) { 'TODOS OS TESTES PASSARAM' } else { "$failures FALHA(S)" }))
    Log "Logs do instalador: $LogDir"
    Save
}
exit $(if ($failures -eq 0) { 0 } else { 1 })
