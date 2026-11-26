@echo off
title Start Agent Deck
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AgentDeck.ps1"
if errorlevel 1 (
  echo.
  echo Agent Deck could not be started.
  pause
)
