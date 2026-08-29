import { sha256Hex, timingSafeEqual } from "./crypto.ts";
import type { JsonValue } from "./types.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const MAX_CLIENT_DATA_BYTES = 8 * 1_024;
const MAX_ATTESTATION_BYTES = 64 * 1_024;
const MAX_AUTHENTICATOR_DATA_BYTES = 8 * 1_024;
const MAX_SIGNATURE_BYTES = 2 * 1_024;
// Fixed public-only keys keep every structurally valid authentication attempt
// on one ES256 and one RS256 import/verify path. Their private keys are not
// retained, so a fallback verification can never authenticate caller input.
const FAILURE_EQUALIZATION_ES256_PUBLIC_KEY_COSE = "pQECAyYgASFYIPvtToyXt8StHH1AVpV1CwxQjnI49md3d76LumwzowvEIlggvIZ_OJIMw9Nla4WYJD3D9nPOPABGCEYfaDKhHdsusNU";
const FAILURE_EQUALIZATION_RS256_PUBLIC_KEY_COSE = "pAEDAzkBACBZAQCYbJ2iHOx4aWfKYmoQ3ijp56FCbJdyHosyVMNS2zOKLCAHsGGQlEuNVC4C7EkdB0f9jRgpk17oPoaJ43fNJjaUjD2Qyy-NT-Rc9-6Kkr7dj7WmkJTQC9PStyf6pCN5qWkSnwf8i4_9s6vr-FpubfGtCIndD7VOamEJjiT3wuyfgUg02KionC1AL07te4Wzma7KYrvnE32-fU22ZswteGM_22Feh17dwPErZnIVWY7-6961o0ooIjLcAIt7cRXsUahAGVYL-bNovkqDLU6NlLE6V84o8tJdcJob4GufbcnFZmLIYbEVsxXOoLAPt6dC8iO9jIUc-FS1WmCzTeIVEjHtIUMBAAE";

type CborValue = boolean | number | string | null | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

export class WebAuthnVerificationError extends Error {
  constructor() {
    super("The WebAuthn ceremony could not be verified.");
    this.name = "WebAuthnVerificationError";
  }
}

export interface RegisteredAuthenticator {
  algorithm: -257 | -7;
  backupEligible: boolean;
  backupState: boolean;
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  transports: string[];
}

export interface VerifiedAssertion {
  backupEligible: boolean;
  backupState: boolean;
  credentialId: string;
  signCount: number;
  userHandle: string;
}

interface CeremonyExpectation {
  challengeDigest: string;
  expectedOrigin: string;
  rpId: string;
}

export interface AuthenticationExpectation extends CeremonyExpectation {
  algorithm: -257 | -7;
  backupEligible: boolean;
  credentialId: string;
  publicKeyCose: string;
  userHandle: string;
}

export interface AuthenticationFallbackExpectation extends CeremonyExpectation {
  credentialId: string;
  userHandle: string;
}

interface ParsedAuthenticatorData {
  backupEligible: boolean;
  backupState: boolean;
  credentialId: Uint8Array | null;
  flags: number;
  publicKeyCose: Uint8Array | null;
  rpIdHash: Uint8Array;
  signCount: number;
}

function fail(): never {
  throw new WebAuthnVerificationError();
}

function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") fail();
  return value;
}

function exactObject(
  value: JsonValue | undefined,
  allowedKeys: readonly string[],
): { [key: string]: JsonValue } {
  const result = object(value);
  const allowed = new Set(allowedKeys);
  if (Object.keys(result).some((key) => !allowed.has(key))) fail();
  return result;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string, maximumBytes = 128 * 1_024): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > Math.ceil(maximumBytes * 4 / 3) + 4) fail();
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    fail();
  }
  if (binary.length > maximumBytes) fail();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) fail();
  return bytes;
}

export function randomBase64Url(byteLength = 32): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) fail();
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function principalUserHandle(principalId: string): string {
  return base64UrlEncode(textEncoder.encode(principalId));
}

function readUnsigned(bytes: Uint8Array, offset: number, length: number): [number, number] {
  if (offset + length > bytes.length || length > 8) fail();
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
    if (!Number.isSafeInteger(value)) fail();
  }
  return [value, offset + length];
}

function cborLength(bytes: Uint8Array, offset: number, additional: number): [number, number] {
  if (additional < 24) return [additional, offset];
  if (additional === 24) return readUnsigned(bytes, offset, 1);
  if (additional === 25) return readUnsigned(bytes, offset, 2);
  if (additional === 26) return readUnsigned(bytes, offset, 4);
  if (additional === 27) return readUnsigned(bytes, offset, 8);
  fail();
}

function decodeCborItem(bytes: Uint8Array, start = 0, depth = 0): { next: number; value: CborValue } {
  if (depth > 16 || start >= bytes.length) fail();
  const initial = bytes[start] ?? 0;
  const major = initial >> 5;
  const additional = initial & 31;
  let offset = start + 1;
  if (major === 7) {
    if (additional === 20) return { next: offset, value: false };
    if (additional === 21) return { next: offset, value: true };
    if (additional === 22) return { next: offset, value: null };
    fail();
  }
  const [length, afterLength] = cborLength(bytes, offset, additional);
  offset = afterLength;
  if (major === 0) return { next: offset, value: length };
  if (major === 1) return { next: offset, value: -1 - length };
  if (major === 2 || major === 3) {
    if (offset + length > bytes.length) fail();
    const valueBytes = bytes.slice(offset, offset + length);
    if (major === 2) return { next: offset + length, value: valueBytes };
    try {
      return { next: offset + length, value: textDecoder.decode(valueBytes) };
    } catch {
      fail();
    }
  }
  if (major === 4) {
    if (length > 1_024) fail();
    const values: CborValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const decoded = decodeCborItem(bytes, offset, depth + 1);
      values.push(decoded.value);
      offset = decoded.next;
    }
    return { next: offset, value: values };
  }
  if (major === 5) {
    if (length > 1_024) fail();
    const values = new Map<CborValue, CborValue>();
    for (let index = 0; index < length; index += 1) {
      const key = decodeCborItem(bytes, offset, depth + 1);
      const value = decodeCborItem(bytes, key.next, depth + 1);
      if (values.has(key.value)) fail();
      values.set(key.value, value.value);
      offset = value.next;
    }
    return { next: offset, value: values };
  }
  // WebAuthn attestation objects and COSE keys are untagged CBOR values.
  // Accepting and silently discarding arbitrary tags would make the parser
  // less strict than the wire contract we verify.
  if (major === 6) fail();
  fail();
}

function decodeCbor(bytes: Uint8Array): CborValue {
  const decoded = decodeCborItem(bytes);
  if (decoded.next !== bytes.length) fail();
  return decoded.value;
}

function map(value: CborValue): Map<CborValue, CborValue> {
  if (!(value instanceof Map)) fail();
  return value;
}

function bytes(value: CborValue | undefined, expectedLength?: number): Uint8Array {
  if (!(value instanceof Uint8Array) || (expectedLength !== undefined && value.length !== expectedLength)) fail();
  return value;
}

function integer(value: CborValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail();
  return value;
}

function requireExactCoseLabels(cose: Map<CborValue, CborValue>, allowed: readonly number[]): void {
  if (cose.size !== allowed.length) fail();
  const allowedLabels = new Set(allowed);
  for (const label of cose.keys()) {
    if (typeof label !== "number" || !Number.isSafeInteger(label) || !allowedLabels.has(label)) fail();
  }
}

function uint32(bytesValue: Uint8Array, offset: number): number {
  if (offset + 4 > bytesValue.length) fail();
  return (((bytesValue[offset] ?? 0) * 0x1_00_00_00)
    + ((bytesValue[offset + 1] ?? 0) << 16)
    + ((bytesValue[offset + 2] ?? 0) << 8)
    + (bytesValue[offset + 3] ?? 0)) >>> 0;
}

function uint16(bytesValue: Uint8Array, offset: number): number {
  if (offset + 2 > bytesValue.length) fail();
  return ((bytesValue[offset] ?? 0) << 8) + (bytesValue[offset + 1] ?? 0);
}

function parseAuthenticatorData(value: Uint8Array, registration: boolean): ParsedAuthenticatorData {
  if (value.length < 37 || value.length > MAX_AUTHENTICATOR_DATA_BYTES) fail();
  const flags = value[32] ?? 0;
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0 || (flags & 0x22) !== 0) fail();
  const backupEligible = (flags & 0x08) !== 0;
  const backupState = (flags & 0x10) !== 0;
  if (backupState && !backupEligible) fail();
  if (!registration) {
    if ((flags & 0x40) !== 0) fail();
    let offset = 37;
    if ((flags & 0x80) !== 0) {
      const extensions = decodeCborItem(value, offset);
      map(extensions.value);
      offset = extensions.next;
    }
    if (offset !== value.length) fail();
    return {
      backupEligible,
      backupState,
      credentialId: null,
      flags,
      publicKeyCose: null,
      rpIdHash: value.slice(0, 32),
      signCount: uint32(value, 33),
    };
  }
  if ((flags & 0x40) === 0 || value.length < 55) fail();
  let offset = 53;
  const credentialLength = uint16(value, offset);
  offset += 2;
  if (credentialLength < 16 || credentialLength > 1_024 || offset + credentialLength > value.length) fail();
  const credentialId = value.slice(offset, offset + credentialLength);
  offset += credentialLength;
  const decodedKey = decodeCborItem(value, offset);
  const publicKeyCose = value.slice(offset, decodedKey.next);
  map(decodedKey.value);
  offset = decodedKey.next;
  if ((flags & 0x80) !== 0) {
    const extensions = decodeCborItem(value, offset);
    map(extensions.value);
    offset = extensions.next;
  }
  if (offset !== value.length) fail();
  return {
    backupEligible,
    backupState,
    credentialId,
    flags,
    publicKeyCose,
    rpIdHash: value.slice(0, 32),
    signCount: uint32(value, 33),
  };
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function verifyRpIdHash(actual: Uint8Array, rpId: string): Promise<void> {
  if (!equalBytes(actual, await sha256Bytes(textEncoder.encode(rpId)))) fail();
}

async function verifyClientData(
  encoded: JsonValue | undefined,
  expectedType: "webauthn.create" | "webauthn.get",
  expectation: CeremonyExpectation,
): Promise<Uint8Array> {
  if (typeof encoded !== "string") fail();
  const raw = base64UrlDecode(encoded, MAX_CLIENT_DATA_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(raw));
  } catch {
    fail();
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") fail();
  const data = parsed as Record<string, unknown>;
  if (
    data.type !== expectedType
    || typeof data.challenge !== "string"
    || typeof data.origin !== "string"
    || data.origin !== expectation.expectedOrigin
    || data.crossOrigin === true
    || !timingSafeEqual(await sha256Hex(data.challenge), expectation.challengeDigest)
  ) fail();
  base64UrlDecode(data.challenge, 64);
  return raw;
}

function credentialEnvelope(value: JsonValue): {
  id: string;
  rawId: string;
  response: { [key: string]: JsonValue };
} {
  const credential = exactObject(value, [
    "authenticatorAttachment",
    "clientExtensionResults",
    "id",
    "rawId",
    "response",
    "type",
  ]);
  if (
    credential.type !== "public-key"
    || typeof credential.id !== "string"
    || typeof credential.rawId !== "string"
    || credential.id !== credential.rawId
  ) fail();
  if (
    credential.authenticatorAttachment !== undefined
    && credential.authenticatorAttachment !== null
    && credential.authenticatorAttachment !== "platform"
    && credential.authenticatorAttachment !== "cross-platform"
  ) fail();
  if (
    credential.clientExtensionResults !== undefined
    && Object.keys(exactObject(credential.clientExtensionResults, [])).length !== 0
  ) fail();
  const rawId = base64UrlDecode(credential.rawId, 1_024);
  if (rawId.length < 16) fail();
  return { id: credential.id, rawId: credential.rawId, response: object(credential.response) };
}

export function webAuthnCredentialId(value: JsonValue): string {
  return credentialEnvelope(value).id;
}

function validatedCoseAlgorithm(publicKeyCose: Uint8Array): -257 | -7 {
  const cose = map(decodeCbor(publicKeyCose));
  const keyType = integer(cose.get(1));
  const algorithm = integer(cose.get(3));
  if (algorithm === -7) {
    // Persist only the exact EC2 public-key shape. In particular, reject the
    // private scalar label (-4) and arbitrary unverified authenticator data.
    requireExactCoseLabels(cose, [1, 3, -1, -2, -3]);
    if (
      keyType !== 2
      || integer(cose.get(-1)) !== 1
      || bytes(cose.get(-2), 32).length !== 32
      || bytes(cose.get(-3), 32).length !== 32
    ) fail();
    return -7;
  }
  if (algorithm === -257) {
    // RSA registrations may contain only kty, alg, modulus and exponent.
    // Private CRT factors and extension labels must stay in the authenticator.
    // v0 deliberately accepts one RS256 public-key profile (2048-bit,
    // e=65537), matching the failure-equalization key so key parameters do
    // not become a credential-existence timing signal.
    requireExactCoseLabels(cose, [1, 3, -1, -2]);
    const modulus = bytes(cose.get(-1));
    const exponent = bytes(cose.get(-2));
    if (
      keyType !== 3
      || modulus.length !== 256
      || (modulus[0]! & 0x80) === 0
      || (modulus[modulus.length - 1]! & 1) === 0
      || exponent.length !== 3
      || exponent[0] !== 0x01
      || exponent[1] !== 0x00
      || exponent[2] !== 0x01
    ) fail();
    return -257;
  }
  fail();
}

function transports(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) fail();
  const allowed = new Set(["ble", "hybrid", "internal", "nfc", "smart-card", "usb"]);
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry) || normalized.includes(entry)) fail();
    normalized.push(entry);
  }
  return normalized.sort();
}

export async function verifyRegistrationCredential(
  value: JsonValue,
  expectation: CeremonyExpectation,
): Promise<RegisteredAuthenticator> {
  const credential = credentialEnvelope(value);
  const response = exactObject(credential.response, [
    "attestationObject",
    "authenticatorData",
    "clientDataJSON",
    "publicKey",
    "publicKeyAlgorithm",
    "transports",
  ]);
  const clientData = await verifyClientData(
    response.clientDataJSON,
    "webauthn.create",
    expectation,
  );
  if (clientData.length === 0 || typeof response.attestationObject !== "string") fail();
  const attestation = base64UrlDecode(response.attestationObject, MAX_ATTESTATION_BYTES);
  const root = map(decodeCbor(attestation));
  if (root.get("fmt") !== "none" || map(root.get("attStmt") as CborValue).size !== 0) fail();
  const authenticatorData = parseAuthenticatorData(bytes(root.get("authData")), true);
  await verifyRpIdHash(authenticatorData.rpIdHash, expectation.rpId);
  if (
    authenticatorData.credentialId === null
    || authenticatorData.publicKeyCose === null
    || !equalBytes(authenticatorData.credentialId, base64UrlDecode(credential.rawId, 1_024))
  ) fail();
  const algorithm = validatedCoseAlgorithm(authenticatorData.publicKeyCose);
  if (response.authenticatorData !== undefined) {
    if (typeof response.authenticatorData !== "string") fail();
    base64UrlDecode(response.authenticatorData, MAX_AUTHENTICATOR_DATA_BYTES);
  }
  if (response.publicKey !== undefined && response.publicKey !== null) {
    if (typeof response.publicKey !== "string") fail();
    base64UrlDecode(response.publicKey, 4 * 1_024);
  }
  if (
    response.publicKeyAlgorithm !== undefined
    && response.publicKeyAlgorithm !== null
    && response.publicKeyAlgorithm !== algorithm
  ) fail();
  const publicKeyCose = base64UrlEncode(authenticatorData.publicKeyCose);
  // Shape validation alone can accept an invalid EC point or unusable RSA
  // parameters. Registration succeeds only for a key Workers can import.
  await importCosePublicKey(publicKeyCose, algorithm);
  return {
    algorithm,
    backupEligible: authenticatorData.backupEligible,
    backupState: authenticatorData.backupState,
    credentialId: credential.id,
    publicKeyCose,
    signCount: authenticatorData.signCount,
    transports: transports(response.transports),
  };
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function derInteger(bytesValue: Uint8Array, offset: number): { next: number; value: Uint8Array } {
  if (bytesValue[offset] !== 0x02) fail();
  const length = bytesValue[offset + 1] ?? 0;
  if (length < 1 || length > 33 || offset + 2 + length > bytesValue.length) fail();
  let value = bytesValue.slice(offset + 2, offset + 2 + length);
  if ((value[0] ?? 0) >= 0x80) fail();
  if (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) fail();
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { next: offset + 2 + length, value: padded };
}

function ecdsaDerToP1363(signature: Uint8Array): Uint8Array {
  if (signature.length < 8 || signature[0] !== 0x30) fail();
  let offset = 1;
  let length = signature[offset] ?? 0;
  offset += 1;
  if ((length & 0x80) !== 0) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 2) fail();
    [length, offset] = readUnsigned(signature, offset, lengthBytes);
  }
  if (offset + length !== signature.length) fail();
  const left = derInteger(signature, offset);
  const right = derInteger(signature, left.next);
  if (right.next !== signature.length) fail();
  return concatenate(left.value, right.value);
}

async function importCosePublicKey(publicKeyCose: string, algorithm: -257 | -7): Promise<CryptoKey> {
  const cose = map(decodeCbor(base64UrlDecode(publicKeyCose, 2_048)));
  if (validatedCoseAlgorithm(base64UrlDecode(publicKeyCose, 2_048)) !== algorithm) fail();
  try {
    if (algorithm === -7) {
      return await crypto.subtle.importKey(
        "jwk",
        {
          crv: "P-256",
          ext: true,
          key_ops: ["verify"],
          kty: "EC",
          x: base64UrlEncode(bytes(cose.get(-2), 32)),
          y: base64UrlEncode(bytes(cose.get(-3), 32)),
        },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    }
    return await crypto.subtle.importKey(
      "jwk",
      {
        alg: "RS256",
        e: base64UrlEncode(bytes(cose.get(-2))),
        ext: true,
        key_ops: ["verify"],
        kty: "RSA",
        n: base64UrlEncode(bytes(cose.get(-1))),
      },
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
  } catch {
    fail();
  }
}

export async function verifyAuthenticationCredential(
  value: JsonValue,
  expectation: AuthenticationExpectation,
): Promise<VerifiedAssertion> {
  const credential = credentialEnvelope(value);
  const response = exactObject(credential.response, [
    "authenticatorData",
    "clientDataJSON",
    "signature",
    "userHandle",
  ]);
  let ceremonyValid = credential.id === expectation.credentialId;

  // Keep client-data validation on the same digest/import/verify path even
  // when challenge, origin or type is invalid. Structurally valid public
  // verification failures must not reveal whether a credential was found.
  let clientData = textEncoder.encode("{}");
  let clientDataObject: Record<string, unknown> = {};
  if (typeof response.clientDataJSON === "string") {
    try {
      clientData = base64UrlDecode(response.clientDataJSON, MAX_CLIENT_DATA_BYTES);
      const parsed = JSON.parse(textDecoder.decode(clientData)) as unknown;
      if (parsed !== null && !Array.isArray(parsed) && typeof parsed === "object") {
        clientDataObject = parsed as Record<string, unknown>;
      } else {
        ceremonyValid = false;
      }
    } catch {
      ceremonyValid = false;
    }
  } else {
    ceremonyValid = false;
  }
  const challenge = typeof clientDataObject.challenge === "string"
    ? clientDataObject.challenge
    : "";
  let challengeEncodingValid = true;
  try {
    base64UrlDecode(challenge, 64);
  } catch {
    challengeEncodingValid = false;
  }
  const challengeMatches = timingSafeEqual(
    await sha256Hex(challenge),
    expectation.challengeDigest,
  );
  ceremonyValid = ceremonyValid
    && clientDataObject.type === "webauthn.get"
    && clientDataObject.origin === expectation.expectedOrigin
    && clientDataObject.crossOrigin !== true
    && challengeEncodingValid
    && challengeMatches;

  let authenticatorDataBytes: Uint8Array = new Uint8Array(37);
  let authenticatorData: ParsedAuthenticatorData = {
    backupEligible: false,
    backupState: false,
    credentialId: null,
    flags: 0,
    publicKeyCose: null,
    rpIdHash: new Uint8Array(32),
    signCount: 0,
  };
  if (typeof response.authenticatorData === "string") {
    try {
      authenticatorDataBytes = base64UrlDecode(
        response.authenticatorData,
        MAX_AUTHENTICATOR_DATA_BYTES,
      );
      authenticatorData = parseAuthenticatorData(authenticatorDataBytes, false);
    } catch {
      ceremonyValid = false;
    }
  } else {
    ceremonyValid = false;
  }
  ceremonyValid = equalBytes(
    authenticatorData.rpIdHash,
    await sha256Bytes(textEncoder.encode(expectation.rpId)),
  ) && ceremonyValid;

  const userHandle = typeof response.userHandle === "string" ? response.userHandle : "";
  try {
    base64UrlDecode(userHandle, 64);
  } catch {
    ceremonyValid = false;
  }
  let signature: Uint8Array = expectation.algorithm === -7
    ? new Uint8Array(64)
    : new Uint8Array(256);
  if (typeof response.signature === "string") {
    try {
      signature = base64UrlDecode(response.signature, MAX_SIGNATURE_BYTES);
    } catch {
      ceremonyValid = false;
    }
  } else {
    ceremonyValid = false;
  }
  const signed = concatenate(authenticatorDataBytes, await sha256Bytes(clientData));
  const publicKey = await importCosePublicKey(expectation.publicKeyCose, expectation.algorithm);
  let verified = false;
  let signatureEncodingValid = true;
  let signatureForVerification: Uint8Array = signature;
  if (expectation.algorithm === -7) {
    try {
      signatureForVerification = ecdsaDerToP1363(signature);
    } catch {
      signatureEncodingValid = false;
      signatureForVerification = new Uint8Array(64);
    }
  }
  try {
    verified = expectation.algorithm === -7
      ? await crypto.subtle.verify(
        { hash: "SHA-256", name: "ECDSA" },
        publicKey,
        signatureForVerification,
        signed,
      )
      : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signed);
  } catch {
    verified = false;
  }
  const userHandleMatches = timingSafeEqual(userHandle, expectation.userHandle);
  const backupEligibilityMatches = authenticatorData.backupEligible === expectation.backupEligible;
  if (
    !ceremonyValid
    || !signatureEncodingValid
    || !verified
    || !userHandleMatches
    || !backupEligibilityMatches
  ) fail();
  return {
    backupEligible: authenticatorData.backupEligible,
    backupState: authenticatorData.backupState,
    credentialId: credential.id,
    signCount: authenticatorData.signCount,
    userHandle,
  };
}

export async function verifyAuthenticationCredentialEqualized(
  value: JsonValue,
  expectation: AuthenticationExpectation | null,
  fallback: AuthenticationFallbackExpectation,
): Promise<VerifiedAssertion | null> {
  const fallbackBase = {
    backupEligible: false,
    challengeDigest: fallback.challengeDigest,
    credentialId: fallback.credentialId,
    expectedOrigin: fallback.expectedOrigin,
    rpId: fallback.rpId,
    userHandle: fallback.userHandle,
  };
  const es256Expectation: AuthenticationExpectation = expectation?.algorithm === -7
    ? expectation
    : {
        ...fallbackBase,
        algorithm: -7,
        publicKeyCose: FAILURE_EQUALIZATION_ES256_PUBLIC_KEY_COSE,
      };
  const rs256Expectation: AuthenticationExpectation = expectation?.algorithm === -257
    ? expectation
    : {
        ...fallbackBase,
        algorithm: -257,
        publicKeyCose: FAILURE_EQUALIZATION_RS256_PUBLIC_KEY_COSE,
      };
  const [es256Result, rs256Result] = await Promise.allSettled([
    verifyAuthenticationCredential(value, es256Expectation),
    verifyAuthenticationCredential(value, rs256Expectation),
  ]);
  if (expectation === null) return null;
  const selected = expectation.algorithm === -7 ? es256Result : rs256Result;
  if (selected.status === "rejected") throw selected.reason;
  return selected.value;
}

export function counterAdvances(stored: number, observed: number): boolean {
  return Number.isSafeInteger(stored)
    && Number.isSafeInteger(observed)
    && stored >= 0
    && observed >= 0
    && ((stored === 0 && observed === 0) || observed > stored);
}
