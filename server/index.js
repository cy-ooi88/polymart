"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { BullpenAdapter } = require("./bullpen-adapter");

const ROOT_DIR = path.resolve(__dirname, "..");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const allowedOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const adapter = new BullpenAdapter();
const sessionKeyStore = {
  loaded: false,
  privateKey: null,
  fingerprint: null,
  updatedAt: null
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || allowedOriginPattern.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function maskAddress(address) {
  if (!address || address.length < 10) return address || "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function validatePrivateKey(value) {
  const normalized = String(value || "").trim().replace(/^0x/, "");
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("Private key must be a 64-character hex string");
  }
  return `0x${normalized}`;
}

function clearSessionKey() {
  sessionKeyStore.loaded = false;
  sessionKeyStore.privateKey = null;
  sessionKeyStore.fingerprint = null;
  sessionKeyStore.updatedAt = null;
}

async function buildStatusPayload() {
  const status = await adapter.getStatus();
  let approvals = {
    ok: false,
    approved: false,
    message: "Skipped until Bullpen login is available"
  };
  let preflight = {
    ok: false,
    checks: [],
    message: "Skipped until Bullpen login is available"
  };

  if (status.cliInstalled && status.loggedIn) {
    approvals = await adapter.getApprovalStatus();
    preflight = await adapter.runPreflight();
  }

  return {
    ok: status.cliInstalled,
    cliInstalled: status.cliInstalled,
    loggedIn: status.loggedIn,
    address: status.address,
    addressMasked: maskAddress(status.address),
    jwtExpires: status.jwtExpires,
    sessionExpires: status.sessionExpires,
    tokenStore: status.tokenStore,
    credentialsPath: status.credentialsPath,
    approvals,
    preflight,
    sessionKeyLoaded: sessionKeyStore.loaded,
    sessionKeyFingerprint: sessionKeyStore.fingerprint,
    keyStorage: "memory-only",
    backendMode: "local-single-user",
    wsl2Recommended: true,
    rawStatusText: status.rawText
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bullpen/status") {
    const payload = await buildStatusPayload();
    sendJson(res, 200, payload);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bullpen/login/start") {
    sendJson(res, 200, {
      ok: true,
      command: "bullpen login",
      note: "Run this inside the same WSL2 environment where the local server is running, then verify with bullpen status.",
      docs: "https://cli.bullpen.fi/quickstart/"
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bullpen/session-key") {
    const body = await readBody(req);
    const privateKey = validatePrivateKey(body.privateKey);
    sessionKeyStore.loaded = true;
    sessionKeyStore.privateKey = privateKey;
    sessionKeyStore.updatedAt = Date.now();
    sessionKeyStore.fingerprint = `0x****${privateKey.slice(-4)}`;
    sendJson(res, 200, {
      ok: true,
      sessionKeyLoaded: true,
      sessionKeyFingerprint: sessionKeyStore.fingerprint,
      message: "Session key loaded in memory only"
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/bullpen/session-key") {
    clearSessionKey();
    sendJson(res, 200, {
      ok: true,
      sessionKeyLoaded: false,
      message: "Session key cleared"
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/markets/current") {
    const market = await adapter.getCurrentMarket();
    sendJson(res, 200, {
      ok: true,
      market
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/markets/current/price") {
    const slug = url.searchParams.get("slug") || "";
    const price = await adapter.getPrice(slug);
    sendJson(res, 200, {
      ok: true,
      price
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/positions") {
    const positions = await adapter.getPositions();
    sendJson(res, 200, positions);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/preflight") {
    const result = await adapter.runPreflight();
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/approve") {
    const result = await adapter.approveAll();
    sendJson(res, result.ok ? 200 : 400, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/buy") {
    if (!sessionKeyStore.loaded) {
      sendJson(res, 400, {
        ok: false,
        message: "Session key not loaded. Paste a private key into the Bullpen Session panel first."
      });
      return true;
    }
    const body = await readBody(req);
    const result = await adapter.placeBuy(body);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/sell") {
    if (!sessionKeyStore.loaded) {
      sendJson(res, 400, {
        ok: false,
        message: "Session key not loaded. Paste a private key into the Bullpen Session panel first."
      });
      return true;
    }
    const body = await readBody(req);
    const result = await adapter.placeSell(body);
    sendJson(res, 200, result);
    return true;
  }

  return false;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function resolveStaticPath(urlPathname) {
  const requested = urlPathname === "/" ? "/index.html" : urlPathname;
  const normalized = path.normalize(requested).replace(/^(\.\.[\\/])+/, "").replace(/^[/\\]+/, "");
  return path.join(ROOT_DIR, normalized);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendJson(res, 404, { ok: false, message: "API route not found" });
      }
      return;
    }

    const filePath = resolveStaticPath(url.pathname);
    if (!filePath.startsWith(ROOT_DIR)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        sendText(res, 404, "Not found");
        return;
      }
      sendText(res, 200, contents, getContentType(filePath));
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      message: error.message || "Unexpected server error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bullpen local app available at http://${HOST}:${PORT}`);
});
