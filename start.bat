@echo off
echo Installing dependencies...
call npm install
echo.
echo Done! Starting the dashboard...
echo The app will open at http://localhost:5173
echo.
call npm run dev
