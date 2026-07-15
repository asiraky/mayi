export type PublicUrlValidationErrorCode =
  | "invalid_url"
  | "https_required"
  | "credentials_forbidden"
  | "default_port_required"
  | "internal_hostname"
  | "dns_resolution_failed"
  | "non_public_address";

export class PublicUrlValidationError extends Error {
  readonly code: PublicUrlValidationErrorCode;

  constructor(code: PublicUrlValidationErrorCode, message: string) {
    super(message);
    this.name = "PublicUrlValidationError";
    this.code = code;
  }
}

export type ResolvedAddress = {
  address: string;
  family?: number;
};

export type PublicUrlResolver = (hostname: string) => Promise<readonly (ResolvedAddress | string)[]>;

export type ValidatedPublicUrl = {
  /** Parsed URL. Keep the originally registered string separately for exact matching. */
  url: URL;
  /** Every address returned by the validation-time lookup, deduplicated in resolver order. */
  addresses: readonly string[];
  /** Address selected for a delivery implementation that can pin a connection. */
  pinnedAddress: string;
  /** Fetch-compatible redirect policy. Callback delivery must not follow redirects. */
  redirect: "error";
};

export type PublicUrlValidationOptions = {
  resolve?: PublicUrlResolver;
};

export type ValidatePublicHttpsUrlOptions = PublicUrlValidationOptions;

const INTERNAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home", "home.arpa"] as const;

const IPV4_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // "this" network
  [0x0a000000, 8], // private
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // private
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc01fc400, 24], // AS112-v4
  [0xc034c100, 24], // AMT
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // private
  [0xc0af3000, 24], // direct delegation AS112 service
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved and limited broadcast
];

const IPV6_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [bigint, number]> = [
  [0x20010000000000000000000000000000n, 23], // IETF protocol assignments
  [0x20010db8000000000000000000000000n, 32], // documentation
  [0x20020000000000000000000000000000n, 16], // 6to4 (can tunnel private IPv4)
  [0x3fff0000000000000000000000000000n, 20], // documentation
];

function inIpv4Cidr(address: number, network: number, prefixLength: number): boolean {
  const shift = 32 - prefixLength;
  return address >>> shift === network >>> shift;
}

function parseIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function parseIpv6(address: string): bigint | undefined {
  if (address.includes("%")) return undefined;

  let input = address.toLowerCase();
  const ipv4Tail = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === undefined) return undefined;
    input = `${input.slice(0, -ipv4Tail.length)}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return undefined;

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;

  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return undefined;
  const groups = [...left, ...Array<string>(omitted).fill("0"), ...right];
  if (groups.length !== 8) return undefined;

  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Cidr(address: bigint, network: bigint, prefixLength: number): boolean {
  const shift = BigInt(128 - prefixLength);
  return address >> shift === network >> shift;
}

/** Returns true only for an IPv4 or IPv6 address suitable for an outbound public connection. */
export function isPublicIpAddress(address: string): boolean {
  const family = parseIpv4(address) !== undefined ? 4 : parseIpv6(address) !== undefined ? 6 : 0;
  if (family === 4) {
    const value = parseIpv4(address);
    return value !== undefined && !IPV4_NON_PUBLIC_CIDRS.some(([network, prefix]) => inIpv4Cidr(value, network, prefix));
  }

  if (family === 6) {
    const value = parseIpv6(address);
    if (value === undefined) return false;

    // Globally routable unicast space is 2000::/3. Explicit exclusions cover
    // special-use ranges that sit inside it.
    const globalUnicast = inIpv6Cidr(value, 0x20000000000000000000000000000000n, 3);
    return globalUnicast && !IPV6_NON_PUBLIC_CIDRS.some(([network, prefix]) => inIpv6Cidr(value, network, prefix));
  }

  return false;
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isInternalHostname(hostname: string): boolean {
  return INTERNAL_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

const systemResolver: PublicUrlResolver = async (hostname) => {
  const dns = await import("node:dns/promises");
  return dns.lookup(hostname, { all: true, verbatim: true });
};

/**
 * Validates a URL for a direct public HTTPS callback.
 *
 * DNS is deliberately injectable so registration and delivery can apply the
 * same policy in runtimes with different resolver APIs. Delivery must resolve
 * again and, where its HTTP client permits it, connect to `pinnedAddress` while
 * preserving the URL hostname for TLS SNI and the Host header.
 */
export async function validatePublicHttpsUrl(
  value: string,
  options: ValidatePublicHttpsUrlOptions = {},
): Promise<ValidatedPublicUrl> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicUrlValidationError("invalid_url", "Callback URL is invalid");
  }

  if (url.protocol !== "https:") {
    throw new PublicUrlValidationError("https_required", "Callback URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new PublicUrlValidationError("credentials_forbidden", "Callback URL must not contain credentials");
  }
  if (url.port && url.port !== "443") {
    throw new PublicUrlValidationError("default_port_required", "Callback URL must use the default HTTPS port");
  }

  const hostname = normalizedHostname(url);
  if (isInternalHostname(hostname)) {
    throw new PublicUrlValidationError("internal_hostname", "Callback hostname must be public");
  }

  let resolved: readonly (ResolvedAddress | string)[];
  if (parseIpv4(hostname) !== undefined || parseIpv6(hostname) !== undefined) {
    resolved = [hostname];
  } else {
    try {
      resolved = await (options.resolve ?? systemResolver)(hostname);
    } catch {
      throw new PublicUrlValidationError("dns_resolution_failed", "Callback hostname must resolve to public addresses");
    }
  }

  const addresses = [...new Set(resolved.map((entry) => typeof entry === "string" ? entry : entry.address))];
  if (addresses.length === 0) {
    throw new PublicUrlValidationError("dns_resolution_failed", "Callback hostname must resolve to public addresses");
  }
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    throw new PublicUrlValidationError("non_public_address", "Callback hostname must resolve exclusively to public addresses");
  }

  return {
    url,
    addresses,
    pinnedAddress: addresses[0]!,
    redirect: "error",
  };
}
