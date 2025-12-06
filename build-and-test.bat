@echo off
setlocal enabledelayedexpansion

echo ============================================
echo   BUILD SINGLE .EXE FILE (PORTABLE)
echo ============================================
echo.

echo 1. Stopping any running apps...
taskkill /f /im WhatsAppBlast.exe 2>nul
timeout /t 1 /nobreak >nul

echo 2. Cleaning previous builds...
if exist "dist" rmdir /s /q "dist"
if exist "release" rmdir /s /q "release"
mkdir dist 2>nul

echo 3. Building frontend...
call npm run build
if errorlevel 1 (
    echo ❌ Frontend build failed!
    pause
    exit /b 1
)

echo 4. Creating portable build config...
(
echo {
  "appId": "com.whatsappblast.portable",
  "productName": "WhatsApp Blast",
  "asar": true,
  "compression": "maximum",
  "directories": {
    "output": "release-portable"
  },
  "files": [
    "dist/**",
    "node_modules/**",
    {
      "from": "backend",
      "to": "backend",
      "filter": [
        "src/**",
        "routes/**",
        "controllers/**",
        "middleware/**",
        "scripts/**",
        "config/**",
        "*.mjs",
        ".env*",
        "!**/.wwebjs_cache/**",
        "!uploads/**",
        "!**/.wwebjs_auth/**"
      ]
    },
    "electron/**",
    "package.json",
    "!**/*.map",
    "!**/*.md"
  ],
  "extraResources": [
    { 
      "from": "backend/database_config.json", 
      "to": "backend/database_config.json" 
    }
  ],
  "asarUnpack": [
    "node_modules/puppeteer-core/**",
    "node_modules/ffmpeg-static/**",
    "node_modules/**/{*.node,*.dll}",
    ".wwebjs_auth/**",
    ".wwebjs_cache/**"
  ],
  "win": {
    "target": "portable",
    "artifactName": "WhatsAppBlast-Portable.exe",
    "icon": "electron/assets/icon.ico"
  }
}
) > electron-builder-portable.json

echo 5. Building portable .exe...
echo This will take 3-5 minutes...
npx electron-builder --config electron-builder-portable.json --win portable --x64

echo 6. Checking result...
if exist "release-portable\WhatsAppBlast-Portable.exe" (
    move "release-portable\WhatsAppBlast-Portable.exe" "WhatsAppBlast-Portable.exe"
    echo ✅✅✅ SUCCESS! ✅✅✅
    echo.
    echo ============================================
    echo 🎉 SINGLE .EXE FILE READY FOR DEPLOYMENT!
    echo ============================================
    echo 📄 File: WhatsAppBlast-Portable.exe
    echo 📦 Size: 
    for %%F in ("WhatsAppBlast-Portable.exe") do (
        set size=%%~zF
        set /a sizeMB=!size!/1048576
        echo   !size! bytes (!sizeMB! MB)
    )
    echo.
    echo 🚀 HOW TO USE ON ANOTHER SYSTEM:
    echo   1. Copy ONLY "WhatsAppBlast-Portable.exe"
    echo   2. Double-click to run
    echo   3. No installation needed
    echo   4. WhatsApp session saves automatically
    echo.
    echo 📍 Session saves to: %%APPDATA%%\WhatsApp Blast\.wwebjs_auth
    echo ============================================
    
    echo 7. Creating README file...
    (
    echo WhatsApp Blast - Portable Version
    echo ================================
    echo.
    echo Just double-click "WhatsAppBlast-Portable.exe" to run.
    echo No installation required.
    echo.
    echo Session files are saved in:
    echo   %%APPDATA%%\WhatsApp Blast\.wwebjs_auth
    echo.
    echo Build contains your WhatsApp session fix!
    echo.
    echo Build date: %date% %time%
    ) > README-Portable.txt
    
    echo.
    echo 📋 README created: README-Portable.txt
) else (
    echo ❌ Build failed! Trying alternative method...
    
    echo Trying standard build...
    npm run desktop:build
    
    if exist "release\WhatsAppBlast-Setup-1.0.1.exe" (
        copy "release\WhatsAppBlast-Setup-1.0.1.exe" "WhatsAppBlast-Setup.exe"
        echo ✅ Setup file created: WhatsAppBlast-Setup.exe
        echo Install this on other systems.
    )
)

echo.
echo ============================================
echo 🏁 BUILD PROCESS COMPLETED
echo ============================================
pause