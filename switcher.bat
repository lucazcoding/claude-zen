@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=C:\AI_config\ClaudeZen"
cd /d "%BASE%"

:menu
cls

echo ============================================
echo          CLAUDEZEN HYBRID ROUTER
echo ============================================
echo.

:: Gera o menu a partir dos providers do config.json (sem parsear JSON em batch)
set "MENU_OK=1"
for /f "usebackq delims=" %%L in (`node "%BASE%\switcher-helper.js" menu`) do (
    echo %%L
    set "MENU_OK=0"
)

if "!MENU_OK!"=="1" (
    echo.
    echo ERRO: nao foi possivel gerar o menu. Verifique o config.json.
    pause
    goto menu
)

echo.
set /p choice=Escolha: 

:: Resolve a opcao escolhida (tipo#id) via helper
set "RT="
set "RI="
for /f "usebackq tokens=1,2 delims=#" %%A in (`node "%BASE%\switcher-helper.js" resolve %choice%`) do (
    set "RT=%%A"
    set "RI=%%B"
)

if "%RT%"=="auto" goto auto
if "%RT%"=="manual" goto manual
if "%RT%"=="status" goto status
if "%RT%"=="exit" goto end

echo.
echo Opcao invalida.
pause
goto menu


:auto
echo.
echo Alterando para AUTO...

node "%BASE%\switcher-helper.js" set auto

if errorlevel 1 (
    echo.
    echo ERRO ao alterar o modo.
    pause
    goto menu
)

goto verify


:manual
echo.
echo Alterando para manual: %RI%...

node "%BASE%\switcher-helper.js" set manual %RI%

if errorlevel 1 (
    echo.
    echo ERRO ao alterar o provider.
    pause
    goto menu
)

goto verify


:verify
echo.
echo Verificando estado atual...
echo.

if not exist "%BASE%\routing-state.json" (
    echo ERRO: routing-state.json nao foi criado.
    echo.
    pause
    goto menu
)

type "%BASE%\routing-state.json"

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
if exist "%BASE%\routing-state.json" (
    type "%BASE%\routing-state.json"
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