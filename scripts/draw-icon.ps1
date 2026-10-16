# Draws assets/icon-source.png, Desktop HUD's public icon (1024×1024 RGBA).
# The palette and line style follow the owner's brand system: midnight navy
# with a cobalt cel-shaded facet, a thick near-black outline inside a
# light-grey keyline, and one crimson focal point. The four brackets are the
# HUD's own corner motif; the dot is "now".
# Run (Windows PowerShell): powershell -File scripts/draw-icon.ps1
# Then `node scripts/make-icons.mjs` turns it into build/icon.png and the tray icon.
param([string]$Out = (Join-Path $PSScriptRoot '..\assets\icon-source.png'))
Add-Type -AssemblyName System.Drawing

$S = 1024
$bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.PixelOffsetMode = 'HighQuality'
$g.Clear([System.Drawing.Color]::Transparent)

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $p
}
function Tile([float]$inset, [float]$r) { RoundRect $inset $inset ($S - 2 * $inset) ($S - 2 * $inset) $r }

$ink = C '#040D1A'; $navy = C '#0C2048'; $cobalt = C '#295E97'
$crimson = C '#C7232D'; $vivid = C '#EC3139'; $keyline = C '#B9BCC0'

# Keyline, outline, tile.
$g.FillPath((New-Object System.Drawing.SolidBrush $keyline), (Tile 40 236))
$g.FillPath((New-Object System.Drawing.SolidBrush $ink), (Tile 58 218))
$tile = Tile 92 184
$g.FillPath((New-Object System.Drawing.SolidBrush $navy), $tile)

# Cel-shaded facet: the lower-right of the tile in cobalt.
$g.SetClip($tile)
$facet = New-Object System.Drawing.Drawing2D.GraphicsPath
$facet.AddPolygon([System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF 1024, 300),
  (New-Object System.Drawing.PointF 1024, 1024),
  (New-Object System.Drawing.PointF 300, 1024)))
$g.FillPath((New-Object System.Drawing.SolidBrush $cobalt), $facet)
$g.ResetClip()

# HUD corner brackets: near-black underlay, light-grey on top.
$arm = 168; $in = 214
function Bracket($pen, [float]$cx, [float]$cy, [int]$sx, [int]$sy) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddLines([System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ($cx + $sx * $arm), $cy),
    (New-Object System.Drawing.PointF $cx, $cy),
    (New-Object System.Drawing.PointF $cx, ($cy + $sy * $arm))))
  $g.DrawPath($pen, $p)
}
$under = New-Object System.Drawing.Pen $ink, 92
$over = New-Object System.Drawing.Pen $keyline, 56
foreach ($pen in $under, $over) {
  $pen.StartCap = 'Square'; $pen.EndCap = 'Square'; $pen.LineJoin = 'Miter'
  Bracket $pen $in $in 1 1
  Bracket $pen ($S - $in) $in -1 1
  Bracket $pen $in ($S - $in) 1 -1
  Bracket $pen ($S - $in) ($S - $in) -1 -1
}

# "Now": a clock face with one crimson hand (a plain red dot in brackets read as
# a screen recorder). Outlined in near-black like everything else.
$cx = 512; $cy = 512
$g.FillEllipse((New-Object System.Drawing.SolidBrush $ink), ($cx - 168), ($cy - 168), 336, 336)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $keyline), ($cx - 140), ($cy - 140), 280, 280)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $navy), ($cx - 100), ($cy - 100), 200, 200)
$handUnder = New-Object System.Drawing.Pen $ink, 64
$hand = New-Object System.Drawing.Pen $vivid, 36
foreach ($p in $handUnder, $hand) { $p.StartCap = 'Round'; $p.EndCap = 'Round' }
$tipX = $cx + 62; $tipY = $cy - 72   # about one o'clock
$g.DrawLine($handUnder, $cx, $cy, $tipX, $tipY)
$g.DrawLine($hand, $cx, $cy, $tipX, $tipY)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $ink), ($cx - 40), ($cy - 40), 80, 80)
$g.FillEllipse((New-Object System.Drawing.SolidBrush $crimson), ($cx - 26), ($cy - 26), 52, 52)

$g.Dispose()
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"wrote $Out"
