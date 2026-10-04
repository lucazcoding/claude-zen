```bat
@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d C:\AI_config\ClaudeZen

:menu
cls

echo ============================================
echo          CLAUDEZEN HYBRID ROUTER
echo ============================================
echo.
echo 1 - AUTO
echo 2 - APInex
echo 3 - Google Gemini
echo 4 - OpenRouter
echo 5 - STATUS
echo 0 - SAIR
echo.

set /p choice=Escolha: 

if "%choice%"=="1" goto auto
if "%choice%"=="2" goto apinex
if "%choice%"=="3" goto gemini
if "%choice%"=="4" goto openrouter
if "%choice%"=="5" goto status
if "%choice%"=="0" goto end

echo.
echo Opcao invalida.
pause
goto menu


:auto
echo.
echo Alterando para AUTO...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$p='C:\AI_config\ClaudeZen\routing-state.json'; [System.IO.File]::WriteAllText($p, '{\"mode\":\"auto\",\"provider\":null}', (New-Object System.Text.UTF8Encoding($false)))"

echo.
echo ============================================
echo Modo AUTO ativado.
echo ============================================
echo.

goto verify


:apinex
echo.
echo Alterando para APInex...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$p='C:\AI_config\ClaudeZen\routing-state.json'; [System.IO.File]::WriteAllText($p, '{\"mode\":\"manual\",\"provider\":\"apinex\"}', (New-Object System.Text.UTF8Encoding($false)))"

echo.
echo ============================================
echo APInex ativado.
echo ============================================
echo.

goto verify


:gemini
echo.
echo Alterando para Google Gemini...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$p='C:\AI_config\ClaudeZen\routing-state.json'; [System.IO.File]::WriteAllText($p, '{\"mode\":\"manual\",\"provider\":\"gemini\"}', (New-Object System.Text.UTF8Encoding($false)))"

echo.
echo ============================================
echo Google Gemini ativado.
echo ============================================
echo.

goto verify


:openrouter
echo.
echo Alterando para OpenRouter...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"$p='C:\AI_config\ClaudeZen\routing-state.json'; [System.IO.File]::WriteAllText($p, '{\"mode\":\"manual\",\"provider\":\"openrouter\"}', (New-Object System.Text.UTF8Encoding($false)))"

echo.
echo ============================================
echo OpenRouter ativado.
echo ============================================
echo.

goto verify


:verify
echo.
echo Verificando estado atual...
echo.

if not exist "C:\AI_config\ClaudeZen\routing-state.json" (
    echo ERRO: routing-state.json nao foi criado.
    echo.
    pause
    goto menu
)

type "C:\AI_config\ClaudeZen\routing-state.json"

echo.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"try { $r=Invoke-RestMethod 'http://127.0.0.1:8787/router/status'; Write-Host 'Router respondeu:'; Write-Host ('Modo: ' + $r.mode); Write-Host ('Provider manual: ' + $r.manualProvider) } catch { Write-Host 'Nao foi possivel consultar o ClaudeZen. Verifique se o servidor esta rodando.' }"

echo.
echo ============================================
echo Alteracao concluida.
echo Nao e necessario reiniciar o servidor.
echo ============================================
echo.

pause
goto menu


:status
cls

echo ============================================
echo             CLAUDEZEN STATUS
echo ============================================
echo.

echo [routing-state.json]
echo --------------------------------------------
if exist "C:\AI_config\ClaudeZen\routing-state.json" (
    type "C:\AI_config\ClaudeZen\routing-state.json"
) else (
    echo Arquivo ainda nao existe.
)

echo.
echo.
echo [ClaudeZen Router]
echo --------------------------------------------

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"try { $r=Invoke-RestMethod 'http://127.0.0.1:8787/router/status'; $r | ConvertTo-Json -Depth 5 } catch { Write-Host 'ClaudeZen nao esta respondendo em 127.0.0.1:8787' }"

echo.
echo.
pause
goto menu


:end
endlocal
exit /b 0
```
