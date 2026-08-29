const encoder = new TextEncoder();

export function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function concatenate(...values) {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function cborHead(major, length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("Invalid CBOR length");
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length <= 0xff) return Uint8Array.of((major << 5) | 24, length);
  if (length <= 0xffff) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  if (length <= 0xffff_ffff) {
    return Uint8Array.of(
      (major << 5) | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
  }
  throw new TypeError("CBOR length is too large");
}

function cbor(value) {
  if (Number.isSafeInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concatenate(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concatenate(cborHead(2, value.length), value);
  if (Array.isArray(value)) return concatenate(cborHead(4, value.length), ...value.map(cbor));
  if (value instanceof Map) {
    const entries = [];
    for (const [key, entry] of value) entries.push(cbor(key), cbor(entry));
    return concatenate(cborHead(5, value.size), ...entries);
  }
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  throw new TypeError("Unsupported CBOR fixture value");
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function uint32(value) {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function registrationAuthenticatorData(rpId, credentialId, publicKeyCose, signCount = 0) {
  return sha256(encoder.encode(rpId)).then((rpIdHash) => concatenate(
    rpIdHash,
    Uint8Array.of(0x45), // UP + UV + AT
    uint32(signCount),
    new Uint8Array(16),
    Uint8Array.of((credentialId.length >> 8) & 0xff, credentialId.length & 0xff),
    credentialId,
    publicKeyCose,
  ));
}

async function assertionAuthenticatorData(rpId, signCount) {
  return concatenate(await sha256(encoder.encode(rpId)), Uint8Array.of(0x05), uint32(signCount));
}

function clientData(type, challenge, origin) {
  return encoder.encode(JSON.stringify({ challenge, crossOrigin: false, origin, type }));
}

function derInteger(raw) {
  let first = 0;
  while (first < raw.length - 1 && raw[first] === 0) first += 1;
  let value = raw.slice(first);
  if ((value[0] & 0x80) !== 0) value = concatenate(Uint8Array.of(0), value);
  return concatenate(Uint8Array.of(0x02, value.length), value);
}

function ecdsaRawToDer(signature) {
  if (signature.length !== 64) return signature;
  const left = derInteger(signature.slice(0, 32));
  const right = derInteger(signature.slice(32));
  const body = concatenate(left, right);
  return concatenate(Uint8Array.of(0x30, body.length), body);
}

async function keyMaterial(algorithm) {
  if (algorithm === -7) {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    return {
      algorithm,
      coseEntries: [
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, base64UrlDecode(jwk.x)],
        [-3, base64UrlDecode(jwk.y)],
      ],
      privateKey: keys.privateKey,
    };
  }
  if (algorithm === -257) {
    const keys = await crypto.subtle.generateKey(
      {
        hash: "SHA-256",
        modulusLength: 2048,
        name: "RSASSA-PKCS1-v1_5",
        publicExponent: Uint8Array.of(1, 0, 1),
      },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    return {
      algorithm,
      coseEntries: [
        [1, 3],
        [3, -257],
        [-1, base64UrlDecode(jwk.n)],
        [-2, base64UrlDecode(jwk.e)],
      ],
      privateKey: keys.privateKey,
    };
  }
  throw new TypeError("Unsupported fixture algorithm");
}

export async function createRegistrationFixture({
  algorithm,
  challenge,
  extraCoseEntries = [],
  origin,
  rpId,
  signCount = 0,
}) {
  const material = await keyMaterial(algorithm);
  const publicKeyCose = cbor(new Map([...material.coseEntries, ...extraCoseEntries]));
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = base64UrlEncode(credentialIdBytes);
  const authData = await registrationAuthenticatorData(
    rpId,
    credentialIdBytes,
    publicKeyCose,
    signCount,
  );
  const attestationObject = cbor(new Map([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]));
  const clientDataJSON = clientData("webauthn.create", challenge, origin);
  return {
    algorithm,
    credentialId,
    privateKey: material.privateKey,
    publicKeyCose: base64UrlEncode(publicKeyCose),
    registrationCredential: {
      id: credentialId,
      rawId: credentialId,
      response: {
        attestationObject: base64UrlEncode(attestationObject),
        clientDataJSON: base64UrlEncode(clientDataJSON),
        transports: ["internal"],
      },
      type: "public-key",
    },
  };
}

export async function createAssertionCredential({
  challenge,
  credentialId,
  privateKey,
  algorithm,
  origin,
  rpId,
  signCount,
  userHandle,
}) {
  const authenticatorData = await assertionAuthenticatorData(rpId, signCount);
  const clientDataJSON = clientData("webauthn.get", challenge, origin);
  const signed = concatenate(authenticatorData, await sha256(clientDataJSON));
  let signature = new Uint8Array(await crypto.subtle.sign(
    algorithm === -7
      ? { hash: "SHA-256", name: "ECDSA" }
      : "RSASSA-PKCS1-v1_5",
    privateKey,
    signed,
  ));
  if (algorithm === -7) signature = ecdsaRawToDer(signature);
  return {
    id: credentialId,
    rawId: credentialId,
    response: {
      authenticatorData: base64UrlEncode(authenticatorData),
      clientDataJSON: base64UrlEncode(clientDataJSON),
      signature: base64UrlEncode(signature),
      userHandle,
    },
    type: "public-key",
  };
}
