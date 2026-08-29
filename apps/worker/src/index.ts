interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

const skeletonMessage = "cfKanban WP-01 engineering scaffold; business endpoints are not implemented.";

export function createSkeletonResponse(): Response {
  return new Response(skeletonMessage, {
    status: 501,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export default {
  fetch(): Response {
    return createSkeletonResponse();
  },
} satisfies ExportedHandler<Env>;
