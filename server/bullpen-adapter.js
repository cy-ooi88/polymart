"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const { resolveCurrentMarket, normalizeBullpenMarket } = require("./event-resolver");

const execFileAsync = promisify(execFile);

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bestAskFromBook(data) {
  const asks = Array.isArray(data?.asks) ? data.asks : [];
  const values = asks
    .map((ask) => Number(ask?.price))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function bestBidFromBook(data) {
  const bids = Array.isArray(data?.bids) ? data.bids : [];
  const values = bids
    .map((bid) => Number(bid?.price))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function formatError(error, fallbackMessage) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  return stderr || stdout || error?.message || fallbackMessage;
}

function coerceBooleanStatus(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["pass", "ok", "ready", "approved", "logged in", "present", "valid"].includes(normalized)) return true;
  if (["fail", "error", "not approved", "missing", "not logged in", "invalid"].includes(normalized)) return false;
  return null;
}

function normalizeOutcomeName(name) {
  return String(name || "").trim().toLowerCase();
}

function isUpAlias(name) {
  return ["up", "yes", "y", "true", "1"].includes(normalizeOutcomeName(name));
}

function isDownAlias(name) {
  return ["down", "no", "n", "false", "0"].includes(normalizeOutcomeName(name));
}

function parseAvailableOutcomeLabels(text) {
  const match = String(text || "").match(/Available:\s*(\[[^\]]+\])/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function chooseOutcomeLabel(side, candidates) {
  const matcher = normalizeOutcomeName(side) === "up" ? isUpAlias : isDownAlias;
  return candidates.find((label) => matcher(label)) || null;
}

class BullpenAdapter {
  constructor() {
    this.command = process.env.BULLPEN_CMD || "bullpen";
    this.timeoutMs = Number(process.env.BULLPEN_TIMEOUT_MS || 20000);
    this.cachedCurrentMarket = null;
    this.cachedAt = 0;
  }

  async run(args, options = {}) {
    const timeout = Number(options.timeoutMs || this.timeoutMs);
    try {
      const result = await execFileAsync(this.command, args, {
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: process.env
      });
      return {
        ok: true,
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim()
      };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return {
          ok: false,
          missing: true,
          stdout: "",
          stderr: "",
          error: `Bullpen CLI not found (${this.command}). Install it in WSL2 and make sure it is on PATH.`
        };
      }

      return {
        ok: false,
        stdout: String(error?.stdout || "").trim(),
        stderr: String(error?.stderr || "").trim(),
        error: formatError(error, "Bullpen command failed")
      };
    }
  }

  parseStatusText(text) {
    const normalized = String(text || "");
    const addressMatch = normalized.match(/Address:\s*(0x[a-fA-F0-9]{6,})/);
    const jwtMatch = normalized.match(/JWT expires:\s*(.+)/i);
    const sessionMatch = normalized.match(/Session expires:\s*(.+)/i);
    const credentialsMatch = normalized.match(/Credentials:\s*(.+)/i);
    const tokenStoreMatch = normalized.match(/Token store:\s*(.+)/i);
    const loggedIn = /Status:\s*Logged in/i.test(normalized) || /^Logged in\./im.test(normalized);

    return {
      loggedIn,
      address: addressMatch ? addressMatch[1] : null,
      jwtExpires: jwtMatch ? jwtMatch[1].trim() : null,
      sessionExpires: sessionMatch ? sessionMatch[1].trim() : null,
      credentials: credentialsMatch ? credentialsMatch[1].trim() : null,
      tokenStore: tokenStoreMatch ? tokenStoreMatch[1].trim() : null,
      rawText: normalized
    };
  }

  async getStatus() {
    const jsonAttempt = await this.run(["status", "--output", "json"]);
    const textAttempt = await this.run(["status"]);
    const parsedJson = jsonAttempt.ok ? parseJsonSafe(jsonAttempt.stdout) : null;
    const parsedText = this.parseStatusText(textAttempt.stdout || jsonAttempt.stdout);

    if (!jsonAttempt.ok && jsonAttempt.missing) {
      return {
        ok: false,
        cliInstalled: false,
        loggedIn: false,
        address: null,
        rawText: jsonAttempt.error
      };
    }

    const checks = Array.isArray(parsedJson?.checks) ? parsedJson.checks : [];
    const authCheck = checks.find((item) => String(item?.name || "").toLowerCase() === "auth");
    const authStatus = coerceBooleanStatus(authCheck?.status);
    const cliInstalled = jsonAttempt.ok || textAttempt.ok;

    return {
      ok: cliInstalled,
      cliInstalled,
      loggedIn: authStatus !== null ? authStatus : parsedText.loggedIn,
      address: parsedJson?.account?.address || parsedJson?.address || parsedText.address,
      jwtExpires: parsedJson?.account?.jwt_expires || parsedJson?.jwt_expires || parsedText.jwtExpires,
      sessionExpires: parsedJson?.account?.session_expires || parsedJson?.session_expires || parsedText.sessionExpires,
      tokenStore: parsedJson?.token_store || parsedText.tokenStore,
      credentialsPath: parsedText.credentials,
      rawJson: parsedJson,
      rawText: parsedText.rawText
    };
  }

  async getApprovalStatus() {
    const result = await this.run(["polymarket", "approve", "--check", "--output", "json"]);
    if (result.ok) {
      const data = parseJsonSafe(result.stdout);
      if (data) {
        return {
          ok: true,
          approved: coerceBooleanStatus(data?.approved ?? data?.status) ?? true,
          message: data?.message || "Approval status fetched",
          raw: data
        };
      }
    }

    const fallback = await this.run(["polymarket", "approve", "--check"]);
    const text = fallback.stdout || fallback.stderr || result.stderr || result.error || "";
    const approved = /approved|all set|already set|ready/i.test(text) && !/not approved|missing/i.test(text);

    return {
      ok: fallback.ok,
      approved,
      message: text || "Could not determine approval status",
      raw: text
    };
  }

  async approveAll() {
    const result = await this.run(["polymarket", "approve", "--yes", "--output", "json"], { timeoutMs: 45000 });
    if (result.ok) {
      const data = parseJsonSafe(result.stdout);
      return {
        ok: true,
        approved: true,
        message: data?.message || "Approvals submitted",
        raw: data || result.stdout
      };
    }

    const fallback = await this.run(["polymarket", "approve", "--yes"], { timeoutMs: 45000 });
    return {
      ok: fallback.ok,
      approved: fallback.ok,
      message: fallback.ok ? (fallback.stdout || "Approvals submitted") : (fallback.error || "Approval request failed"),
      raw: fallback.stdout || fallback.stderr
    };
  }

  async runPreflight() {
    const result = await this.run(["polymarket", "preflight", "--output", "json"]);
    if (result.ok) {
      const data = parseJsonSafe(result.stdout);
      if (data) {
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const failed = checks.filter((item) => coerceBooleanStatus(item?.status) === false);
        return {
          ok: failed.length === 0,
          checks,
          message: data.message || (failed.length ? "Preflight found issues" : "Preflight passed"),
          raw: data
        };
      }
    }

    const fallback = await this.run(["polymarket", "preflight"]);
    const text = fallback.stdout || fallback.stderr || result.error || "";
    const ok = /pass|ready|all clear/i.test(text) && !/fail|error|missing|insufficient/i.test(text);
    return {
      ok: fallback.ok ? ok : false,
      checks: [],
      message: text || "Preflight could not be parsed",
      raw: text
    };
  }

  extractPriceSnapshot(data, slug) {
    const root = data?.market || data?.data || data;
    const outcomeMap = new Map();

    const outcomeCandidates = []
      .concat(Array.isArray(root?.outcomes) ? root.outcomes : [])
      .concat(Array.isArray(root?.prices) ? root.prices : []);

    outcomeCandidates.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const name = String(item.name || item.label || item.outcome || "").trim();
      if (!name) return;
      outcomeMap.set(name.toLowerCase(), {
        label: name,
        bid: Number(item.bid ?? item.bestBid ?? item.best_bid),
        ask: Number(item.ask ?? item.bestAsk ?? item.best_ask),
        mid: Number(item.mid ?? item.price ?? item.mark)
      });
    });

    const yes = outcomeMap.get("yes") || outcomeMap.get("up");
    const no = outcomeMap.get("no") || outcomeMap.get("down");

    if (yes || no) {
      return {
        slug,
        source: "bullpen",
        upOutcomeLabel: yes?.label || "Yes",
        downOutcomeLabel: no?.label || "No",
        upBid: Number.isFinite(yes?.bid) ? yes.bid : null,
        upAsk: Number.isFinite(yes?.ask) ? yes.ask : null,
        upMid: Number.isFinite(yes?.mid) ? yes.mid : null,
        downBid: Number.isFinite(no?.bid) ? no.bid : null,
        downAsk: Number.isFinite(no?.ask) ? no.ask : null,
        downMid: Number.isFinite(no?.mid) ? no.mid : null
      };
    }

    return null;
  }

  async getMarketBySlug(slug) {
    const attempts = [
      ["polymarket", "market", slug, "--output", "json"],
      ["polymarket", "event", slug, "--output", "json"]
    ];

    for (const args of attempts) {
      const result = await this.run(args);
      if (!result.ok) continue;
      const data = parseJsonSafe(result.stdout);
      const normalized = data ? normalizeBullpenMarket(data, slug) : null;
      if (normalized) return normalized;
    }

    return null;
  }

  async getCurrentMarket() {
    if (this.cachedCurrentMarket && Date.now() - this.cachedAt < 3000) {
      return this.cachedCurrentMarket;
    }

    const market = await resolveCurrentMarket(this);
    this.cachedCurrentMarket = market;
    this.cachedAt = Date.now();
    return market;
  }

  async fetchBookQuote(tokenId) {
    if (!tokenId) {
      return { bid: null, ask: null };
    }
    const resp = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {
      cache: "no-store"
    });
    if (!resp.ok) {
      throw new Error(`Book fetch failed for ${tokenId}: HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return {
      bid: bestBidFromBook(data),
      ask: bestAskFromBook(data)
    };
  }

  async getPrice(slug) {
    const targetSlug = slug || (await this.getCurrentMarket()).slug;
    const result = await this.run(["polymarket", "price", targetSlug, "--output", "json"]);
    if (result.ok) {
      const data = parseJsonSafe(result.stdout);
      const normalized = data ? this.extractPriceSnapshot(data, targetSlug) : null;
      if (normalized) return normalized;
    }

    const market = await this.getMarketBySlug(targetSlug) || await this.getCurrentMarket();
    const [upQuote, downQuote] = await Promise.all([
      this.fetchBookQuote(market?.upTokenId),
      this.fetchBookQuote(market?.downTokenId)
    ]);

    return {
      slug: targetSlug,
      source: "clob-fallback",
      upOutcomeLabel: market?.upOutcomeLabel || "Up",
      downOutcomeLabel: market?.downOutcomeLabel || "Down",
      upBid: upQuote.bid,
      upAsk: upQuote.ask,
      upMid: Number.isFinite(upQuote.bid) && Number.isFinite(upQuote.ask) ? (upQuote.bid + upQuote.ask) / 2 : null,
      downBid: downQuote.bid,
      downAsk: downQuote.ask,
      downMid: Number.isFinite(downQuote.bid) && Number.isFinite(downQuote.ask) ? (downQuote.bid + downQuote.ask) / 2 : null
    };
  }

  async getPositions() {
    const result = await this.run(["polymarket", "positions", "--output", "json"], { timeoutMs: 30000 });
    if (result.ok) {
      const data = parseJsonSafe(result.stdout);
      if (data) {
        return {
          ok: true,
          positions: Array.isArray(data.positions) ? data.positions : Array.isArray(data) ? data : [],
          raw: data
        };
      }
    }

    const fallback = await this.run(["polymarket", "positions"], { timeoutMs: 30000 });
    return {
      ok: fallback.ok,
      positions: [],
      raw: fallback.stdout || fallback.stderr
    };
  }

  async resolveOutcomeLabel(slug, side) {
    const normalizedSide = String(side || "").trim().toLowerCase();
    if (!["up", "down"].includes(normalizedSide)) {
      throw new Error("Outcome side must be 'up' or 'down'");
    }
    const market = await this.getMarketBySlug(slug) || await this.getCurrentMarket();
    if (!market || !market.slug) {
      throw new Error(`Could not resolve market metadata for ${slug}`);
    }
    return normalizedSide === "up" ? market.upOutcomeLabel || "Yes" : market.downOutcomeLabel || "No";
  }

  buildTradeArgs(action, slug, outcome, quantity, jsonOutput) {
    const args = ["polymarket", action, slug, outcome, quantity, "--yes"];
    if (jsonOutput) {
      args.push("--output", "json");
    }
    return args;
  }

  async executeTradeWithOutcomeAliases(action, { slug, side, quantity, fallbackLabel }) {
    const primaryOutcome = await this.resolveOutcomeLabel(slug, side);
    const jsonResult = await this.run(this.buildTradeArgs(action, slug, primaryOutcome, quantity, true), {
      timeoutMs: 45000
    });

    if (jsonResult.ok) {
      const data = parseJsonSafe(jsonResult.stdout);
      return {
        ok: true,
        orderId: data?.order_id || data?.orderId || data?.id || null,
        filled: data?.filled || data?.fill || null,
        raw: data || jsonResult.stdout,
        outcome: primaryOutcome
      };
    }

    const available = parseAvailableOutcomeLabels(jsonResult.error || jsonResult.stderr || jsonResult.stdout);
    const aliasOutcome = chooseOutcomeLabel(side, available);
    const retryOutcome = aliasOutcome && normalizeOutcomeName(aliasOutcome) !== normalizeOutcomeName(primaryOutcome)
      ? aliasOutcome
      : null;

    const outcomesToTry = retryOutcome ? [primaryOutcome, retryOutcome] : [primaryOutcome];
    let lastFailure = jsonResult;

    for (const outcome of outcomesToTry) {
      const fallback = await this.run(this.buildTradeArgs(action, slug, outcome, quantity, false), {
        timeoutMs: 45000
      });
      if (fallback.ok) {
        return {
          ok: true,
          outcome,
          ...this.parseTradeResult(fallback.stdout, fallbackLabel),
          raw: fallback.stdout
        };
      }
      lastFailure = fallback;
    }

    if (retryOutcome) {
      const retryJson = await this.run(this.buildTradeArgs(action, slug, retryOutcome, quantity, true), {
        timeoutMs: 45000
      });
      if (retryJson.ok) {
        const data = parseJsonSafe(retryJson.stdout);
        return {
          ok: true,
          orderId: data?.order_id || data?.orderId || data?.id || null,
          filled: data?.filled || data?.fill || null,
          raw: data || retryJson.stdout,
          outcome: retryOutcome
        };
      }
      lastFailure = retryJson;
    }

    throw new Error(lastFailure.error || "Bullpen trade command failed");
  }

  parseTradeResult(stdout, fallbackLabel) {
    const text = String(stdout || "");
    const orderIdMatch = text.match(/Order submitted successfully \(ID:\s*([^)]+)\)/i);
    const fillMatch = text.match(/Filled:\s*(.+)/i);
    return {
      orderId: orderIdMatch ? orderIdMatch[1].trim() : null,
      filled: fillMatch ? fillMatch[1].trim() : null,
      summary: text || fallbackLabel
    };
  }

  async placeBuy({ slug, side, amountUsd }) {
    const amount = Number(amountUsd);
    if (!slug) throw new Error("Missing market slug");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Buy amount must be greater than 0");
    return this.executeTradeWithOutcomeAliases("buy", {
      slug,
      side,
      quantity: amount.toFixed(2),
      fallbackLabel: "Buy submitted"
    });
  }

  async placeSell({ slug, side, amountUsd }) {
    const amount = Number(amountUsd);
    if (!slug) throw new Error("Missing market slug");
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Sell amount must be greater than 0");
    const price = await this.getPrice(slug);
    const normalizedSide = String(side || "").trim().toLowerCase();
    const bid = normalizedSide === "up" ? price.upBid : price.downBid;
    if (!Number.isFinite(bid) || bid <= 0) {
      throw new Error(`No bid available to convert ${amount.toFixed(2)} USDC into shares`);
    }

    const shares = amount / bid;
    const result = await this.executeTradeWithOutcomeAliases("sell", {
      slug,
      side,
      quantity: shares.toFixed(6),
      fallbackLabel: "Sell submitted"
    });
    return {
      ...result,
      shares: Number(shares.toFixed(6)),
      bid
    };
  }
}

module.exports = {
  BullpenAdapter
};
