@echo off
setlocal

cd /d "%~dp0"
echo ===================================================
echo     Cadence CX (Knowmon) Docker Launcher
echo ===================================================

if not exist .env (
    if exist .env.docker.example (
        echo Copying .env.docker.example to .env...
        copy .env.docker.example .env >nul
    )
)

echo Building and starting containers via Docker Compose...
docker compose up -d --build

echo.
echo ===================================================
echo Services are now starting:
echo  - Frontend UI: http://localhost:3001
echo  - Backend API: http://localhost:8050
echo  - MongoDB:     localhost:27017
echo.
echo To view live logs:    docker compose logs -f
echo To stop all services: docker compose down
echo ===================================================
endlocal
