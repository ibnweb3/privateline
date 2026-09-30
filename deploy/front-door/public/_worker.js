// PrivateLine's front door on Cloudflare Pages: https://privateline.pages.dev.
// The app runs on the server next to the Canton stack, so this only forwards each request there.
// It adds the visitor's address, because the app's rate limits are per visitor, and FRONT_DOOR_KEY
// (a Pages secret, also in the server's app/.env), which proves the address came from here.
// ORIGIN, the server's own https address, is a Pages secret too. Deployed by deploy/front-door.sh.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-front-door-client", request.headers.get("cf-connecting-ip") ?? "");
    headers.set("x-front-door-key", env.FRONT_DOOR_KEY ?? "");
    return fetch(env.ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
};
