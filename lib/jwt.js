// Minimal JWT payload decoder (no verification — we only read claims like
// `aud` and `exp` from tokens the browser already holds).
export function decodeJwt(jwt) {
  try {
    const payload = jwt.split(".")[1];
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Normalize a resource/audience to a bare origin (strip trailing slash) so
// tokens harvested from MSAL match the resources we request.
export function resourceOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}
