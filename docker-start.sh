#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Cadence CX (Knowmon) Docker Launcher ==="

# Check environment file
if [ ! -f .env ]; then
  if [ -f .env.docker.example ]; then
    echo "Creating .env from .env.docker.example..."
    cp .env.docker.example .env
  fi
fi

# Build and start services
echo "Starting containers via Docker Compose..."
docker compose up -d --build

echo ""
echo "=== Services Running ==="
echo "• Frontend UI: http://localhost:3001"
echo "• Backend API: http://localhost:8050"
echo "• MongoDB:     localhost:27017"
echo ""
echo "To view live logs:    docker compose logs -f"
echo "To stop all services: docker compose down"
