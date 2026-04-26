import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

type OcppCall = [2, string, string, Record<string, unknown>];
type OcppCallResult = [3, string, Record<string, unknown>];
type OcppCallError = [4, string, string, string, Record<string, unknown>];

type ClientContext = {
  chargePointId: string;
  transactionId?: number;
};

const OCPP_HOST = process.env.OCPP_HOST ?? '0.0.0.0';
const OCPP_PORT = Number(process.env.OCPP_PORT ?? 9100);
const OCPP_PATH_PREFIX = process.env.OCPP_PATH_PREFIX ?? '/ocpp';
const HEARTBEAT_INTERVAL_SECONDS = Number(process.env.OCPP_HEARTBEAT_INTERVAL ?? 30);

if (!Number.isInteger(OCPP_PORT) || OCPP_PORT < 1 || OCPP_PORT > 65535) {
  throw new Error('OCPP_PORT must be a valid TCP port (1-65535).');
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use WebSocket OCPP endpoint.' }));
});

const wss = new WebSocketServer({
  server: httpServer,
  path: undefined,
  handleProtocols: (protocols) => {
    if (protocols.has('ocpp1.6')) {
      return 'ocpp1.6';
    }
    return false;
  },
});

function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildCallResult(uniqueId: string, payload: Record<string, unknown>): OcppCallResult {
  return [3, uniqueId, payload];
}

function buildCallError(
  uniqueId: string,
  code: string,
  description: string,
  details: Record<string, unknown> = {},
): OcppCallError {
  return [4, uniqueId, code, description, details];
}

function getChargePointId(urlPath: string): string {
  const cleanPath = urlPath.split('?')[0];
  const segments = cleanPath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unknown-cp';
}

function isAllowedPath(urlPath: string): boolean {
  return urlPath.startsWith(`${OCPP_PATH_PREFIX}/`);
}

function safeSend(ws: WebSocket, frame: OcppCallResult | OcppCallError): void {
  ws.send(JSON.stringify(frame));
}

function handleOcppCall(ws: WebSocket, ctx: ClientContext, frame: OcppCall): void {
  const [, uniqueId, action, payload] = frame;

  switch (action) {
    case 'BootNotification': {
      const response = buildCallResult(uniqueId, {
        currentTime: utcNowIso(),
        interval: HEARTBEAT_INTERVAL_SECONDS,
        status: 'Accepted',
      });
      safeSend(ws, response);
      console.log(`[${ctx.chargePointId}] BootNotification accepted`, payload);
      return;
    }

    case 'Heartbeat': {
      safeSend(ws, buildCallResult(uniqueId, { currentTime: utcNowIso() }));
      return;
    }

    case 'Authorize': {
      safeSend(ws, buildCallResult(uniqueId, { idTagInfo: { status: 'Accepted' } }));
      return;
    }

    case 'StatusNotification': {
      safeSend(ws, buildCallResult(uniqueId, {}));
      console.log(`[${ctx.chargePointId}] StatusNotification`, payload);
      return;
    }

    case 'MeterValues': {
      safeSend(ws, buildCallResult(uniqueId, {}));
      console.log(`[${ctx.chargePointId}] MeterValues`, payload);
      return;
    }

    case 'SecurityEventNotification':
    case 'DiagnosticsStatusNotification':
    case 'FirmwareStatusNotification': {
      safeSend(ws, buildCallResult(uniqueId, {}));
      console.log(`[${ctx.chargePointId}] ${action}`, payload);
      return;
    }

    case 'StartTransaction': {
      ctx.transactionId = Date.now();
      safeSend(
        ws,
        buildCallResult(uniqueId, {
          transactionId: ctx.transactionId,
          idTagInfo: { status: 'Accepted' },
        }),
      );
      console.log(`[${ctx.chargePointId}] StartTransaction accepted`, payload);
      return;
    }

    case 'StopTransaction': {
      safeSend(ws, buildCallResult(uniqueId, { idTagInfo: { status: 'Accepted' } }));
      console.log(`[${ctx.chargePointId}] StopTransaction`, payload);
      ctx.transactionId = undefined;
      return;
    }

    default: {
      safeSend(
        ws,
        buildCallError(uniqueId, 'NotImplemented', `Action ${action} is not implemented by this local test server.`),
      );
      console.warn(`[${ctx.chargePointId}] Unsupported action: ${action}`);
    }
  }
}

wss.on('connection', (ws, req) => {
  const requestPath = req.url ?? '/';

  if (!isAllowedPath(requestPath)) {
    console.warn(`Rejected path: ${requestPath}`);
    ws.close(1008, 'Invalid OCPP path');
    return;
  }

  const ctx: ClientContext = {
    chargePointId: getChargePointId(requestPath),
  };

  console.log(`OCPP connection opened for ${ctx.chargePointId} (${req.socket.remoteAddress ?? 'unknown'})`);

  ws.on('message', (raw) => {
    const text = raw.toString();

    try {
      const parsed = JSON.parse(text);

      if (!Array.isArray(parsed) || parsed.length < 3) {
        console.warn(`[${ctx.chargePointId}] Invalid OCPP frame`, parsed);
        return;
      }

      const messageType = parsed[0];

      if (messageType === 2) {
        handleOcppCall(ws, ctx, parsed as OcppCall);
        return;
      }

      if (messageType === 3) {
        console.log(`[${ctx.chargePointId}] CALLRESULT`, parsed);
        return;
      }

      if (messageType === 4) {
        console.warn(`[${ctx.chargePointId}] CALLERROR`, parsed);
        return;
      }

      console.warn(`[${ctx.chargePointId}] Unknown OCPP message type`, parsed);
    } catch (error) {
      console.error(`[${ctx.chargePointId}] Could not parse message`, text, error);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`OCPP connection closed for ${ctx.chargePointId} (${code}) ${reason.toString()}`);
  });

  ws.on('error', (error) => {
    console.error(`OCPP socket error for ${ctx.chargePointId}:`, error);
  });
});

httpServer.listen(OCPP_PORT, OCPP_HOST, () => {
  console.log(`OCPP 1.6 local server listening on ws://${OCPP_HOST}:${OCPP_PORT}${OCPP_PATH_PREFIX}/<chargePointId>`);
});
