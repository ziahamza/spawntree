import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "4000", 10);
const mlServiceUrl = process.env.ML_SERVICE_URL || "http://localhost:5000";
const envName = process.env.ENV_NAME || "unknown";

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", env: envName, service: "gateway" }));
    return;
  }

  if (req.url === "/api/predict" && req.method === "POST") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();

      const mlRes = await fetch(`${mlServiceUrl}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const result = await mlRes.json();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...result, gateway_env: envName }));
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ML service unavailable", detail: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(port, () => {
  console.log(`Gateway listening on port ${port} (env: ${envName})`);
  console.log(`  ML service: ${mlServiceUrl}`);
});

process.on("SIGTERM", () => {
  console.log("Gateway shutting down...");
  server.close(() => process.exit(0));
});
