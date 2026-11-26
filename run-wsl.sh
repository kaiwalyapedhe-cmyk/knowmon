#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== 1. Checking MongoDB ==="
if ! docker ps --filter "name=knowmon-mongo" --filter "status=running" | grep -q knowmon-mongo; then
    echo "Starting knowmon-mongo docker container..."
    docker start knowmon-mongo || docker run -d --name knowmon-mongo -p 27017:27017 --restart always mongo:6
fi
echo "MongoDB is running on port 27017."

echo "=== 2. Starting Backend (FastAPI on http://localhost:8050) ==="
cd "$DIR/backend"
~/.venvs/knowmon/bin/uvicorn server:app --host 0.0.0.0 --port 8050 > /tmp/knowmon-backend.log 2>&1 &
BACKEND_PID=$!
echo "Backend started with PID $BACKEND_PID. Logs at /tmp/knowmon-backend.log"

echo "=== 3. Starting Frontend (React on http://localhost:3001) ==="
cd "$DIR/frontend"
PORT=3001 BROWSER=none npm start > /tmp/knowmon-frontend.log 2>&1 &
FRONTEND_PID=$!
echo "Frontend started with PID $FRONTEND_PID. Logs at /tmp/knowmon-frontend.log"

echo "=========================================================="
echo "Cadence CX is starting up!"
echo "Backend:  http://localhost:8050"
echo "Frontend: http://localhost:3001"
echo "=========================================================="

wait
