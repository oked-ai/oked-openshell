// The OpenShell supervisor middleware gRPC server: Describe, ValidateConfig,
// EvaluateHttpRequest (proto/supervisor_middleware.proto, OpenShell v0.1.2).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { loadConfig, ENTRY_TTL_MINUTES, type Loaded } from "./config.js";
import { GithubEnricher } from "./enrich/github.js";
import { stdoutLogger, type Logger } from "./log.js";
import { CLIENT_NAME, OkedClient, type OkedApi } from "./oked-client.js";
import { Pipeline } from "./pipeline.js";
import { REASON_CODES, validateReasonCodes } from "./reason-codes.js";
import type { RawRequest } from "./types.js";

const PROTO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "proto");
const CONTRACT = "openshell.supervisor-middleware.contract";
const PROTOCOL = { major: 1, minor: 0 };
const VERSION = "0.1.0";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
// The gateway can send up to 4 MiB of body plus headers and context.
const MAX_RECEIVE_BYTES = Math.ceil(4.5 * 1024 * 1024);
const PRE_CREDENTIALS = "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS";

export function loadProto(): grpc.GrpcObject {
  const def = protoLoader.loadSync(join(PROTO_DIR, "supervisor_middleware.proto"), {
    keepCase: true,
    enums: String,
    longs: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(def);
}

export function middlewareService(proto: grpc.GrpcObject): grpc.ServiceClientConstructor {
  const pkg = (proto.openshell as grpc.GrpcObject).middleware as grpc.GrpcObject;
  return (pkg.v1 as grpc.GrpcObject).SupervisorMiddleware as grpc.ServiceClientConstructor;
}

type PeerMetadata = {
  protocol_version?: { major: number; minor: number } | null;
  supported_capabilities?: string[];
  required_capabilities?: string[];
};

// An error text, or null when the gateway metadata is compatible.
export function checkGateway(gateway: PeerMetadata | null | undefined): string | null {
  if (!gateway || !gateway.protocol_version) return "gateway metadata is missing";
  if (gateway.protocol_version.major !== PROTOCOL.major) {
    return `gateway protocol major ${gateway.protocol_version.major} is not ${PROTOCOL.major}`;
  }
  const missing = (gateway.required_capabilities ?? []).filter((c) => c !== CONTRACT);
  if (missing.length > 0) return `gateway requires unsupported capabilities: ${missing.join(", ")}`;
  if (!(gateway.supported_capabilities ?? []).includes(CONTRACT)) return `gateway does not support ${CONTRACT}`;
  return null;
}

function toRaw(req: any): RawRequest {
  const t = req.target ?? {};
  const ctx = req.context ?? {};
  return {
    sandboxId: String(ctx.sandbox_id ?? ""),
    sandbox: String(ctx.sandbox ?? ""),
    scheme: String(t.scheme ?? ""),
    host: String(t.host ?? ""),
    port: Number(t.port ?? 0),
    method: String(t.method ?? ""),
    path: String(t.path ?? ""),
    query: String(t.query ?? ""),
    headers: Array.isArray(req.headers) ? req.headers : [],
    body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  };
}

function deny(reasonCode: string, reason: string) {
  return { decision: "DECISION_DENY", reason, reason_code: reasonCode, metadata: {} };
}

export function createServer(pipeline: Pipeline, name: string, log: Logger): grpc.Server {
  const server = new grpc.Server({ "grpc.max_receive_message_length": MAX_RECEIVE_BYTES });
  server.addService(middlewareService(loadProto()).service, {
    Describe(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
      const problem = checkGateway(call.request.gateway);
      log({ event: "describe", gatewayVersion: call.request.gateway?.implementation_version ?? null, problem });
      if (problem) {
        cb({ code: grpc.status.FAILED_PRECONDITION, details: problem });
        return;
      }
      cb(null, {
        name,
        service_version: VERSION,
        bindings: [
          {
            operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST",
            phase: PRE_CREDENTIALS,
            max_payload_bytes: MAX_PAYLOAD_BYTES,
          },
        ],
        expected_audience: "",
        extension: {
          protocol_version: PROTOCOL,
          implementation_name: "oked/openshell",
          implementation_version: VERSION,
          supported_capabilities: [CONTRACT],
          required_capabilities: [CONTRACT],
        },
      });
    },

    // This middleware takes no per-policy config. All config is in oked-openshell.yaml.
    ValidateConfig(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
      const keys = Object.keys(call.request.config?.fields ?? {});
      log({ event: "validate_config", middlewareName: call.request.middleware_name, configKeys: keys });
      if (keys.length > 0) {
        cb(null, { valid: false, reason: "oked-approval takes no policy config. Put settings in oked-openshell.yaml." });
        return;
      }
      cb(null, { valid: true, reason: "" });
    },

    EvaluateHttpRequest(call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) {
      if (call.request.phase !== PRE_CREDENTIALS) {
        log({ event: "evaluate_error", error: `unsupported phase ${String(call.request.phase).slice(0, 60)}` });
        cb(null, deny(REASON_CODES.unavailable, "OKed: unsupported phase"));
        return;
      }
      pipeline
        .evaluate(toRaw(call.request))
        .then((r) =>
          cb(null, {
            decision: r.decision === "allow" ? "DECISION_ALLOW" : "DECISION_DENY",
            reason: r.reason,
            reason_code: r.reasonCode ?? "",
            metadata: r.metadata,
          }),
        )
        .catch(() => cb(null, deny(REASON_CODES.unavailable, "OKed: internal error")));
    },

    EvaluateWebSocketSession(call: grpc.ServerDuplexStream<any, any>) {
      call.emit("error", { code: grpc.status.UNIMPLEMENTED, details: "oked-approval does not bind WebSocket" });
    },
  });
  return server;
}

export function listen(server: grpc.Server, bind: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(bind, grpc.ServerCredentials.createInsecure(), (err, port) => (err ? reject(err) : resolve(port)));
  });
}

export function buildPipeline(loaded: Loaded, log: Logger, oked?: OkedApi): Pipeline {
  const { config, secrets } = loaded;
  const enricher = new GithubEnricher({
    apiUrl: config.github.api_url,
    token: secrets.githubToken,
    timeoutMs: config.github.lookup_timeout_ms,
    onLookup: (e) => log({ event: "github_lookup", ...e }),
  });
  const client =
    oked ??
    new OkedClient({
      apiUrl: config.oked.api_url,
      requireReceipt: config.oked.require_receipt,
      maxWaitMs: (config.approval.pending_window_minutes + 2) * 60_000,
    });
  return new Pipeline({ config, secrets, oked: client, enricher, log });
}

async function main(): Promise<void> {
  const log = stdoutLogger;
  const path = process.argv[2] ?? process.env.OKED_OPENSHELL_CONFIG ?? "oked-openshell.yaml";
  let loaded: Loaded;
  try {
    validateReasonCodes();
    loaded = loadConfig(path, process.env);
  } catch (e) {
    console.error(`oked-openshell: ${(e as Error).message}`);
    process.exit(2);
  }
  const pipeline = buildPipeline(loaded, log);
  const server = createServer(pipeline, loaded.config.name, log);
  const port = await listen(server, loaded.config.listen);
  const { config, secrets } = loaded;
  log({
    event: "start",
    client: CLIENT_NAME,
    name: config.name,
    listen: config.listen,
    port,
    okedApi: config.oked.api_url,
    approverGroups: [...secrets.okedKeys.keys()],
    githubEnrichment: secrets.githubToken !== null,
    rules: config.rules.length,
    pendingWindowMinutes: config.approval.pending_window_minutes,
    grantValidMinutes: config.approval.grant_valid_minutes,
    entryTtlMinutes: ENTRY_TTL_MINUTES,
    stateFile: config.approval.state_file,
    restoredEntries: pipeline.state.size,
  });
  const stop = () => {
    pipeline.close();
    server.tryShutdown(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
