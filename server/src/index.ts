/**
 * CivilStock 권위 API 서버(Cloud Run). node:http 최소 라우터.
 *
 * 엔드포인트:
 *   GET  /healthz          — 헬스체크(Cloud Run 프로브).
 *   POST /orders           — 주문 접수(CLOB+AMM 최선체결·정산).
 *   POST /tick             — worldTick(Cloud Scheduler 전용, TICK_SECRET 인증).
 */
import http from "node:http";
import { config } from "./config";
import { HttpError, placeOrder, runTick, type PlaceOrderInput } from "./handlers";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
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

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `missing field: ${key}`);
  return value;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/orders") {
      const body = await readJson(req);
      const side = requireString(body, "side");
      if (side !== "buy" && side !== "sell") throw new HttpError(400, "side must be buy|sell");
      const input: PlaceOrderInput = {
        orderId: requireString(body, "orderId"),
        securityId: requireString(body, "securityId"),
        ownerId: requireString(body, "ownerId"),
        quantity: requireString(body, "quantity"),
        side,
        limitPrice: typeof body.limitPrice === "string" ? body.limitPrice : null,
      };
      const result = await placeOrder(input);
      return send(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/tick") {
      if (!config.tickSecret || req.headers["x-tick-secret"] !== config.tickSecret) {
        throw new HttpError(401, "unauthorized");
      }
      const body = await readJson(req);
      const tick = Number(body.tick);
      if (!Number.isSafeInteger(tick) || tick < 0) throw new HttpError(400, "tick must be a non-negative integer");
      const result = await runTick(tick);
      return send(res, 200, result);
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
