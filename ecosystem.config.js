module.exports = {
  apps: [
    {
      name: "knowmon-backend",
      script: "/home/jsf0015/.venvs/knowmon/bin/uvicorn",
      args: "server:app --host 0.0.0.0 --port 8050",
      cwd: "/home/jsf0015/knowmon/backend",
      interpreter: "none",
      restart_delay: 2000,
      env: {
        PORT: 8050,
      },
    },
    {
      name: "knowmon-frontend",
      script: "serve_spa.py",
      cwd: "/home/jsf0015/knowmon",
      interpreter: "python3",
      restart_delay: 2000,
      env: {
        PORT: 3001,
      },
    },
  ],
};
