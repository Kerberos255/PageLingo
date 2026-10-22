@echo off
setlocal EnableExtensions DisableDelayedExpansion
if /I "%~1"=="--help" goto :help
set "PLMT_KIND=probe"
if not "%~1"=="" set "PLMT_KIND=%~1"
if /I not "%PLMT_KIND%"=="check" if /I not "%PLMT_KIND%"=="probe" if /I not "%PLMT_KIND%"=="train" goto :usage

rem Run this from the existing PageLingo-MT.cmd environment on the training PC.
if not defined ROOT goto :environment_missing
set "PLMT_ROOT=%ROOT%"
if /I "%PLMT_ROOT:~0,2%"=="C:" goto :system_drive
if not exist "%PLMT_ROOT%\codex-fixed-slots-v1\run_local.py" goto :package_missing
if not exist "%PLMT_ROOT%\.venv\Scripts\python.exe" goto :python_missing

rem Set all task caches before launching Python. Preserve the installed GPU venv.
set "TEMP=%PLMT_ROOT%\.tmp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
set "HF_HOME=%PLMT_ROOT%\.cache\huggingface"
set "HF_HUB_CACHE=%HF_HOME%\hub"
set "HUGGINGFACE_HUB_CACHE=%HF_HUB_CACHE%"
set "HF_DATASETS_CACHE=%HF_HOME%\datasets"
set "HF_XET_CACHE=%HF_HOME%\xet"
set "HF_ASSETS_CACHE=%HF_HOME%\assets"
set "HF_MODULES_CACHE=%HF_HOME%\modules"
set "PIP_CACHE_DIR=%PLMT_ROOT%\.cache\pip"
set "PYTHONPYCACHEPREFIX=%PLMT_ROOT%\.cache\pycache"
set "TORCH_HOME=%PLMT_ROOT%\.cache\torch"
set "TORCH_EXTENSIONS_DIR=%PLMT_ROOT%\.cache\torch_extensions"
set "TORCHINDUCTOR_CACHE_DIR=%PLMT_ROOT%\.cache\torch_inductor"
set "TRITON_CACHE_DIR=%PLMT_ROOT%\.cache\triton"
set "CUDA_CACHE_PATH=%PLMT_ROOT%\.cache\cuda"
set "XDG_CACHE_HOME=%PLMT_ROOT%\.cache"
set "UV_CACHE_DIR=%PLMT_ROOT%\.cache\uv"
set "WANDB_DIR=%PLMT_ROOT%\.cache\wandb"
set "WANDB_CACHE_DIR=%WANDB_DIR%\cache"
set "MPLCONFIGDIR=%PLMT_ROOT%\.cache\matplotlib"
set "NUMBA_CACHE_DIR=%PLMT_ROOT%\.cache\numba"
set "WANDB_MODE=disabled"
set "HF_HUB_OFFLINE=1"
set "HF_DATASETS_OFFLINE=1"
set "HF_HUB_DISABLE_TELEMETRY=1"
set "HF_HUB_DISABLE_UPDATE_CHECK=1"
set "DO_NOT_TRACK=1"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
set "TOKENIZERS_PARALLELISM=false"
set "CUDA_VISIBLE_DEVICES=0"

for %%D in ("%TEMP%" "%PIP_CACHE_DIR%" "%PYTHONPYCACHEPREFIX%" "%HF_HUB_CACHE%" "%HF_DATASETS_CACHE%" "%HF_XET_CACHE%" "%HF_ASSETS_CACHE%" "%HF_MODULES_CACHE%" "%TORCH_HOME%" "%TORCH_EXTENSIONS_DIR%" "%TORCHINDUCTOR_CACHE_DIR%" "%TRITON_CACHE_DIR%" "%CUDA_CACHE_PATH%" "%UV_CACHE_DIR%" "%WANDB_CACHE_DIR%" "%MPLCONFIGDIR%" "%NUMBA_CACHE_DIR%") do if not exist "%%~D" mkdir "%%~D"
pushd "%PLMT_ROOT%" || goto :environment_missing
echo.
echo PageLingo fixed-slot LoRA - %PLMT_KIND%
echo Root: %PLMT_ROOT%
echo Cache: %PLMT_ROOT%\.cache
echo Outputs: %PLMT_ROOT%\outputs
echo Existing weights and environment will be preserved.
echo.
"%PLMT_ROOT%\.venv\Scripts\python.exe" -u "%PLMT_ROOT%\codex-fixed-slots-v1\run_local.py" --root "%PLMT_ROOT%" --kind "%PLMT_KIND%"
set "PLMT_EXIT=%ERRORLEVEL%"
popd
echo.
if not "%PLMT_EXIT%"=="0" echo FAILED - see the printed run directory and console.log.
if "%PLMT_EXIT%"=="0" echo COMPLETE - see the printed run directory.
pause
exit /b %PLMT_EXIT%

:help
echo Open the existing PageLingo-MT.cmd first, then run:
echo   .\run-fixed-slots-v1.cmd check   - validate/tokenize only
echo   .\run-fixed-slots-v1.cmd         - bounded 12-step GPU pipeline probe
echo   .\run-fixed-slots-v1.cmd train   - reviewed data only
echo This script does not install packages, download models or upload weights.
exit /b 0
:usage
echo Usage: run-fixed-slots-v1.cmd [check^|probe^|train]
exit /b 2
:environment_missing
echo First open E:\PageLingo-MT\PageLingo-MT.cmd on the training PC.
pause
exit /b 2
:system_drive
echo Refusing to place task caches or training outputs on C:.
pause
exit /b 2
:package_missing
echo Missing %PLMT_ROOT%\codex-fixed-slots-v1\run_local.py
pause
exit /b 2
:python_missing
echo Missing the existing project Python venv. No packages were installed.
pause
exit /b 2
