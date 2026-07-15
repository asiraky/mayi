import { canonicalize } from "@mayi/contracts";
import { CompactSign, importJWK } from "jose";
import { createError } from "h3";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import {
  validatePublicHttpsUrl,
  type ValidatePublicHttpsUrlOptions,
  type ValidatedPublicUrl,
} from "./public-url";
import { signingKeys } from "./signer";

export const FORWARDING_CONNECT_TIMEOUT_MS = 3_000;
export const FORWARDING_RESPONSE_TIMEOUT_MS = 5_000;
export const FORWARDING_TOTAL_TIMEOUT_MS = 10_000;
export const FORWARDING_MAX_RESPONSE_BYTES = 64 * 1024;

export async function validateOutboundUrl(
  value: string,
  options: ValidatePublicHttpsUrlOptions = {},
): Promise<ValidatedPublicUrl> {
  try {
    return await validatePublicHttpsUrl(value, options);
  } catch (error) {
    throw createError({
      statusCode: 422,
      statusMessage: error instanceof Error ? error.message.replace("Callback", "Webhook") : "Webhook URL is not public",
    });
  }
}

export type ForwardingHttpResponse = {
  status: number;
  body: Uint8Array;
};

export type ForwardingRequest = {
  body: string;
  headers?: Readonly<Record<string, string>>;
  maxResponseBytes?: number;
};

export type NodeForwardingRequest = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export type NodeForwardingTransportOptions = {
  request?: NodeForwardingRequest;
  isIP?: (value: string) => number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/**
 * Connects to the address selected by URL validation while preserving the
 * original hostname for HTTP Host and TLS certificate verification. This is
 * deliberately a Node transport: runtimes without address pinning fail closed.
 */
export async function deliverForwardingHttpNode(
  target: ValidatedPublicUrl,
  input: ForwardingRequest,
  options: NodeForwardingTransportOptions = {},
): Promise<ForwardingHttpResponse> {
  const request = options.request ?? (await import("node:https")).request as NodeForwardingRequest;
  const isIP = options.isIP ?? (await import("node:net")).isIP;
  const connectTimeoutMs = options.connectTimeoutMs ?? FORWARDING_CONNECT_TIMEOUT_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? FORWARDING_RESPONSE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? FORWARDING_TOTAL_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? FORWARDING_MAX_RESPONSE_BYTES;
  const originalHostname = target.url.hostname.replace(/^\[|\]$/g, "");

  return new Promise((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const connected = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = undefined;
    };
    const finish = (error?: Error, response?: ForwardingHttpResponse) => {
      if (settled) return;
      settled = true;
      connected();
      clearTimeout(totalTimer);
      if (error) reject(error);
      else resolve(response!);
    };
    const totalTimer = setTimeout(() => {
      finish(new Error("Forwarding request timed out"));
      req?.destroy();
    }, totalTimeoutMs);
    connectTimer = setTimeout(() => {
      finish(new Error("Forwarding request connection timed out"));
      req?.destroy();
    }, connectTimeoutMs);

    try {
      req = request({
        protocol: "https:",
        hostname: target.pinnedAddress,
        port: target.url.port ? Number(target.url.port) : 443,
        method: "POST",
        path: `${target.url.pathname}${target.url.search}`,
        servername: isIP(originalHostname) ? undefined : originalHostname,
        headers: {
          ...input.headers,
          host: target.url.host,
          "content-length": Buffer.byteLength(input.body),
        },
      }, (response) => {
        response.setTimeout(responseTimeoutMs, () => {
          response.destroy();
          finish(new Error("Forwarding response timed out"));
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > maxResponseBytes) {
            response.destroy();
            finish(new Error("Forwarding response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(undefined, {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks, bytes),
        }));
        response.on("error", () => finish(new Error("Forwarding response failed")));
      });
      req.once("socket", (socket) => {
        const tlsSocket = socket as typeof socket & { encrypted?: boolean; secureConnecting?: boolean };
        if (tlsSocket.encrypted && !tlsSocket.connecting && tlsSocket.secureConnecting === false) connected();
        else tlsSocket.once("secureConnect", connected);
      });
      req.on("error", () => finish(new Error("Forwarding request failed")));
      req.end(input.body);
    } catch {
      finish(new Error("Forwarding request failed"));
    }
  });
}

export async function deliverForwardingHttp(
  target: ValidatedPublicUrl,
  input: ForwardingRequest,
): Promise<ForwardingHttpResponse> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new Error("Forwarding delivery requires an outbound transport with DNS pinning");
  }
  return deliverForwardingHttpNode(target, input);
}

export async function signWebhook(payload: unknown): Promise<string> {
  const keys = await signingKeys();
  const key = await importJWK(keys.privateJwk, "EdDSA");
  return new CompactSign(new TextEncoder().encode(canonicalize(payload)))
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ: "mayi-webhook+jws" }).sign(key);
}
