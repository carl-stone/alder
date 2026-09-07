@echo off
setlocal

where Rscript >nul 2>&1
if errorlevel 1 (
  echo alder: Rscript was not found on PATH 1>&2
  exit /b 127
)

Rscript --vanilla -e "status <- alder::alder_cli(commandArgs(trailingOnly = TRUE)); quit(save = 'no', status = status, runLast = FALSE)" %*
set "alder_status=%ERRORLEVEL%"
exit /b %alder_status%
