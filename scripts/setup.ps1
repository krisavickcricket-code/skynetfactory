# SkyNetFactory Setup (Windows)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$scriptDir\setup.js" @args
