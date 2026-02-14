const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ELEVENLABS_API_KEY;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "elevenlabs-ws-proxy",
    api_key_configured: !!API_KEY,
  }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (clientWs, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const agentId = url.searchParams.get("agent_id");

  if (!agentId) {
    clientWs.send(JSON.stringify({ type: "error", message: "Missing agent_id" }));
    clientWs.close(1008, "Missing agent_id");
    return;
  }

  if (!API_KEY) {
    clientWs.send(JSON.stringify({ type: "error", message: "API key not configured" }));
    clientWs.close(1011, "No API key");
    return;
  }

  console.log(`[PROXY] New connection for agent: ${agentId}`);

  try {
    // Step 1: Get signed URL
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { headers: { "xi-api-key": API_KEY } }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[PROXY] Signed URL error: ${resp.status}`, err);
      clientWs.send(JSON.stringify({ type: "error", message: `Auth failed: ${resp.status}` }));
      clientWs.close(1011, "Auth failed");
      return;
    }

    const { signed_url } = await resp.json();
    console.log("[PROXY] Got signed URL, connecting to ElevenLabs...");

    // Step 2: Connect to ElevenLabs WebSocket
    const elWs = new WebSocket(signed_url);

    let clientMsgCount = 0;
    let elMsgCount = 0;
    let elConnected = false;

    // Buffer client messages until ElevenLabs connects
    const messageBuffer = [];

    // Client → ElevenLabs
    clientWs.on("message", (data) => {
      clientMsgCount++;
      if (elConnected && elWs.readyState === WebSocket.OPEN) {
        elWs.send(data);
      } else {
        messageBuffer.push(data);
      }
      if (clientMsgCount <= 3 || clientMsgCount % 200 === 0) {
        const preview = typeof data === "string"
          ? data.substring(0, 80)
          : `[binary ${data.length} bytes]`;
        console.log(`[PROXY] Client→EL #${clientMsgCount}: ${preview}`);
      }
    });

    elWs.on("open", () => {
      console.log("[PROXY] Connected to ElevenLabs");
      elConnected = true;

      // Flush buffered messages
      while (messageBuffer.length > 0) {
        const msg = messageBuffer.shift();
        elWs.send(msg);
      }

      clientWs.send(JSON.stringify({ type: "proxy_connected" }));
    });

    // ElevenLabs → Client
    elWs.on("message", (data) => {
      elMsgCount++;
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
      if (elMsgCount <= 5 || elMsgCount % 100 === 0) {
        const preview = typeof data === "string"
          ? (typeof data === "object" ? data.toString().substring(0, 120) : String(data).substring(0, 120))
          : `[binary ${data.length} bytes]`;
        console.log(`[PROXY] EL→Client #${elMsgCount}: ${preview}`);
      }
    });

    // Handle disconnections
    clientWs.on("close", (code, reason) => {
      console.log(`[PROXY] Client disconnected: ${code}. Msgs: client=${clientMsgCount}, el=${elMsgCount}`);
      if (elWs.readyState === WebSocket.OPEN) elWs.close();
    });

    elWs.on("close", (code, reason) => {
      const r = reason ? reason.toString() : "";
      console.log(`[PROXY] ElevenLabs disconnected: ${code} ${r}. Msgs: client=${clientMsgCount}, el=${elMsgCount}`);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, r);
    });

    // Handle errors
    clientWs.on("error", (e) => {
      console.error("[PROXY] Client error:", e.message);
      if (elWs.readyState === WebSocket.OPEN) elWs.close();
    });

    elWs.on("error", (e) => {
      console.error("[PROXY] ElevenLabs error:", e.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", message: "ElevenLabs connection error" }));
        clientWs.close(1011, "Upstream error");
      }
    });

  } catch (e) {
    console.error("[PROXY] Setup error:", e.message);
    clientWs.send(JSON.stringify({ type: "error", message: "Setup failed: " + e.message }));
    clientWs.close(1011, "Setup failed");
  }
});

server.listen(PORT, () => {
  console.log(`[PROXY] WebSocket proxy running on port ${PORT}`);
});
