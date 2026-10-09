export const PUBLIC_CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";

export function withPublicContentSignal(response: Response): Response {
  if (response.status !== 200 || !/^text\/(?:html|markdown|plain)(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-signal", PUBLIC_CONTENT_SIGNAL);
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}
