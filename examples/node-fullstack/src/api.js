import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "3000", 10);
const envName = process.env.ENV_NAME || "unknown";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", env: envName }));
    return;
  }

  if (req.url === "/api/items") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: ["alpha", "beta", "gamma"], env: envName }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(port, () => {
  console.log(`API server listening on port ${port} (env: ${envName})`);
});

process.on("SIGTERM", () => {
  console.log("API server shutting down...");
  server.close(() => process.exit(0));
});
