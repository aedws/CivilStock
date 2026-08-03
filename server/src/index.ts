/**
 * CivilStock 권위 API 서버(Cloud Run) + 최소 웹 UI. node:http 라우터.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config";
import { HttpError } from "./errors";
import { placeOrder, cancelOrder, provideLiquidity } from "./trade";
import { createAccount, issueEquity, issueBond, issueEtf } from "./issue";
import { declareDividend, splitShares } from "./actions";
import { runDueTicks, getWorld } from "./tick";
import { foundNation } from "./nations";
import { listSecurities, getAccount, getMarket, listNations, getNationDetail } from "./queries";

const here = dirname(fileURLToPath(import.meta.url));
let indexHtml = "";
try {
  indexHtml = readFileSync(join(here, "..", "public", "index.html"), "utf8");
} catch {
  indexHtml = "<h1>CivilStock</h1><p>UI not found.</p>";
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) throw new HttpError(400, `missing field: ${key}`);
  return v;
}
function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && p === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(indexHtml);
    }
    if (method === "GET" && p === "/healthz") return send(res, 200, { ok: true });
    if (method === "GET" && p === "/world") return send(res, 200, await getWorld());
    if (method === "GET" && p === "/securities") return send(res, 200, await listSecurities());
    if (method === "GET" && p === "/nations") return send(res, 200, await listNations());
    if (method === "GET" && p === "/nation") return send(res, 200, await getNationDetail(str(Object.fromEntries(url.searchParams), "id")));
    if (method === "GET" && p === "/account") return send(res, 200, await getAccount(str(Object.fromEntries(url.searchParams), "userId")));
    if (method === "GET" && p === "/market") return send(res, 200, await getMarket(str(Object.fromEntries(url.searchParams), "securityId")));

    if (method === "POST" && p === "/nations") {
      const b = await readJson(req);
      return send(res, 200, await foundNation({ id: str(b, "id"), name: str(b, "name"), currency: str(b, "currency"), ownerId: str(b, "ownerId"), grantCash: optStr(b, "grantCash") }));
    }
    if (method === "POST" && p === "/accounts") {
      const b = await readJson(req);
      return send(res, 200, await createAccount({ userId: str(b, "userId"), handle: optStr(b, "handle"), grantCash: optStr(b, "grantCash"), currency: optStr(b, "currency") }));
    }
    if (method === "POST" && p === "/issue/equity") {
      const b = await readJson(req);
      return send(res, 200, await issueEquity({ id: str(b, "id"), ticker: str(b, "ticker"), issuerUserId: str(b, "issuerUserId"), currency: str(b, "currency"), nationId: optStr(b, "nationId") ?? null, exchangeId: optStr(b, "exchangeId") ?? null, sharesOutstanding: str(b, "sharesOutstanding") }));
    }
    if (method === "POST" && p === "/issue/bond") {
      const b = await readJson(req);
      return send(res, 200, await issueBond({ id: str(b, "id"), ticker: str(b, "ticker"), issuerUserId: str(b, "issuerUserId"), currency: str(b, "currency"), faceValue: str(b, "faceValue"), couponRate: str(b, "couponRate"), maturityTick: Number(b.maturityTick), couponIntervalTicks: Number(b.couponIntervalTicks), unitsIssued: str(b, "unitsIssued") }));
    }
    if (method === "POST" && p === "/issue/etf") {
      const b = await readJson(req);
      const constituents = Array.isArray(b.constituents) ? (b.constituents as Array<{ securityId: string; unitsPerShare: string }>) : [];
      return send(res, 200, await issueEtf({ id: str(b, "id"), ticker: str(b, "ticker"), issuerUserId: str(b, "issuerUserId"), currency: str(b, "currency"), constituents }));
    }
    if (method === "POST" && p === "/pools/liquidity") {
      const b = await readJson(req);
      return send(res, 200, await provideLiquidity({ securityId: str(b, "securityId"), providerId: str(b, "providerId"), baseIn: str(b, "baseIn"), quoteIn: str(b, "quoteIn"), feeBps: typeof b.feeBps === "number" ? b.feeBps : undefined }));
    }
    if (method === "POST" && p === "/actions/dividend") {
      const b = await readJson(req);
      return send(res, 200, await declareDividend({ securityId: str(b, "securityId"), issuerId: str(b, "issuerId"), perShare: str(b, "perShare") }));
    }
    if (method === "POST" && p === "/actions/split") {
      const b = await readJson(req);
      return send(res, 200, await splitShares({ securityId: str(b, "securityId"), issuerId: str(b, "issuerId"), ratio: Number(b.ratio) }));
    }
    if (method === "POST" && p === "/orders") {
      const b = await readJson(req);
      const side = str(b, "side");
      if (side !== "buy" && side !== "sell") throw new HttpError(400, "side must be buy|sell");
      return send(res, 200, await placeOrder({ orderId: str(b, "orderId"), securityId: str(b, "securityId"), ownerId: str(b, "ownerId"), quantity: str(b, "quantity"), side, limitPrice: optStr(b, "limitPrice") ?? null }));
    }
    if (method === "POST" && p === "/orders/cancel") {
      const b = await readJson(req);
      return send(res, 200, await cancelOrder({ orderId: str(b, "orderId"), ownerId: optStr(b, "ownerId") }));
    }
    if (method === "POST" && p === "/tick") {
      if (!config.tickSecret || req.headers["x-tick-secret"] !== config.tickSecret) throw new HttpError(401, "unauthorized");
      return send(res, 200, await runDueTicks());
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    console.error("unhandled error", error);
    return send(res, 500, { error: "internal error" });
  }
});

server.listen(config.port, () => {
  console.log(`CivilStock authoritative server listening on :${config.port}`);
});
