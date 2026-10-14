<#
.SYNOPSIS
    Gera public\logo-wide.png a partir de public\logo.png: recorta só o desenho
    (sem a margem branca de 1024x1024) e torna o fundo transparente, removendo o
    ruído quase-branco da imagem original (aparecia como manchas ao redor do
    logo em algumas telas/zoom).
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class LogoClean {
    // Branco -> transparente ("color to alpha"), com limiar para zerar o ruído.
    public static Bitmap Clean(Bitmap src, int noiseFloor, int pad) {
        int w = src.Width, h = src.Height;
        var full = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        // Destino explícito: DrawImageUnscaled respeitaria o DPI gravado no PNG.
        using (var g = Graphics.FromImage(full)) { g.Clear(Color.White); g.DrawImage(src, new Rectangle(0, 0, w, h)); }
        var rect = new Rectangle(0, 0, w, h);
        var data = full.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        var px = new byte[data.Stride * h];
        Marshal.Copy(data.Scan0, px, 0, px.Length);
        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            int i = y * data.Stride + x * 4;
            int b = px[i], g = px[i + 1], r = px[i + 2];
            int mn = Math.Min(r, Math.Min(g, b));
            if (mn >= noiseFloor) { px[i] = px[i + 1] = px[i + 2] = 255; px[i + 3] = 0; continue; }
            double a = (255.0 - mn) / 255.0;                 // quanto o pixel se afasta do branco
            Func<int, byte> un = c => (byte)Math.Max(0, Math.Min(255, Math.Round((c - 255.0 * (1 - a)) / a)));
            px[i] = un(b); px[i + 1] = un(g); px[i + 2] = un(r); px[i + 3] = (byte)Math.Round(a * 255);
            if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        Marshal.Copy(px, 0, data.Scan0, px.Length);
        full.UnlockBits(data);
        var crop = new Rectangle(Math.Max(0, minX - pad), Math.Max(0, minY - pad), 0, 0);
        crop.Width = Math.Min(w, maxX + pad + 1) - crop.X;
        crop.Height = Math.Min(h, maxY + pad + 1) - crop.Y;
        var outBmp = full.Clone(crop, PixelFormat.Format32bppArgb);
        full.Dispose();
        return outBmp;
    }
}
'@
$public = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'public'
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $public 'logo.png'))
$out = [LogoClean]::Clean($src, 243, 8)
$src.Dispose()
$out.Save((Join-Path $public 'logo-wide.png'), [System.Drawing.Imaging.ImageFormat]::Png)
"logo-wide.png: $($out.Width)x$($out.Height)"
$out.Dispose()
