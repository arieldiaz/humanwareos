export const BUZZ_DESKTOP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
]);

export function shouldRejectInviteClaim(request, url = new URL(request.url)) {
  return (
    request.method === "POST" &&
    url.pathname === "/api/invites/claim" &&
    !BUZZ_DESKTOP_ORIGINS.has(request.headers.get("Origin") ?? "")
  );
}
