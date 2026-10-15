@echo off
rem Native Messaging host launcher (Windows). The browser runs this file;
rem it forwards stdio to the Node host. Node must be on PATH.
node "%~dp0..\dist\main.js"
