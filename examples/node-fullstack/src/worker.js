const apiUrl = process.env.API_URL || "http://localhost:3000";
const envName = process.env.ENV_NAME || "unknown";

console.log(`Worker started (env: ${envName}), polling ${apiUrl}/api/items`);

async function poll() {
  try {
    const res = await fetch(`${apiUrl}/api/items`);
    const data = await res.json();
    console.log(`[${new Date().toISOString()}] Fetched ${data.items.length} items from API`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Failed to reach API: ${err.message}`);
  }
}

const interval = setInterval(poll, 5000);
poll();

process.on("SIGTERM", () => {
  console.log("Worker shutting down...");
  clearInterval(interval);
  process.exit(0);
});
