import { apiRequest } from "./transport.mjs";

const MAX_ITEMS = 3;
const MAX_BODY_CHARACTERS = 12_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function withNotificationAttention(input, result, { request = apiRequest, timeoutMs = 2_000 } = {}) {
  const pathname = new URL(input.apiPath, "https://cfkanban.invalid").pathname;
  if (/\/notifications(?:\/|$)|\/notification-preferences$/u.test(pathname)) return result;
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      request({
        stateRoot: input.stateRoot,
        instanceId: input.instanceId,
        method: "GET",
        apiPath: `/api/v1/me/notifications?pending=true&limit=${MAX_ITEMS}`,
        fetchImpl: (url, options) => (input.fetchImpl ?? globalThis.fetch)(url, { ...options, signal: controller.signal }),
      }),
      new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
      }),
    ]);
    if (!response?.ok || !Array.isArray(response.data?.items) || response.data.items.length > MAX_ITEMS) return result;
    let characters = 0;
    const notifications = [];
    for (const item of response.data.items) {
      if (!item || typeof item.id !== "string" || !UUID.test(item.id)
        || typeof item.title !== "string" || [...item.title].length > 200
        || typeof item.body !== "string" || [...item.body].length > 4_000
        || item.status !== "active" || item.acknowledged_at !== null) return result;
      characters += [...item.body].length;
      if (characters > MAX_BODY_CHARACTERS) return result;
      notifications.push({ id: item.id, title: item.title, body: item.body, created_at: item.created_at, expires_at: item.expires_at });
    }
    if (notifications.length === 0) return result;
    return { ...result, attention: {
      content_trust: "untrusted",
      notifications,
      has_more: response.data.next_cursor !== null && response.data.next_cursor !== undefined,
      acknowledgement: "explicit_after_delivery",
    } };
  } catch {
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
