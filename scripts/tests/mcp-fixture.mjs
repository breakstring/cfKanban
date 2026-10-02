import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPendingCredential, initializeStateRoot, promotePendingCredential, putInstanceMetadata } from "../../packages/skill-runtime/src/state.mjs";

// Every test owns an isolated home and fake HTTPS origin; this helper never touches user state or a network.
export async function createMcpStateFixture(t, overrides = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-mcp-isolated-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".cfkanban");
  const instanceId = overrides.instanceId ?? randomUUID();
  const principalId = overrides.principalId ?? randomUUID();
  const workspaceId = overrides.workspaceId ?? randomUUID();
  const projectId = overrides.projectId ?? randomUUID();
  const origin = overrides.origin ?? "https://mcp-fixture.invalid";
  await initializeStateRoot({ home, stateRoot, persistenceConfirmed: true });
  await putInstanceMetadata({ home, stateRoot, persistenceConfirmed: true, instanceId, trustedApiOrigin: origin, originVersion: 1 });
  const rotate = async () => {
    const credentialId = randomUUID();
    const pending = await createPendingCredential({ home, stateRoot, persistenceConfirmed: true, instanceId, principalId, credentialId, purpose: "owner_bootstrap", operationId: randomUUID(), idempotencyKey: randomUUID() });
    return promotePendingCredential({ stateRoot, instanceId, principalId, credentialId, fingerprint: pending.fingerprint });
  };
  const credential = await rotate();
  const discovery = { discovery_version: 1, instance_id: instanceId, observed_origin: origin, preferred_api_origin: origin, origin_version: 1 };
  const me = metadata => ({ id: principalId, principal_id: principalId, display_name: "MCPFixture", version: 1, is_owner: false, management_grants: [], grants: [{ workspace_id: workspaceId, project_id: projectId, role: "writer" }], allowed_actions: ["read"], credential: { id: metadata.credential_id, fingerprint: metadata.fingerprint } });
  return { home, stateRoot, instanceId, principalId, workspaceId, projectId, origin, credential, rotate, discovery, me };
}
