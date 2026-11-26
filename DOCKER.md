# Docker Deployment Guide for Cadence CX (Knowmon)

This directory contains production-ready Docker configurations to run the complete Cadence CX stack (React Frontend, FastAPI Backend, and MongoDB Database) with Docker Compose.

---

## Architecture Overview

```
               [ User Browser ]
                      │
                      ▼ :3001
         ┌─────────────────────────┐
         │     Frontend Service    │
         │   (Nginx Alpine + SPA)  │
         └────────────┬────────────┘
                      │ /api/* (reverse proxy)
                      ▼ :8050
         ┌─────────────────────────┐
         │     Backend Service     │
         │   (FastAPI + Python)    │
         └────────────┬────────────┘
                      │
                      ▼ :27017
         ┌─────────────────────────┐
         │     MongoDB Service     │
         │     (mongo:6.0 Image)   │
         │     [mongo_data vol]    │
         └─────────────────────────┘
```

- **Frontend Container (`knowmon-frontend`)**: Lightweight Alpine Nginx image (~27 MB) serving the pre-compiled React SPA. Reverse-proxies all `/api/` traffic to the backend, eliminating CORS concerns in production.
- **Backend Container (`knowmon-backend`)**: Python 3.11-slim container running FastAPI with Uvicorn, health checks, LDAP3, and local emergentintegrations support.
- **MongoDB Container (`knowmon-mongodb`)**: Official MongoDB 6.0 container with data persisted to Docker volume `knowmon_mongo_data`.

---

## Quick Start

### 1. Prerequisites
- Docker Engine 20.10+ / Docker Desktop
- Docker Compose v2+

### 2. Configure Environment (Optional)
Copy the example environment file:
```bash
cp .env.docker.example .env
```
Default ports:
- `FRONTEND_PORT`: `3001`
- `BACKEND_PORT`: `8050`
- `MONGO_PORT`: `27017`

### 3. Launch with Docker Compose
Using the convenience script:
- **Linux / WSL / macOS**:
  ```bash
  chmod +x docker-start.sh
  ./docker-start.sh
  ```
- **Windows**:
  ```cmd
  docker-start.bat
  ```

Or directly with standard Docker Compose:
```bash
docker compose up -d --build
```

---

## Verifying Services

Once started, open your browser:
- **Application Web UI**: [http://localhost:3001](http://localhost:3001)
- **Integrations Configuration**: [http://localhost:3001/integrations](http://localhost:3001/integrations)
- **Backend Health Check**: [http://localhost:8050/api/auth/ldap/config](http://localhost:8050/api/auth/ldap/config)

---

## Common Commands

| Action | Command |
| :--- | :--- |
| **View logs** | `docker compose logs -f` |
| **View specific service logs** | `docker compose logs -f backend` (or `frontend`, `mongodb`) |
| **Check container health** | `docker compose ps` |
| **Stop services** | `docker compose down` |
| **Stop and remove data volume** | `docker compose down -v` |
| **Rebuild containers** | `docker compose build --no-cache` |

---

## Rebuilding the Frontend Bundle

If you make modifications to the React code in `frontend/src`:
1. Rebuild the bundle:
   ```bash
   cd frontend
   DISABLE_ESLINT_PLUGIN=true GENERATE_SOURCEMAP=false npm run build
   ```
2. Rebuild the Docker image:
   ```bash
   docker compose build frontend
   docker compose up -d frontend
   ```
