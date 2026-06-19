const { spawn } = require("node:child_process");

const host = process.env.BOT_STUDIO_HOST || "127.0.0.1";
const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
const port = Number(process.env.BOT_STUDIO_PORT || 8790);
const url = `http://${displayHost}:${port}`;

require("./server.js");

setTimeout(() => {
  const child = spawn("cmd.exe", ["/c", "start", "", url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}, 600);
