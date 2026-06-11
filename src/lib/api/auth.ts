import { ethers, TypedDataEncoder } from 'ethers';
import crypto from 'crypto';
import { ApiCredentials } from '../types';

// Nonce state for V3 EIP-712 (microsecond precision with sequence counter)
let _lastMs = 0;
let _nonceSeq = 0;

function getV3Nonce(): string {
  const nowMs = Date.now();
  if (nowMs === _lastMs) {
    _nonceSeq++;
  } else {
    _lastMs = nowMs;
    _nonceSeq = 0;
  }
  // Date.now() is milliseconds. Multiply by 1000 for microseconds.
  // BigInt required because the result exceeds Number.MAX_SAFE_INTEGER.
  return String(BigInt(nowMs) * BigInt(1000) + BigInt(_nonceSeq));
}

// EIP-712 domain (constant per Aster V3 spec)
const EIP712_DOMAIN = {
  name: 'AsterSignTransaction',
  version: '1',
  chainId: 1666,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const EIP712_TYPES = {
  Message: [{ name: 'msg', type: 'string' }],
};

function isV3Credentials(creds: ApiCredentials): boolean {
  return !!(creds as any).apiWalletKey;
}

function sortedParamString(params: Record<string, any>): string {
  return Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

// Generate timestamp (milliseconds) — used by V1 only
export function getTimestamp(): number {
  return Date.now();
}

/**
 * Build signed form data for POST/PUT requests.
 * Auto-detects V3 (EIP-712) vs V1 (HMAC-SHA256) based on credentials.
 */
export function buildSignedForm(params: Record<string, any>, credentials: ApiCredentials): URLSearchParams {
  if (isV3Credentials(credentials)) {
    return buildSignedFormV3(params, credentials);
  }
  return buildSignedFormV1(params, credentials);
}

/**
 * Build signed query string for GET/DELETE requests.
 * Auto-detects V3 (EIP-712) vs V1 (HMAC-SHA256) based on credentials.
 */
export function buildSignedQuery(params: Record<string, any>, credentials: ApiCredentials): string {
  if (isV3Credentials(credentials)) {
    return buildSignedQueryV3(params, credentials);
  }
  return buildSignedQueryV1(params, credentials);
}

// ─── V3 EIP-712 Signing ────────────────────────────────────────

function eip712SignSync(paramStr: string, privateKey: string): string {
  const digest = TypedDataEncoder.hash(EIP712_DOMAIN, EIP712_TYPES, { msg: paramStr });
  const signingKey = new ethers.SigningKey(privateKey);
  return signingKey.sign(digest).serialized;
}

function buildSignedFormV3(params: Record<string, any>, credentials: ApiCredentials): URLSearchParams {
  const v3 = credentials as any;
  const nonce = getV3Nonce();

  const finalParams: Record<string, any> = {
    ...params,
    nonce,
    signer: v3.apiWalletAddress,
  };

  const paramStr = sortedParamString(finalParams);
  const signature = eip712SignSync(paramStr, v3.apiWalletKey);
  finalParams.signature = signature;

  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(finalParams)) {
    if (value !== undefined && value !== null) {
      sp.append(key, String(value));
    }
  }
  return sp;
}

function buildSignedQueryV3(params: Record<string, any>, credentials: ApiCredentials): string {
  return buildSignedFormV3(params, credentials).toString();
}

// ─── V1 HMAC-SHA256 (Legacy) ──────────────────────────────────

function buildSignedFormV1(params: Record<string, any>, credentials: ApiCredentials): URLSearchParams {
  const timestamp = getTimestamp();

  const finalParams: Record<string, any> = {
    ...params,
    timestamp,
    recvWindow: 20000,
  };

  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(finalParams)) {
    if (value !== undefined && value !== null) {
      sp.append(key, String(value));
    }
  }

  const preSign = sp.toString();
  const hmac = crypto.createHmac('sha256', credentials.secretKey!);
  hmac.update(preSign);
  const signature = hmac.digest('hex');
  sp.append('signature', signature);

  return sp;
}

function buildSignedQueryV1(params: Record<string, any>, credentials: ApiCredentials): string {
  return buildSignedFormV1(params, credentials).toString();
}

// ─── Deprecated (backward compat) ──────────────────────────────

export function getSignedParams(params: Record<string, any>, credentials: ApiCredentials): Record<string, any> {
  const sp = buildSignedForm(params, credentials);
  const result: Record<string, any> = {};
  for (const [key, value] of sp.entries()) {
    result[key] = value;
  }
  return result;
}

export function paramsToQuery(params: Record<string, any>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}
