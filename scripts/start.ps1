# SkyNetFactory Start (Windows)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$scriptDir\start.js" @args
