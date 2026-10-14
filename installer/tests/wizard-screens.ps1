<#
.SYNOPSIS
    Percorre o assistente do instalador e salva uma captura de cada página, para
    conferir o layout. Com o build PREVIEW (padrão) não instala nada; com
    -FollowInstall e o instalador real (como Administrador, ver e2e-gui.ps1)
    acompanha a instalação até a tela "Concluir".

.DESCRIPTION
    Uso de desenvolvimento:  installer\build.ps1 -Preview  e depois
      powershell -ExecutionPolicy Bypass -File installer\tests\wizard-screens.ps1 -OutDir <pasta>
    Os cliques são enviados por mensagem (BM_CLICK) à janela do instalador, sem
    usar o teclado nem roubar o foco de outras janelas.
#>
param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$Setup = '',
    [string]$SetupArgs = "",
    [string]$Prefix = 'tela',
    [int]$MaxPages = 14,
    [string]$StopAtCaption = '',
    # Acompanha uma instalação REAL até a tela "Concluir" (responde OK às mensagens).
    [switch]$FollowInstall
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
if (-not $Setup) {
    # Mesma versão que o build.ps1 usa (package.json).
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    $version = (Get-Content (Join-Path $here '..\..\package.json') -Raw | ConvertFrom-Json).version
    $Setup = Join-Path $here "..\dist\OraclePulse-Setup-$version-PREVIEW.exe"
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class Wiz {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    public static string Txt(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }

    public static List<IntPtr> TopWindows(HashSet<int> pids) {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => { int pid; GetWindowThreadProcessId(h, out pid);
            if (pids.Contains(pid) && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
    public static List<IntPtr> Children(IntPtr p) {
        var list = new List<IntPtr>();
        EnumChildWindows(p, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
    public static IntPtr FindButton(IntPtr p, string[] texts) {
        foreach (var h in Children(p)) {
            if (!IsWindowVisible(h) || !IsWindowEnabled(h)) continue;
            var c = Cls(h); if (c.IndexOf("Button", StringComparison.OrdinalIgnoreCase) < 0) continue;
            var t = Txt(h).Replace("&", "");
            foreach (var x in texts) if (t.StartsWith(x, StringComparison.OrdinalIgnoreCase)) return h;
        }
        return IntPtr.Zero;
    }
    public static void Click(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); } // BM_CLICK
    public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE
    public static void Shot(IntPtr h, string file) {
        RECT r; GetWindowRect(h, out r);
        int w = r.R - r.L, hh = r.B - r.T;
        if (w <= 0 || hh <= 0) return;  // janela auxiliar sem tamanho
        using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc(); PrintWindow(h, hdc, 2); g.ReleaseHdc(hdc);
            bmp.Save(file, ImageFormat.Png);
        }
    }
    public static string AllText(IntPtr p) {
        var sb = new StringBuilder();
        foreach (var h in Children(p)) if (IsWindowVisible(h)) { var t = Txt(h); if (t.Length > 0) sb.Append(t.Replace("\r", " ").Replace("\n", " ")).Append(" | "); }
        return sb.ToString();
    }
}
'@

function Get-SetupPids([int]$RootPid) {
    $pids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$pids.Add($RootPid)
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($p in $all) { if ($pids.Contains([int]$p.ParentProcessId) -and $pids.Add([int]$p.ProcessId)) { $changed = $true } }
    }
    return , $pids
}

$proc = if ($SetupArgs) { Start-Process -FilePath $Setup -ArgumentList $SetupArgs -PassThru } else { Start-Process -FilePath $Setup -PassThru }
$log = @()
try {
    $wizard = [IntPtr]::Zero
    for ($i = 0; $i -lt 60 -and $wizard -eq [IntPtr]::Zero; $i++) {
        Start-Sleep -Milliseconds 500
        $pids = Get-SetupPids $proc.Id
        foreach ($h in [Wiz]::TopWindows($pids)) { if ([Wiz]::Cls($h) -eq 'TWizardForm') { $wizard = $h } }
    }
    if ($wizard -eq [IntPtr]::Zero) { throw 'Janela do assistente não encontrada.' }

    $lastText = ''
    for ($page = 1; $page -le $MaxPages; $page++) {
        # Espera a página estabilizar (texto igual em duas leituras seguidas).
        $text = ''
        for ($j = 0; $j -lt 40; $j++) {
            Start-Sleep -Milliseconds 400
            $pids = Get-SetupPids $proc.Id
            $dialogs = @([Wiz]::TopWindows($pids) | Where-Object { [Wiz]::Cls($_) -eq '#32770' -or [Wiz]::Cls($_) -like 'TTaskDialog*' })
            if ($dialogs.Count -gt 0) { break }
            $t = [Wiz]::AllText($wizard)
            if ($t -eq $text -and $t -ne $lastText) { break }
            $text = $t
        }
        $pids = Get-SetupPids $proc.Id
        $dialogs = @([Wiz]::TopWindows($pids) | Where-Object { [Wiz]::Cls($_) -eq '#32770' -or [Wiz]::Cls($_) -like 'TTaskDialog*' })
        if ($dialogs.Count -gt 0) {
            foreach ($d in $dialogs) {
                $file = Join-Path $OutDir ('{0}-{1:00}-dialogo.png' -f $Prefix, $page)
                [Wiz]::Shot($d, $file)
                $log += "DIALOGO [$([Wiz]::Cls($d))] $([Wiz]::AllText($d)) -> $file"
                $ok = [Wiz]::FindButton($d, @('OK', 'Não', 'Nao', 'No'))
                if ($ok -ne [IntPtr]::Zero) { [Wiz]::Click($ok) } else { [Wiz]::Close($d) }
            }
            if ($FollowInstall) { continue } else { break }
        }
        $text = [Wiz]::AllText($wizard)
        $next = [Wiz]::FindButton($wizard, @('Avançar', 'Próximo', 'Instalar', 'Next', 'Install'))
        $finish = [Wiz]::FindButton($wizard, @('Concluir', 'Finish'))
        if ($next -ne [IntPtr]::Zero -or $finish -ne [IntPtr]::Zero -or -not $FollowInstall) {
            $lastText = $text
            $file = Join-Path $OutDir ('{0}-{1:00}.png' -f $Prefix, $page)
            [Wiz]::Shot($wizard, $file)
            $log += "PAGINA $page -> $file :: $text"
        }
        if ($StopAtCaption -and $text -like "*$StopAtCaption*") { break }
        if ($finish -ne [IntPtr]::Zero) { $log += 'Tela final (Concluir) alcançada.'; break }
        if ($next -ne [IntPtr]::Zero) { [Wiz]::Click($next); continue }
        if (-not $FollowInstall) { $log += 'Sem botão Avançar/Instalar: fim.'; break }
        # Instalando: sem botões; segue aguardando.
    }
} finally {
    Start-Sleep -Milliseconds 300
    if (-not $proc.HasExited) {
        foreach ($id in (Get-SetupPids $proc.Id)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }
    $log | Set-Content -Encoding UTF8 (Join-Path $OutDir "$Prefix-log.txt")
    $log
}
