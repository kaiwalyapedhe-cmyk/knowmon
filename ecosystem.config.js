const path = require("path");

const venvBin = path.join(__dirname, "venv", "bin");
const localVenvBin = "/home/jsf0015/.venvs/knowmon/bin";
const fs = require("fs");

// Detect uvicorn binary path automatically
let uvicornPath = path.join(venvBin, "uvicorn");
if (!fs.existsSync(uvicornPath) && fs.existsSync(path.join(localVenvBin, "uvicorn"))) {
  uvicornPath = path.join(localVenvBin, "uvicorn");
}

let pythonPath = path.join(venvBin, "python3");
if (!fs.existsSync(pythonPath)) {
  pythonPath = "python3";
}

module.exports = {
  apps: [
    {
      name: "knowmon-backend",
      script: uvicornPath,
      args: "server:app --host 0.0.0.0 --port 8050",
      cwd: path.join(__dirname, "backend"),
      interpreter: "none",
      restart_delay: 2000,
      env: {
        PORT: 8050,
      },
    },
    {
      name: "knowmon-frontend",
      script: "serve_spa.py",
      cwd: __dirname,
      interpreter: pythonPath,
      restart_delay: 2000,
      env: {
        PORT: 3005,
      },
    },
  ],
};
