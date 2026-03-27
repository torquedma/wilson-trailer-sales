// Netlify Function — inventory store
const https = require("https");
function netlifyFetch(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  const siteId = process.env.NETLIFY_SITE_ID;
  const blobsToken = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (!siteId || !blobsToken) {
    if (event.httpMethod === "GET") return { statusCode: 200, headers, body: JSON.stringify([]) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing NETLIFY_SITE_ID or NETLIFY_BLOBS_TOKEN env vars" }) };
  }
  const blobsHost = "api.netlify.com";
  const blobsPath = `/api/v1/blobs/${siteId}/torquehub/wilsontrailersales-inventory`;
  if (event.httpMethod === "POST") {
    try {
      const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
      const token = auth.replace("Bearer ", "");
      if (!token || token !== process.env.INVENTORY_TOKEN) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
      }
      const payload = event.body;
      const result = await netlifyFetch({
        hostname: blobsHost,
        path: blobsPath,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${blobsToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, payload);
      if (result.status >= 400) throw new Error(`Blobs API error ${result.status}: ${result.body.slice(0, 200)}`);
      const data = JSON.parse(payload);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, count: Array.isArray(data) ? data.length : "unknown" }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }
  if (event.httpMethod === "GET") {
    try {
      const result = await netlifyFetch({
        hostname: blobsHost,
        path: blobsPath,
        method: "GET",
        headers: { Authorization: `Bearer ${blobsToken}` },
      });
      if (result.status === 404 || result.status >= 400) return { statusCode: 200, headers, body: JSON.stringify([]) };
      const body = result.body && result.body.trim() ? result.body : "[]";
      return { statusCode: 200, headers, body };
    } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }
  }
  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
