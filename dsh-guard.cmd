@echo off
rem dsh-guard Windows launcher: forwards to dsh-guard.mjs in the same directory
node "%~dp0dsh-guard.mjs" %*
