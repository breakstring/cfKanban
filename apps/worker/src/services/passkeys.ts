import { requireUuid, requireVersion, timestamp } from "../domain/model.ts";
import { buildCurrentAuthGuard, requireOwnerControl, verifyCurrentAuth } from "../kernel/authorization.ts";
import { sha256Hex } from "../kernel/crypto.ts";
import { AtomicBatchRejectedError, executeAtomicBatch, probeOperationCommit, type OperationCommit } from "../kernel/d1.ts";
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  platformUnavailable,
  unauthorized,
  versionConflict,
} from "../kernel/errors.ts";
import {
  abandonOwnedPendingClaim,
  claimIdempotency,
  finalizeIdempotency,
  operationSnapshotStatement,
  readFinalizedIdempotencyResponse,
  readIdempotencyResponse,
  readOperationSnapshot,
  runIdempotentOperation,
} from "../kernel/idempotency.ts";
import type { AuthContext, CookieAuthContext, JsonValue } from "../kernel/types.ts";
import {
  counterAdvances,
  principalUserHandle,
  randomBase64Url,
  verifyAuthenticationCredential,
  verifyRegistrationCredential,
  webAuthnCredentialId,
  WebAuthnVerificationError,
  type RegisteredAuthenticator,
} from "../kernel/webauthn.ts";
import { actorCredentialId, authorizedVia, eventCursor, requireIdempotencyKey, writeResult } from "./shared.ts";
import { webSessionCleanupStatement } from "./web-state.ts";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const PASSKEY_LIMIT = 100;
// Public-only P-256 key used to keep structurally valid unknown/revoked
// credential failures on the same WebCrypto verification path as registered
// credentials. The corresponding private key is not retained.
const FAILURE_EQUALIZATION_PUBLIC_KEY_COSE = "pQECAyYgASFYIPvtToyXt8StHH1AVpV1CwxQjnI49md3d76LumwzowvEIlggvIZ_OJIMw9Nla4WYJD3D9nPOPABGCEYfaDKhHdsusNU";
const FAILURE_EQUALIZATION_CHALLENGE_DIGEST = "0".repeat(64);

interface ChallengeRow {
  challenge_digest: string;
  consumed_at: number | null;
  expected_origin: string;
  expires_at: number;
  id: string;
  last_operation_id: string | null;
  principal_id: string | null;
  purpose: "authentication" | "registration";
  rp_id: string;
}

interface AuthenticatorRow {
  algorithm: -257 | -7;
  backup_eligible: number;
  backup_state: number;
  created_at: number;
  credential_id: string;
  id: string;
  last_operation_id: string | null;
  last_used_at: number | null;
  principal_display_name: string;
  principal_id: string;
  public_key_cose: string;
  revoked_at: number | null;
  revoked_by_principal_id: string | null;
  rp_id: string;
  sign_count: number;
  transports_json: string | null;
  user_handle: string;
  version: number;
}

interface SessionSnapshot {
  csrf_digest: string;
  display_name: string;
  entry_path: string;
  expires_at: number;
  is_owner: boolean;
  principal_id: string;
  session_id: string;
  session_token_digest: string;
  source_id: string;
  source_kind: "web_authenticator";
  target: { [key: string]: JsonValue };
}

export interface SessionExchangeResult {
  body: { [key: string]: JsonValue };
  csrfToken: string | null;
  sessionToken: string | null;
}

function passkeyChallengeInvalid(): ApiError {
  return conflict("PASSKEY_CHALLENGE_INVALID", "retry_passkey_ceremony");
}

function passkeyAlreadyRegistered(): ApiError {
  return conflict("PASSKEY_ALREADY_REGISTERED", "refresh_resource");
}

function passkeyLimitReached(): ApiError {
  return conflict("PASSKEY_LIMIT_REACHED", "revoke_passkey");
}

function passkeyNotFound(): ApiError {
  return new ApiError({
    category: "not_found",
    code: "PASSKEY_NOT_FOUND",
    message: "The requested Passkey was not found.",
    recovery: "refresh_resource",
    retryable: false,
    status: 404,
  });
}

function requestCeremonyScope(request: Request): { expectedOrigin: string; rpId: string } {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname.length === 0 || url.username !== "" || url.password !== "") {
    throw unauthorized();
  }
  return { expectedOrigin: url.origin, rpId: url.hostname.toLowerCase() };
}

function challengeActive(row: ChallengeRow | null, purpose: ChallengeRow["purpose"], now: number): row is ChallengeRow {
  return row !== null
    && row.purpose === purpose
    && row.consumed_at === null
    && row.expires_at > now;
}

async function readChallenge(db: D1Database, id: string): Promise<ChallengeRow | null> {
  try {
    return await db.prepare(
      `SELECT id, challenge_digest, purpose, principal_id, rp_id, expected_origin,
              expires_at, consumed_at, last_operation_id
       FROM webauthn_challenges WHERE id = ?1 LIMIT 1`,
    ).bind(id).first<ChallengeRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

const AUTHENTICATOR_SELECT = `
  SELECT authenticator.id, authenticator.principal_id, authenticator.credential_id,
         authenticator.public_key_cose, authenticator.algorithm, authenticator.user_handle,
         authenticator.sign_count, authenticator.backup_eligible, authenticator.backup_state,
         authenticator.transports_json, authenticator.rp_id, authenticator.version,
         authenticator.created_at, authenticator.last_used_at, authenticator.revoked_at,
         authenticator.revoked_by_principal_id, authenticator.last_operation_id,
         principal.display_name AS principal_display_name
  FROM web_authenticators authenticator
  JOIN principals principal ON principal.id = authenticator.principal_id`;

async function readAuthenticatorByCredential(
  db: D1Database,
  credentialId: string,
): Promise<AuthenticatorRow | null> {
  try {
    return await db.prepare(
      `${AUTHENTICATOR_SELECT}
       WHERE authenticator.credential_id = ?1 LIMIT 1`,
    ).bind(credentialId).first<AuthenticatorRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

async function readAuthenticatorById(db: D1Database, id: string): Promise<AuthenticatorRow | null> {
  try {
    return await db.prepare(
      `${AUTHENTICATOR_SELECT}
       WHERE authenticator.id = ?1 LIMIT 1`,
    ).bind(id).first<AuthenticatorRow>();
  } catch {
    throw platformUnavailable("d1");
  }
}

function transportList(row: AuthenticatorRow): JsonValue[] {
  if (row.transports_json === null) return [];
  try {
    const value = JSON.parse(row.transports_json) as JsonValue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error();
    return value;
  } catch {
    throw platformUnavailable("d1");
  }
}

function authenticatorResource(row: AuthenticatorRow): { [key: string]: JsonValue } {
  return {
    algorithm: row.algorithm,
    backup_eligible: row.backup_eligible === 1,
    backup_state: row.backup_state === 1,
    created_at: timestamp(row.created_at),
    id: row.id,
    last_used_at: row.last_used_at === null ? null : timestamp(row.last_used_at),
    revoked_at: row.revoked_at === null ? null : timestamp(row.revoked_at),
    rp_id: row.rp_id,
    transports: transportList(row),
    version: row.version,
  };
}

async function authorizeAgentLaunchSession(
  db: D1Database,
  auth: CookieAuthContext,
  now: number,
): Promise<void> {
  if (auth.sourceKind !== "credential") throw forbidden();
  await verifyCurrentAuth(db, auth, now);
}

async function activePasskeyCount(db: D1Database, principalId: string): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS count FROM web_authenticators WHERE principal_id = ?1 AND revoked_at IS NULL",
    ).bind(principalId).first<{ count: number }>();
    if (row === null || !Number.isSafeInteger(row.count)) throw new Error();
    return row.count;
  } catch {
    throw platformUnavailable("d1");
  }
}

async function registrationExcludeCredentials(
  db: D1Database,
  principalId: string,
  rpId: string,
): Promise<JsonValue[]> {
  try {
    const result = await db.prepare(
      `SELECT credential_id, transports_json
       FROM web_authenticators
       WHERE principal_id = ?1 AND rp_id = ?2 AND revoked_at IS NULL
       ORDER BY created_at, id LIMIT ?3`,
    ).bind(principalId, rpId, PASSKEY_LIMIT).all<{ credential_id: string; transports_json: string | null }>();
    return result.results.map((row) => {
      let transports: JsonValue[] = [];
      if (row.transports_json !== null) {
        const parsed = JSON.parse(row.transports_json) as JsonValue;
        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
          throw platformUnavailable("d1");
        }
        transports = parsed;
      }
      return { id: row.credential_id, transports, type: "public-key" };
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1");
  }
}

function challengeCleanupStatements(db: D1Database, now: number): D1PreparedStatement[] {
  return [
    db.prepare(
      `DELETE FROM webauthn_challenges
       WHERE id IN (
         SELECT id FROM webauthn_challenges INDEXED BY idx_webauthn_challenges_expiry
         WHERE expires_at <= ?1
         ORDER BY expires_at, id LIMIT 100
       )`,
    ).bind(now),
    db.prepare(
      `DELETE FROM webauthn_challenges
       WHERE id IN (
         SELECT id FROM webauthn_challenges INDEXED BY idx_webauthn_challenges_consumed
         WHERE consumed_at IS NOT NULL
         ORDER BY consumed_at, id LIMIT 100
       )`,
    ),
  ];
}

async function insertChallenge(
  db: D1Database,
  principalId: string | null,
  auth: CookieAuthContext | null,
  scope: { expectedOrigin: string; rpId: string },
  challengeId: string,
  challengeDigest: string,
  now: number,
): Promise<void> {
  let insert: D1PreparedStatement;
  if (auth === null) {
    insert = db.prepare(
      `INSERT INTO webauthn_challenges
        (id, challenge_digest, purpose, principal_id, rp_id, expected_origin,
         expires_at, created_at)
       VALUES (?1, ?2, 'authentication', NULL, ?3, ?4, ?5, ?6)`,
    ).bind(
      challengeId,
      challengeDigest,
      scope.rpId,
      scope.expectedOrigin,
      now + CHALLENGE_LIFETIME_MS,
      now,
    );
  } else {
    const guard = buildCurrentAuthGuard(auth, now, 8);
    insert = db.prepare(
      `INSERT INTO webauthn_challenges
        (id, challenge_digest, purpose, principal_id, rp_id, expected_origin,
         expires_at, created_at)
       SELECT ?1, ?2, 'registration', ?3, ?4, ?5, ?6, ?7
       WHERE ${guard.sql}
         AND EXISTS (
           SELECT 1 FROM web_sessions registration_session
           WHERE registration_session.id = ?8
             AND registration_session.principal_id = ?3
             AND registration_session.source_kind = 'credential'
         )`,
    ).bind(
      challengeId,
      challengeDigest,
      principalId,
      scope.rpId,
      scope.expectedOrigin,
      now + CHALLENGE_LIFETIME_MS,
      now,
      ...guard.values,
    );
  }
  try {
    const cleanup = challengeCleanupStatements(db, now);
    const results = await db.batch([...cleanup, insert]);
    if ((results[cleanup.length]?.meta.changes ?? 0) !== 1) {
      if (auth !== null) await authorizeAgentLaunchSession(db, auth, now);
      throw new AtomicBatchRejectedError();
    }
  } catch (error) {
    if (error instanceof ApiError || error instanceof AtomicBatchRejectedError) throw error;
    throw platformUnavailable("d1");
  }
}

export async function createPasskeyRegistrationOptions(
  db: D1Database,
  request: Request,
  auth: CookieAuthContext,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  await authorizeAgentLaunchSession(db, auth, now);
  if (await activePasskeyCount(db, auth.principalId) >= PASSKEY_LIMIT) throw passkeyLimitReached();
  const scope = requestCeremonyScope(request);
  const challengeId = crypto.randomUUID();
  const challenge = randomBase64Url(32);
  const excludeCredentials = await registrationExcludeCredentials(db, auth.principalId, scope.rpId);
  await insertChallenge(
    db,
    auth.principalId,
    auth,
    scope,
    challengeId,
    await sha256Hex(challenge),
    now,
  );
  return {
    challenge_id: challengeId,
    expires_at: timestamp(now + CHALLENGE_LIFETIME_MS),
    public_key: {
      attestation: "none",
      authenticatorSelection: {
        requireResidentKey: true,
        residentKey: "required",
        userVerification: "required",
      },
      challenge,
      excludeCredentials,
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" },
      ],
      rp: { id: scope.rpId, name: "cfKanban" },
      timeout: CHALLENGE_LIFETIME_MS,
      user: {
        displayName: auth.displayName,
        id: principalUserHandle(auth.principalId),
        name: auth.displayName,
      },
    },
  };
}

export async function createWebAuthenticationOptions(
  db: D1Database,
  request: Request,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const scope = requestCeremonyScope(request);
  const challengeId = crypto.randomUUID();
  const challenge = randomBase64Url(32);
  await insertChallenge(db, null, null, scope, challengeId, await sha256Hex(challenge), now);
  return {
    challenge_id: challengeId,
    expires_at: timestamp(now + CHALLENGE_LIFETIME_MS),
    public_key: {
      challenge,
      rpId: scope.rpId,
      timeout: CHALLENGE_LIFETIME_MS,
      userVerification: "required",
    },
  };
}

async function consumeRejectedChallenge(
  db: D1Database,
  challengeId: string,
  purpose: ChallengeRow["purpose"],
  now: number,
): Promise<void> {
  try {
    await db.prepare(
      `UPDATE webauthn_challenges
       SET consumed_at = ?1
       WHERE id = ?2 AND purpose = ?3 AND consumed_at IS NULL AND expires_at > ?1`,
    ).bind(now, challengeId, purpose).run();
  } catch {
    throw platformUnavailable("d1");
  }
}

function registrationChallengeMatches(
  challenge: ChallengeRow | null,
  auth: CookieAuthContext,
  scope: { expectedOrigin: string; rpId: string },
  now: number,
): challenge is ChallengeRow {
  return challengeActive(challenge, "registration", now)
    && challenge.principal_id === auth.principalId
    && challenge.rp_id === scope.rpId
    && challenge.expected_origin === scope.expectedOrigin;
}

async function diagnoseRegistrationRejection(
  db: D1Database,
  auth: CookieAuthContext,
  challengeId: string,
  credentialId: string,
  scope: { expectedOrigin: string; rpId: string },
  now: number,
): Promise<never> {
  await authorizeAgentLaunchSession(db, auth, now);
  const challenge = await readChallenge(db, challengeId);
  if (!registrationChallengeMatches(challenge, auth, scope, now)) throw passkeyChallengeInvalid();
  if (await readAuthenticatorByCredential(db, credentialId) !== null) throw passkeyAlreadyRegistered();
  if (await activePasskeyCount(db, auth.principalId) >= PASSKEY_LIMIT) throw passkeyLimitReached();
  throw platformUnavailable("d1");
}

async function registerPasskeyBatch(
  db: D1Database,
  auth: CookieAuthContext,
  challenge: ChallengeRow,
  registered: RegisteredAuthenticator,
  authenticatorId: string,
  operationId: string,
  now: number,
): Promise<void> {
  const userHandle = principalUserHandle(auth.principalId);
  const transportsJson = JSON.stringify(registered.transports);
  const guard = buildCurrentAuthGuard(auth, now, 14);
  const snapshot = {
    algorithm: registered.algorithm,
    backup_eligible: registered.backupEligible,
    backup_state: registered.backupState,
    created_at: timestamp(now),
    id: authenticatorId,
    last_used_at: null,
    revoked_at: null,
    rp_id: challenge.rp_id,
    transports: registered.transports,
    version: 1,
  };
  try {
    await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE webauthn_challenges
           SET consumed_at = ?1, last_operation_id = ?2
           WHERE id = ?3 AND challenge_digest = ?4 AND purpose = 'registration'
             AND principal_id = ?5 AND rp_id = ?6 AND expected_origin = ?7
             AND consumed_at IS NULL AND expires_at > ?1`,
        ).bind(
          now,
          operationId,
          challenge.id,
          challenge.challenge_digest,
          auth.principalId,
          challenge.rp_id,
          challenge.expected_origin,
        ),
        db.prepare(
          `INSERT INTO web_authenticators
            (id, principal_id, credential_id, public_key_cose, algorithm,
             user_handle, sign_count, backup_eligible, backup_state,
             transports_json, rp_id, version, created_at, created_operation_id,
             last_operation_id)
           SELECT ?1, challenge.principal_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                  ?9, ?10, 1, ?11, ?12, ?12
           FROM webauthn_challenges challenge
           WHERE challenge.id = ?13 AND challenge.last_operation_id = ?12
             AND ${guard.sql}
             AND EXISTS (
               SELECT 1 FROM web_sessions registration_session
               WHERE registration_session.id = ?14
                 AND registration_session.source_kind = 'credential'
             )
             AND NOT EXISTS (
               SELECT 1 FROM web_authenticators duplicate
               WHERE duplicate.credential_id = ?2
             )
             AND (SELECT COUNT(*) FROM web_authenticators active_passkey
                  WHERE active_passkey.principal_id = challenge.principal_id
                    AND active_passkey.revoked_at IS NULL) < ?17`,
        ).bind(
          authenticatorId,
          registered.credentialId,
          registered.publicKeyCose,
          registered.algorithm,
          userHandle,
          registered.signCount,
          registered.backupEligible ? 1 : 0,
          registered.backupState ? 1 : 0,
          transportsJson,
          challenge.rp_id,
          now,
          operationId,
          challenge.id,
          ...guard.values,
          PASSKEY_LIMIT,
        ),
        operationSnapshotStatement(db, operationId, snapshot),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'passkey.registered', ?2, 0, ?3, ?4, ?5,
                  'web_authenticator', authenticator.id,
                  json_object('algorithm', authenticator.algorithm,
                              'backup_eligible', json(authenticator.backup_eligible),
                              'rp_id', authenticator.rp_id,
                              'version', authenticator.version), ?6
           FROM web_authenticators authenticator
           WHERE authenticator.id = ?7 AND authenticator.last_operation_id = ?2`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          authorizedVia(auth),
          now,
          authenticatorId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          return await diagnoseRegistrationRejection(
            db,
            auth,
            challenge.id,
            registered.credentialId,
            { expectedOrigin: challenge.expected_origin, rpId: challenge.rp_id },
            now,
          );
        } catch (error) {
          if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
          throw error;
        }
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: authenticatorId,
      primarySubjectType: "web_authenticator",
      requireIdempotencySnapshot: true,
    });
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      try {
        return await diagnoseRegistrationRejection(
          db,
          auth,
          challenge.id,
          registered.credentialId,
          { expectedOrigin: challenge.expected_origin, rpId: challenge.rp_id },
          now,
        );
      } catch (diagnosis) {
        if (diagnosis instanceof ApiError && diagnosis.code !== "PLATFORM_UNAVAILABLE") {
          // The credential was already cryptographically verified. A
          // deterministic duplicate/limit/auth rejection still consumes the
          // first verification attempt; callers must request fresh options.
          await consumeRejectedChallenge(db, challenge.id, "registration", now);
        }
        throw diagnosis;
      }
    }
    throw error;
  }
}

export async function registerPasskey(
  db: D1Database,
  request: Request,
  auth: CookieAuthContext,
  challengeIdValue: JsonValue,
  credential: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const challengeId = requireUuid(challengeIdValue, "challenge_id");
  const scope = requestCeremonyScope(request);
  const result = await runIdempotentOperation({
    authorize: () => authorizeAgentLaunchSession(db, auth, now),
    db,
    execute: async (operationId) => {
      const challenge = await readChallenge(db, challengeId);
      if (!registrationChallengeMatches(challenge, auth, scope, now)) throw passkeyChallengeInvalid();
      let registered: RegisteredAuthenticator;
      try {
        registered = await verifyRegistrationCredential(credential, {
          challengeDigest: challenge.challenge_digest,
          expectedOrigin: scope.expectedOrigin,
          rpId: scope.rpId,
        });
      } catch (error) {
        if (error instanceof WebAuthnVerificationError) {
          await consumeRejectedChallenge(db, challengeId, "registration", now);
          throw passkeyChallengeInvalid();
        }
        throw error;
      }
      await registerPasskeyBatch(
        db,
        auth,
        challenge,
        registered,
        crypto.randomUUID(),
        operationId,
        now,
      );
    },
    idempotencyKey: requireIdempotencyKey(request),
    method: "POST",
    normalizedResourceScope: `principal:${auth.principalId}:passkey:${challengeId}`,
    now,
    readback: async (operationId, commit) => ({
      body: await writeResult(
        db,
        auth,
        await readOperationSnapshot<{ [key: string]: JsonValue }>(db, operationId),
        commit.lastEventSequence,
        false,
      ),
      status: 200,
    }),
    requestBody: { challenge_id: challengeId, credential },
    routeTemplate: "/api/v1/me/passkeys",
    scopeKey: `principal:${auth.principalId}`,
  });
  return { ...(result.body as { [key: string]: JsonValue }), idempotent_replay: result.idempotentReplay };
}

export async function listMyPasskeys(
  db: D1Database,
  auth: CookieAuthContext,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  try {
    const rows = await db.prepare(
      `${AUTHENTICATOR_SELECT}
       WHERE authenticator.principal_id = ?1
       ORDER BY authenticator.created_at DESC, authenticator.id DESC
       LIMIT ?2`,
    ).bind(auth.principalId, PASSKEY_LIMIT + 1).all<AuthenticatorRow>();
    const result = {
      items: rows.results.slice(0, PASSKEY_LIMIT).map(authenticatorResource),
      truncated: rows.results.length > PASSKEY_LIMIT,
    };
    // A Session/source revoke between route authentication and the list query
    // must not expose the Principal's authenticator inventory.
    await verifyCurrentAuth(db, auth, now);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw platformUnavailable("d1");
  }
}

async function diagnosePasskeyRevocation(
  db: D1Database,
  auth: AuthContext,
  passkeyId: string,
  expectedVersion: number,
  self: boolean,
  now: number,
): Promise<never> {
  await verifyCurrentAuth(db, auth, now);
  if (!self) requireOwnerControl(auth);
  const row = await readAuthenticatorById(db, passkeyId);
  if (row === null || (self && row.principal_id !== auth.principalId) || row.revoked_at !== null) {
    throw passkeyNotFound();
  }
  if (!self) {
    try {
      const owner = await db.prepare(
        "SELECT owner_principal_id FROM instance_meta WHERE singleton = 1",
      ).first<{ owner_principal_id: string }>();
      if (owner === null) throw platformUnavailable("d1");
      if (row.principal_id === owner.owner_principal_id) throw forbidden();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw platformUnavailable("d1");
    }
  }
  if (row.version !== expectedVersion) throw versionConflict(row.version);
  throw platformUnavailable("d1");
}

async function revokePasskey(
  db: D1Database,
  auth: AuthContext,
  passkeyIdValue: JsonValue,
  expectedVersion: number,
  self: boolean,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  const passkeyId = requireUuid(passkeyIdValue, "passkey_id");
  if (!self) requireOwnerControl(auth);
  const current = await readAuthenticatorById(db, passkeyId);
  if (current === null || (self && current.principal_id !== auth.principalId) || current.revoked_at !== null) {
    throw passkeyNotFound();
  }
  if (!self) {
    try {
      const instance = await db.prepare(
        "SELECT owner_principal_id FROM instance_meta WHERE singleton = 1",
      ).first<{ owner_principal_id: string }>();
      if (instance === null) throw platformUnavailable("d1");
      if (current.principal_id === instance.owner_principal_id) throw forbidden();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw platformUnavailable("d1");
    }
  }
  if (current.version !== expectedVersion) throw versionConflict(current.version);

  const operationId = crypto.randomUUID();
  const guard = buildCurrentAuthGuard(auth, now, 8, !self);
  let commit: OperationCommit;
  try {
    ({ commit } = await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE web_authenticators AS authenticator
           SET revoked_at = ?1, revoked_by_principal_id = ?2,
               version = version + 1, last_operation_id = ?3
           WHERE authenticator.id = ?4 AND authenticator.principal_id = ?5
             AND authenticator.version = ?6 AND authenticator.revoked_at IS NULL
             AND ${self ? "?5 = ?7" : `EXISTS (
               SELECT 1 FROM instance_meta target_instance
               WHERE target_instance.singleton = 1
                 AND target_instance.owner_principal_id <> authenticator.principal_id
             )`}
             AND ${guard.sql}`,
        ).bind(
          now,
          auth.principalId,
          operationId,
          passkeyId,
          current.principal_id,
          expectedVersion,
          self ? auth.principalId : null,
          ...guard.values,
        ),
        db.prepare(
          `UPDATE web_sessions
           SET revoked_at = ?1, last_operation_id = ?2
           WHERE source_kind = 'web_authenticator' AND source_id = ?3
             AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM web_authenticators revoked_authenticator
               WHERE revoked_authenticator.id = ?3
                 AND revoked_authenticator.last_operation_id = ?2
             )`,
        ).bind(now, operationId, passkeyId),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'passkey.revoked', ?2, 0, ?3, ?4, ?5,
                  'web_authenticator', authenticator.id,
                  json_object('principal_id', authenticator.principal_id,
                              'version', authenticator.version), ?6
           FROM web_authenticators authenticator
           WHERE authenticator.id = ?7 AND authenticator.last_operation_id = ?2`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          auth.principalId,
          actorCredentialId(auth),
          authorizedVia(auth, !self),
          now,
          passkeyId,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        try {
          await diagnosePasskeyRevocation(db, auth, passkeyId, expectedVersion, self, now);
        } catch (error) {
          if (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE") return true;
          throw error;
        }
        return false;
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: passkeyId,
      primarySubjectType: "web_authenticator",
    }));
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      return diagnosePasskeyRevocation(db, auth, passkeyId, expectedVersion, self, now);
    }
    throw error;
  }

  const revoked = await readAuthenticatorById(db, passkeyId);
  if (revoked === null || revoked.last_operation_id !== operationId) throw platformUnavailable("d1");
  return writeResult(db, auth, authenticatorResource(revoked), commit.lastEventSequence, false);
}

export async function revokeMyPasskey(
  db: D1Database,
  auth: CookieAuthContext,
  passkeyId: JsonValue,
  expectedVersionValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return revokePasskey(
    db,
    auth,
    passkeyId,
    requireVersion(expectedVersionValue),
    true,
    now,
  );
}

export async function revokePrincipalPasskey(
  db: D1Database,
  auth: AuthContext,
  passkeyId: JsonValue,
  expectedVersionValue: JsonValue,
  now: number,
): Promise<{ [key: string]: JsonValue }> {
  return revokePasskey(
    db,
    auth,
    passkeyId,
    requireVersion(expectedVersionValue),
    false,
    now,
  );
}

function authenticationChallengeMatches(
  challenge: ChallengeRow | null,
  authenticator: AuthenticatorRow | null,
  scope: { expectedOrigin: string; rpId: string },
  now: number,
): challenge is ChallengeRow {
  return challengeActive(challenge, "authentication", now)
    && challenge.principal_id === null
    && challenge.rp_id === scope.rpId
    && challenge.expected_origin === scope.expectedOrigin
    && authenticator !== null
    && authenticator.revoked_at === null
    && authenticator.rp_id === scope.rpId;
}

function assertionUserHandle(value: JsonValue): string {
  if (value === null || Array.isArray(value) || typeof value !== "object") return "AA";
  const response = value.response;
  if (response === null || Array.isArray(response) || typeof response !== "object") return "AA";
  return typeof response.userHandle === "string" ? response.userHandle : "AA";
}

async function equalizeUnusableCredentialFailure(
  credential: JsonValue,
  challenge: ChallengeRow | null,
  scope: { expectedOrigin: string; rpId: string },
): Promise<void> {
  let credentialId: string;
  try {
    credentialId = webAuthnCredentialId(credential);
  } catch {
    return;
  }
  try {
    await verifyAuthenticationCredential(credential, {
      algorithm: -7,
      backupEligible: false,
      challengeDigest: challenge?.challenge_digest ?? FAILURE_EQUALIZATION_CHALLENGE_DIGEST,
      credentialId,
      expectedOrigin: scope.expectedOrigin,
      publicKeyCose: FAILURE_EQUALIZATION_PUBLIC_KEY_COSE,
      rpId: scope.rpId,
      userHandle: assertionUserHandle(credential),
    });
  } catch {
    // The fixed public key intentionally cannot authenticate caller input.
  }
}

function passkeySessionResource(
  snapshot: SessionSnapshot,
  cookieAvailable: boolean,
): { [key: string]: JsonValue } {
  return {
    allowed_scope: snapshot.is_owner
      ? { kind: "instance" }
      : { kind: "project_selection" },
    cookie_available: cookieAvailable,
    entry_path: snapshot.entry_path,
    expires_at: timestamp(snapshot.expires_at),
    principal: {
      display_name: snapshot.display_name,
      id: snapshot.principal_id,
      is_owner: snapshot.is_owner,
    },
    session_id: snapshot.session_id,
    source: { id: snapshot.source_id, kind: snapshot.source_kind },
    target: snapshot.target,
  };
}

async function recordCounterAnomaly(
  db: D1Database,
  challenge: ChallengeRow,
  authenticator: AuthenticatorRow,
  observedSignCount: number,
  now: number,
): Promise<void> {
  const operationId = crypto.randomUUID();
  try {
    await executeAtomicBatch(db, {
      businessStatements: [
        db.prepare(
          `UPDATE webauthn_challenges
           SET consumed_at = ?1, last_operation_id = ?2
           WHERE id = ?3 AND challenge_digest = ?4 AND purpose = 'authentication'
             AND consumed_at IS NULL AND expires_at > ?1`,
        ).bind(now, operationId, challenge.id, challenge.challenge_digest),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'passkey.counter-anomaly', ?2, 0,
                  ?3, NULL, 'webauthn', 'web_authenticator', ?4,
                  json_object('observed_sign_count', ?5,
                              'stored_sign_count', ?6), ?7
           FROM webauthn_challenges challenge
           WHERE challenge.id = ?8 AND challenge.last_operation_id = ?2
             AND EXISTS (
               SELECT 1 FROM web_authenticators authenticator
               WHERE authenticator.id = ?4 AND authenticator.revoked_at IS NULL
             )`,
        ).bind(
          crypto.randomUUID(),
          operationId,
          authenticator.principal_id,
          authenticator.id,
          observedSignCount,
          authenticator.sign_count,
          now,
          challenge.id,
        ),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const currentChallenge = await readChallenge(db, challenge.id);
        const currentAuthenticator = await readAuthenticatorById(db, authenticator.id);
        return !challengeActive(currentChallenge, "authentication", now)
          || currentAuthenticator === null
          || currentAuthenticator.revoked_at !== null;
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: authenticator.id,
      primarySubjectType: "web_authenticator",
    });
  } catch (error) {
    if (!(error instanceof AtomicBatchRejectedError)) throw error;
  }
}

async function authenticatePasskeyBatch(
  db: D1Database,
  challenge: ChallengeRow,
  authenticator: AuthenticatorRow,
  assertion: Awaited<ReturnType<typeof verifyAuthenticationCredential>>,
  operationId: string,
  sessionId: string,
  sessionTokenDigest: string,
  csrfDigest: string,
  now: number,
): Promise<OperationCommit> {
  const target = authenticator.principal_id;
  try {
    const { commit } = await executeAtomicBatch(db, {
      businessStatements: [
        webSessionCleanupStatement(db, now),
        db.prepare(
          `UPDATE webauthn_challenges
           SET consumed_at = ?1, last_operation_id = ?2
           WHERE id = ?3 AND challenge_digest = ?4 AND purpose = 'authentication'
             AND principal_id IS NULL AND rp_id = ?5 AND expected_origin = ?6
             AND consumed_at IS NULL AND expires_at > ?1`,
        ).bind(
          now,
          operationId,
          challenge.id,
          challenge.challenge_digest,
          challenge.rp_id,
          challenge.expected_origin,
        ),
        db.prepare(
          `UPDATE web_authenticators
           SET sign_count = ?1, backup_state = ?2,
               last_used_at = CASE
                 WHEN last_used_at IS NULL OR last_used_at <= ?3 - 86400000 THEN ?3
                 ELSE last_used_at
               END,
               version = version + 1, last_operation_id = ?4
           WHERE id = ?5 AND principal_id = ?6 AND credential_id = ?7
             AND rp_id = ?8 AND revoked_at IS NULL AND version = ?9
             AND sign_count = ?10
             AND ((sign_count = 0 AND ?1 = 0) OR ?1 > sign_count)
             AND EXISTS (
               SELECT 1 FROM webauthn_challenges challenge
               WHERE challenge.id = ?11 AND challenge.last_operation_id = ?4
             )`,
        ).bind(
          assertion.signCount,
          assertion.backupState ? 1 : 0,
          now,
          operationId,
          authenticator.id,
          authenticator.principal_id,
          authenticator.credential_id,
          authenticator.rp_id,
          authenticator.version,
          authenticator.sign_count,
          challenge.id,
        ),
        db.prepare(
          `INSERT INTO web_sessions
            (id, token_digest, principal_id, source_kind, source_id, target_kind,
             target_json, expires_at, created_at, created_operation_id,
             last_operation_id)
           SELECT ?1, ?2, authenticator.principal_id, 'web_authenticator', authenticator.id,
                  CASE WHEN instance.owner_principal_id = authenticator.principal_id
                       THEN 'admin' ELSE 'project_selection' END,
                  CASE WHEN instance.owner_principal_id = authenticator.principal_id
                       THEN json_object('entry_path', '/app/admin', 'kind', 'admin', 'section', 'overview')
                       ELSE json_object('entry_path', '/app', 'kind', 'project_selection') END,
                  ?3, ?4, ?5, ?5
           FROM web_authenticators authenticator
           JOIN instance_meta instance ON instance.singleton = 1
           WHERE authenticator.id = ?6 AND authenticator.last_operation_id = ?5`,
        ).bind(
          sessionId,
          sessionTokenDigest,
          now + SESSION_LIFETIME_MS,
          now,
          operationId,
          authenticator.id,
        ),
        db.prepare(
          `UPDATE idempotency_records
           SET operation_snapshot_json = (
             SELECT json_object(
               'csrf_digest', ?1,
               'display_name', principal.display_name,
               'entry_path', json_extract(session.target_json, '$.entry_path'),
               'expires_at', session.expires_at,
               'is_owner', json(CASE WHEN instance.owner_principal_id = session.principal_id THEN 'true' ELSE 'false' END),
               'principal_id', session.principal_id,
               'session_id', session.id,
               'session_token_digest', session.token_digest,
               'source_id', session.source_id,
               'source_kind', session.source_kind,
               'target', json(session.target_json)
             )
             FROM web_sessions session
             JOIN principals principal ON principal.id = session.principal_id
             JOIN instance_meta instance ON instance.singleton = 1
             WHERE session.id = ?2 AND session.created_operation_id = ?3
           )
           WHERE operation_id = ?3 AND state = 'pending'`,
        ).bind(csrfDigest, sessionId, operationId),
        db.prepare(
          `INSERT INTO events
            (id, stream, type, operation_id, event_index, actor_principal_id,
             actor_credential_id, authorized_via, subject_type, subject_id,
             payload_json, created_at)
           SELECT ?1, 'security', 'passkey.authenticated', ?2, 0,
                  authenticator.principal_id, NULL, 'webauthn',
                  'web_authenticator', authenticator.id,
                  json_object('backup_eligible', json(authenticator.backup_eligible),
                              'backup_state', json(authenticator.backup_state),
                              'rp_id', authenticator.rp_id,
                              'sign_count', authenticator.sign_count), ?3
           FROM web_authenticators authenticator
           WHERE authenticator.id = ?4 AND authenticator.last_operation_id = ?2
             AND EXISTS (
               SELECT 1 FROM web_sessions session
               WHERE session.id = ?5 AND session.created_operation_id = ?2
             )`,
        ).bind(crypto.randomUUID(), operationId, now, authenticator.id, sessionId),
      ],
      committedAt: now,
      confirmBusinessRejection: async () => {
        const currentChallenge = await readChallenge(db, challenge.id);
        const currentAuthenticator = await readAuthenticatorById(db, authenticator.id);
        return !challengeActive(currentChallenge, "authentication", now)
          || currentAuthenticator === null
          || currentAuthenticator.revoked_at !== null
          || currentAuthenticator.version !== authenticator.version
          || !counterAdvances(currentAuthenticator.sign_count, assertion.signCount);
      },
      expectedEventCount: 1,
      operationId,
      primarySubjectId: sessionId,
      primarySubjectType: "web_session",
      requireIdempotencySnapshot: true,
    });
    return commit;
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) throw error;
    throw error;
  }
}

async function rejectAuthenticationAttempt(
  db: D1Database,
  claim: Awaited<ReturnType<typeof claimIdempotency>>,
  challengeId: string,
  now: number,
): Promise<never> {
  const peerCommit = await probeOperationCommit(db, claim.operationId);
  if (peerCommit !== null) throw new AtomicBatchRejectedError();
  await consumeRejectedChallenge(db, challengeId, "authentication", now);
  await abandonOwnedPendingClaim(db, claim);
  throw unauthorized();
}

export async function verifyWebAuthentication(
  db: D1Database,
  request: Request,
  challengeIdValue: JsonValue,
  credential: JsonValue,
  now: number,
): Promise<SessionExchangeResult> {
  let challengeId: string;
  try {
    challengeId = requireUuid(challengeIdValue, "challenge_id");
  } catch {
    // Public verification deliberately does not distinguish malformed,
    // unknown, expired, consumed, or otherwise unusable challenges.
    throw unauthorized();
  }
  const scope = requestCeremonyScope(request);
  const claim = await claimIdempotency(db, {
    idempotencyKey: requireIdempotencyKey(request),
    method: "POST",
    normalizedResourceScope: `webauthn-challenge:${challengeId}`,
    requestBody: { challenge_id: challengeId, credential },
    routeTemplate: "/api/v1/web-authentication/verify",
    scopeKey: `webauthn-challenge:${challengeId}`,
  }, now);
  if (claim.state === "committed") {
    const stored = readIdempotencyResponse<{ [key: string]: JsonValue }>(claim);
    return {
      body: {
        ...stored.body,
        idempotent_replay: true,
        resource: {
          ...(stored.body.resource as { [key: string]: JsonValue }),
          cookie_available: false,
        },
      },
      csrfToken: null,
      sessionToken: null,
    };
  }

  let commit = await probeOperationCommit(db, claim.operationId);
  let generatedSessionToken: string | null = null;
  let generatedCsrfToken: string | null = null;
  let generatedSessionDigest: string | null = null;
  let generatedCsrfDigest: string | null = null;
  if (commit === null) {
    let challenge: ChallengeRow | null = null;
    let authenticator: AuthenticatorRow | null = null;
    let assertion: Awaited<ReturnType<typeof verifyAuthenticationCredential>> | null = null;
    try {
      challenge = await readChallenge(db, challengeId);
      const credentialId = webAuthnCredentialId(credential);
      authenticator = await readAuthenticatorByCredential(db, credentialId);
      if (authenticator === null || !authenticationChallengeMatches(challenge, authenticator, scope, now)) {
        await equalizeUnusableCredentialFailure(credential, challenge, scope);
        return rejectAuthenticationAttempt(db, claim, challengeId, now);
      }
      const activeAuthenticator = authenticator;
      assertion = await verifyAuthenticationCredential(credential, {
        algorithm: activeAuthenticator.algorithm,
        backupEligible: activeAuthenticator.backup_eligible === 1,
        challengeDigest: challenge.challenge_digest,
        credentialId: activeAuthenticator.credential_id,
        expectedOrigin: scope.expectedOrigin,
        publicKeyCose: activeAuthenticator.public_key_cose,
        rpId: scope.rpId,
        userHandle: activeAuthenticator.user_handle,
      });
    } catch (error) {
      if (error instanceof AtomicBatchRejectedError) {
        commit = await probeOperationCommit(db, claim.operationId);
      } else if (
        error instanceof WebAuthnVerificationError
        || (error instanceof ApiError && error.code !== "PLATFORM_UNAVAILABLE")
      ) {
        return rejectAuthenticationAttempt(db, claim, challengeId, now);
      } else {
        throw error;
      }
    }

    if (commit === null && challenge !== null && authenticator !== null && assertion !== null) {
      if (!counterAdvances(authenticator.sign_count, assertion.signCount)) {
        const peer = await probeOperationCommit(db, claim.operationId);
        if (peer !== null) {
          commit = peer;
        } else {
          await recordCounterAnomaly(db, challenge, authenticator, assertion.signCount, now);
          await abandonOwnedPendingClaim(db, claim);
          throw unauthorized();
        }
      }
      if (commit === null) {
        generatedSessionToken = randomBase64Url(32);
        generatedCsrfToken = randomBase64Url(32);
        [generatedSessionDigest, generatedCsrfDigest] = await Promise.all([
          sha256Hex(generatedSessionToken),
          sha256Hex(generatedCsrfToken),
        ]);
        try {
          commit = await authenticatePasskeyBatch(
            db,
            challenge,
            authenticator,
            assertion,
            claim.operationId,
            crypto.randomUUID(),
            generatedSessionDigest,
            generatedCsrfDigest,
            now,
          );
        } catch (error) {
          commit = await probeOperationCommit(db, claim.operationId);
          if (commit === null) {
            if (!(error instanceof AtomicBatchRejectedError)) throw error;
            const latest = await readAuthenticatorById(db, authenticator.id);
            if (
              latest !== null
              && latest.revoked_at === null
              && !counterAdvances(latest.sign_count, assertion.signCount)
            ) {
              await recordCounterAnomaly(db, challenge, latest, assertion.signCount, now);
              await abandonOwnedPendingClaim(db, claim);
              throw unauthorized();
            }
            await abandonOwnedPendingClaim(db, claim);
            throw unauthorized();
          }
        }
      }
    }
  }
  if (commit === null) throw unauthorized();

  let snapshot: SessionSnapshot;
  try {
    snapshot = await readOperationSnapshot<SessionSnapshot>(db, claim.operationId);
  } catch (error) {
    if (error instanceof AtomicBatchRejectedError) {
      const peer = await readFinalizedIdempotencyResponse<{ [key: string]: JsonValue }>(db, claim.operationId);
      if (peer !== null) {
        return {
          body: { ...peer.body, idempotent_replay: true },
          csrfToken: null,
          sessionToken: null,
        };
      }
    }
    throw error;
  }
  const safeBody = {
    event_cursor: await eventCursor(
      db,
      { principalId: snapshot.principal_id },
      commit.lastEventSequence,
    ),
    idempotent_replay: false,
    resource: passkeySessionResource(snapshot, false),
  };
  if (
    generatedSessionToken === null
    || generatedCsrfToken === null
    || generatedSessionDigest !== snapshot.session_token_digest
    || generatedCsrfDigest !== snapshot.csrf_digest
  ) {
    return { body: { ...safeBody, idempotent_replay: true }, csrfToken: null, sessionToken: null };
  }
  const finalized = await finalizeIdempotency(
    db,
    claim.operationId,
    { body: safeBody, status: 200 },
    [generatedSessionToken, generatedCsrfToken],
    now,
  );
  return {
    body: {
      ...finalized.body,
      resource: passkeySessionResource(snapshot, true),
    },
    csrfToken: generatedCsrfToken,
    sessionToken: generatedSessionToken,
  };
}
