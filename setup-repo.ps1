#!/usr/bin/env pwsh

# is nvm installed?
if (-not (Get-Command nvm -ErrorAction SilentlyContinue)) {
	Write-Output "nvm could not be found"
	exit
}

# is node v12 installed?
$nvmList = nvm list
if ($nvmList -notmatch "v12") {
	Write-Output "node is not v12"
	exit
}

git pull --recurse-submodules

# node_modules?
if (-Not (Test-Path -Path "node_modules")) {
	npm install
}

npm run build

if (-Not (Test-Path -Path "start-bots.ps1")) {
	Copy-Item -Path "start-bots.ps1.example" -Destination "start-bots.ps1"
	Write-Output "start-bots.ps1 created - please run the following to start 6 bots:"
	Write-Output ".\start-bots.ps1 -ServerIp \"127.0.0.1\" -NumBots 6"
}
