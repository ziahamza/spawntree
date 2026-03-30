import { createServer } from "node:http";

const port = parseInt(process.env.PORT || "8080", 10);
const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:4000";
const envName = process.env.ENV_NAME || "unknown";

const html = `<!DOCTYPE html>
<html>
<head><title>spawntree multi-language demo</title></head>
<body>
  <h1>Multi-Language Demo (env: ${envName})</h1>
  <p>Gateway: <code>${gatewayUrl}</code></p>
  <form id="form">
    <input id="text" placeholder="Enter text for sentiment analysis" style="width:300px" />
    <button type="submit">Predict</button>
  </form>
  <pre id="result"></pre>
  <script>
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const text = document.getElementById('text').value;
      try {
        const res = await fetch('${gatewayUrl}/api/predict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        document.getElementById('result').textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        document.getElementById('result').textContent = 'Error: ' + err.message;
      }
    };
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
});

server.listen(port, () => {
  console.log(`Static server on port ${port} (env: ${envName})`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
