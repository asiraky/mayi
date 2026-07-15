import {
  CALLBACK_ACCEPTANCE_WINDOW_SECONDS as CONTRACT_CALLBACK_ACCEPTANCE_WINDOW_SECONDS,
  MAX_CALLBACK_STATE_LENGTH,
  SealedCallbackStateEnvelope as SealedCallbackStateEnvelopeSchema,
  canonicalize,
} from "@mayi/contracts";
import type { SealedCallbackStateEnvelope } from "./public-contracts";

const CALLBACK_STATE_VERSION = 1;
const AES_GCM_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const MAX_PLAINTEXT_BYTES = 24_000;
const MAX_RETRY_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_CALLBACK_STATE_KEYS = 16;
const KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Shared server/consumer window for automatic delivery and operator replay. */
export const CALLBACK_ACCEPTANCE_WINDOW_SECONDS = CONTRACT_CALLBACK_ACCEPTANCE_WINDOW_SECONDS;

export type CallbackStateKeyMaterial = string | Uint8Array;

export interface CallbackStateKey {
  kid: string;
  key: CallbackStateKeyMaterial;
}

export interface CallbackStateCodecOptions {
  currentKey: CallbackStateKey;
  previousKeys?: CallbackStateKey[];
  maximumRetryWindowSeconds: number;
  now?: () => number;
}

export interface SealCallbackStateOptions {
  approvalExpiresAt: string | number | Date;
}

export interface CallbackStateCodec {
  seal(payload: unknown, options: SealCallbackStateOptions): Promise<string>;
  open<T = unknown>(state: string): Promise<T>;
}

export type CallbackStateConfigurationErrorCode =
  | "INVALID_CURRENT_KEY"
  | "INVALID_PREVIOUS_KEY"
  | "DUPLICATE_KEY_ID"
  | "INVALID_RETRY_WINDOW"
  | "CRYPTO_UNAVAILABLE";

export class CallbackStateConfigurationError extends Error {
  readonly code: CallbackStateConfigurationErrorCode;

  constructor(code: CallbackStateConfigurationErrorCode) {
    const messages: Record<CallbackStateConfigurationErrorCode, string> = {
      INVALID_CURRENT_KEY: "The current callback-state key configuration is invalid",
      INVALID_PREVIOUS_KEY: "A previous callback-state key configuration is invalid",
      DUPLICATE_KEY_ID: "Callback-state key identifiers must be unique",
      INVALID_RETRY_WINDOW: "The callback-state retry window is invalid",
      CRYPTO_UNAVAILABLE: "AES-256-GCM is unavailable in this runtime",
    };
    super(messages[code]);
    this.name = "CallbackStateConfigurationError";
    this.code = code;
  }
}

export type CallbackStateErrorCode =
  | "INVALID_PAYLOAD"
  | "INVALID_EXPIRY"
  | "STATE_TOO_LARGE"
  | "INVALID_STATE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_KEY"
  | "EXPIRED";

export class CallbackStateError extends Error {
  readonly code: CallbackStateErrorCode;

  constructor(code: CallbackStateErrorCode) {
    const messages: Record<CallbackStateErrorCode, string> = {
      INVALID_PAYLOAD: "The callback-state payload is invalid",
      INVALID_EXPIRY: "The callback-state expiry is invalid",
      STATE_TOO_LARGE: "The callback state exceeds the supported size",
      INVALID_STATE: "The callback state is invalid or could not be authenticated",
      UNSUPPORTED_VERSION: "The callback-state version is unsupported",
      UNKNOWN_KEY: "The callback-state key is not available",
      EXPIRED: "The callback state has expired",
    };
    super(messages[code]);
    this.name = "CallbackStateError";
    this.code = code;
  }
}

interface OpenKey {
  kid: string;
  key: CryptoKey;
}

interface InternalState {
  version: 1;
  expiresAt: number;
  payload: unknown;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytesToBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function keyBytes(material: CallbackStateKeyMaterial): Uint8Array | undefined {
  if (typeof material === "string") return base64UrlToBytes(material);
  if (material instanceof Uint8Array) return Uint8Array.from(material);
  return undefined;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function validKeyDefinition(value: CallbackStateKey | undefined): value is CallbackStateKey {
  return Boolean(value && typeof value === "object" && typeof value.kid === "string" && KID_PATTERN.test(value.kid));
}

function additionalData(kid: string): Uint8Array {
  return new TextEncoder().encode(canonicalize({ kid, version: CALLBACK_STATE_VERSION }));
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new CallbackStateError("INVALID_EXPIRY");
  return value;
}

function parseExpiry(value: string | number | Date): number {
  const expiry = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
      ? Date.parse(value)
      : value;
  if (!Number.isFinite(expiry)) throw new CallbackStateError("INVALID_EXPIRY");
  return expiry;
}

function parseInternalState(bytes: Uint8Array): InternalState {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CallbackStateError("INVALID_STATE");
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 3
    || (value as Record<string, unknown>).version !== CALLBACK_STATE_VERSION
    || !Number.isSafeInteger((value as Record<string, unknown>).expiresAt)
    || !("payload" in value)
  ) throw new CallbackStateError("INVALID_STATE");
  return value as unknown as InternalState;
}

async function importKey(definition: CallbackStateKey, usages: KeyUsage[]): Promise<OpenKey> {
  const bytes = keyBytes(definition.key);
  if (!bytes || bytes.byteLength !== AES_GCM_KEY_BYTES) throw new Error("invalid key");
  const key = await crypto.subtle.importKey("raw", arrayBuffer(bytes), { name: "AES-GCM", length: 256 }, false, usages);
  return { kid: definition.kid, key };
}

export async function createCallbackStateCodec(options: CallbackStateCodecOptions): Promise<CallbackStateCodec> {
  if (!options || typeof options !== "object" || !validKeyDefinition(options.currentKey)) {
    throw new CallbackStateConfigurationError("INVALID_CURRENT_KEY");
  }
  if (
    !Number.isSafeInteger(options.maximumRetryWindowSeconds)
    || options.maximumRetryWindowSeconds < 0
    || options.maximumRetryWindowSeconds > MAX_RETRY_WINDOW_SECONDS
  ) throw new CallbackStateConfigurationError("INVALID_RETRY_WINDOW");
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new CallbackStateConfigurationError("CRYPTO_UNAVAILABLE");
  }

  const previous = options.previousKeys ?? [];
  if (
    !Array.isArray(previous)
    || previous.length >= MAX_CALLBACK_STATE_KEYS
    || previous.some((item) => !validKeyDefinition(item))
  ) {
    throw new CallbackStateConfigurationError("INVALID_PREVIOUS_KEY");
  }
  const identifiers = new Set([options.currentKey.kid]);
  for (const item of previous) {
    if (identifiers.has(item.kid)) throw new CallbackStateConfigurationError("DUPLICATE_KEY_ID");
    identifiers.add(item.kid);
  }

  let current: OpenKey;
  let previousImported: OpenKey[];
  try {
    current = await importKey(options.currentKey, ["encrypt", "decrypt"]);
  } catch {
    throw new CallbackStateConfigurationError("INVALID_CURRENT_KEY");
  }
  try {
    previousImported = await Promise.all(previous.map((item) => importKey(item, ["decrypt"])));
  } catch {
    throw new CallbackStateConfigurationError("INVALID_PREVIOUS_KEY");
  }
  const keys = new Map([current, ...previousImported].map((item) => [item.kid, item.key]));
  const now = options.now ?? Date.now;

  return {
    async seal(payload, sealOptions) {
      if (!sealOptions || typeof sealOptions !== "object") throw new CallbackStateError("INVALID_EXPIRY");
      const approvalExpiry = parseExpiry(sealOptions.approvalExpiresAt);
      const currentTime = safeNow(now);
      const expiresAt = approvalExpiry + options.maximumRetryWindowSeconds * 1_000;
      if (!Number.isSafeInteger(expiresAt) || approvalExpiry <= currentTime || expiresAt <= currentTime) {
        throw new CallbackStateError("INVALID_EXPIRY");
      }

      let plaintext: Uint8Array;
      try {
        plaintext = new TextEncoder().encode(canonicalize({ version: CALLBACK_STATE_VERSION, expiresAt, payload }));
      } catch {
        throw new CallbackStateError("INVALID_PAYLOAD");
      }
      if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new CallbackStateError("STATE_TOO_LARGE");

      const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
      let encrypted: ArrayBuffer;
      try {
        encrypted = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: arrayBuffer(nonce),
            additionalData: arrayBuffer(additionalData(current.kid)),
            tagLength: 128,
          },
          current.key,
          arrayBuffer(plaintext),
        );
      } catch {
        throw new CallbackStateError("INVALID_STATE");
      }
      const envelope: SealedCallbackStateEnvelope = {
        version: CALLBACK_STATE_VERSION,
        kid: current.kid,
        nonce: bytesToBase64Url(nonce),
        ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
      };
      const state = canonicalize(envelope);
      if (envelope.ciphertext.length > MAX_CALLBACK_STATE_LENGTH || state.length > MAX_CALLBACK_STATE_LENGTH) {
        throw new CallbackStateError("STATE_TOO_LARGE");
      }
      return state;
    },

    async open<T = unknown>(state: string): Promise<T> {
      if (typeof state !== "string" || state.length === 0) throw new CallbackStateError("INVALID_STATE");
      if (state.length > MAX_CALLBACK_STATE_LENGTH) throw new CallbackStateError("STATE_TOO_LARGE");

      let rawEnvelope: unknown;
      try {
        rawEnvelope = JSON.parse(state);
      } catch {
        throw new CallbackStateError("INVALID_STATE");
      }
      if (
        rawEnvelope
        && typeof rawEnvelope === "object"
        && !Array.isArray(rawEnvelope)
        && "version" in rawEnvelope
        && (rawEnvelope as { version?: unknown }).version !== CALLBACK_STATE_VERSION
      ) throw new CallbackStateError("UNSUPPORTED_VERSION");
      const parsedEnvelope = SealedCallbackStateEnvelopeSchema.safeParse(rawEnvelope);
      if (!parsedEnvelope.success) throw new CallbackStateError("INVALID_STATE");
      const envelope = parsedEnvelope.data;
      const key = keys.get(envelope.kid);
      if (!key) throw new CallbackStateError("UNKNOWN_KEY");
      const nonce = base64UrlToBytes(envelope.nonce);
      const ciphertext = base64UrlToBytes(envelope.ciphertext);
      if (
        !nonce
        || nonce.byteLength !== AES_GCM_NONCE_BYTES
        || !ciphertext
        || ciphertext.byteLength < 16
        || ciphertext.byteLength > MAX_PLAINTEXT_BYTES + 16
      ) throw new CallbackStateError("INVALID_STATE");

      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: arrayBuffer(nonce),
            additionalData: arrayBuffer(additionalData(envelope.kid)),
            tagLength: 128,
          },
          key,
          arrayBuffer(ciphertext),
        );
      } catch {
        throw new CallbackStateError("INVALID_STATE");
      }
      const internal = parseInternalState(new Uint8Array(plaintext));
      if (internal.expiresAt <= safeNow(now)) throw new CallbackStateError("EXPIRED");
      return internal.payload as T;
    },
  };
}
