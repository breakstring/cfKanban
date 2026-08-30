interface CeremonyEnvelope {
  challenge_id: string;
  public_key: Record<string, unknown>;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function descriptor(value: PublicKeyCredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return {
    id: decodeBase64Url(value.id),
    type: "public-key",
    ...(value.transports === undefined
      ? {}
      : { transports: value.transports as AuthenticatorTransport[] }),
  };
}

export function registrationOptions(envelope: CeremonyEnvelope): PublicKeyCredentialCreationOptions {
  const source = envelope.public_key as unknown as PublicKeyCredentialCreationOptionsJSON;
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(source);
  }
  return {
    challenge: decodeBase64Url(source.challenge),
    pubKeyCredParams: source.pubKeyCredParams,
    rp: source.rp,
    user: { ...source.user, id: decodeBase64Url(source.user.id) },
    ...(source.attestation === undefined
      ? {}
      : { attestation: source.attestation as AttestationConveyancePreference }),
    ...(source.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: source.authenticatorSelection }),
    ...(source.excludeCredentials === undefined
      ? {}
      : { excludeCredentials: source.excludeCredentials.map(descriptor) }),
    ...(source.extensions === undefined
      ? {}
      : { extensions: source.extensions as unknown as AuthenticationExtensionsClientInputs }),
    ...(source.timeout === undefined ? {} : { timeout: source.timeout }),
  };
}

export function authenticationOptions(envelope: CeremonyEnvelope): PublicKeyCredentialRequestOptions {
  const source = envelope.public_key as unknown as PublicKeyCredentialRequestOptionsJSON;
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(source);
  }
  return {
    challenge: decodeBase64Url(source.challenge),
    ...(source.allowCredentials === undefined
      ? {}
      : { allowCredentials: source.allowCredentials.map(descriptor) }),
    ...(source.extensions === undefined
      ? {}
      : { extensions: source.extensions as unknown as AuthenticationExtensionsClientInputs }),
    ...(source.rpId === undefined ? {} : { rpId: source.rpId }),
    ...(source.timeout === undefined ? {} : { timeout: source.timeout }),
    ...(source.userVerification === undefined
      ? {}
      : { userVerification: source.userVerification as UserVerificationRequirement }),
  };
}

export function registrationCredential(value: Credential | null): Record<string, unknown> {
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Passkey registration was not completed.");
  }
  return {
    id: value.id,
    rawId: encodeBase64Url(value.rawId),
    response: {
      attestationObject: encodeBase64Url(value.response.attestationObject),
      clientDataJSON: encodeBase64Url(value.response.clientDataJSON),
      transports: value.response.getTransports(),
    },
    type: value.type,
  };
}

export function authenticationCredential(value: Credential | null): Record<string, unknown> {
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Passkey authentication was not completed.");
  }
  return {
    id: value.id,
    rawId: encodeBase64Url(value.rawId),
    response: {
      authenticatorData: encodeBase64Url(value.response.authenticatorData),
      clientDataJSON: encodeBase64Url(value.response.clientDataJSON),
      signature: encodeBase64Url(value.response.signature),
      userHandle: value.response.userHandle === null ? null : encodeBase64Url(value.response.userHandle),
    },
    type: value.type,
  };
}
