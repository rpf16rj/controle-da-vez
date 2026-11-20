# Starts the local agent (chiaki -> WebRTC -> virtual controller).
# Requires: chiaki-ng installed, ViGEm Bus installed, PS5 registered in chiaki.
$env:AGENT_HOST = '0.0.0.0'
$env:AGENT_PORT = '3001'
$env:AGENT_TOKEN = '<AGENT_TOKEN>'      # must match the web server's AGENT_TOKEN
$env:STUN_URLS = 'stun:stun.l.google.com:19302'
$env:TURN_URL = 'turn:<TURN_HOST>:3478'
$env:TURN_USER = '<TURN_USER>'
$env:TURN_PASS = '<TURN_PASSWORD>'
$env:PS5_HOST = '<PS5_LAN_IP>'          # PS5 IP on your LAN
$env:PS5_NICKNAME = 'PS5-XXX'           # nickname you registered in chiaki
$env:PS5_REGISTKEY = '<PS5_REGISTKEY>'  # regist key from chiaki's registration (keep private)
# $env:CHIAKI_EXE = 'C:\chiaki-ng-Win\chiaki.exe'
Set-Location $PSScriptRoot
& "$PSScriptRoot\.venv\Scripts\python.exe" "$PSScriptRoot\agent.py"
Read-Host 'Agent exited. Enter to close'
