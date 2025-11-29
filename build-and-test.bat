@echo off
echo 🏗️  Building Electron app...
call npm run build

echo 📦 Creating packaged app...
call npm run desktop:pack

echo ✅ Build complete! 
echo 📁 Check the 'release' directory for the packaged app
echo.
echo 🧪 To test the packaged app:
echo    1. Navigate to release\win-unpacked
echo    2. Run WhatsAppBlast.exe
echo    3. Check if database connection works
echo.
pause