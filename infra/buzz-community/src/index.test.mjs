import assert from "node:assert/strict";
import test from "node:test";

import { shouldRejectInviteClaim } from "./invite-gate.js";

const CLAIM_URL = "https://community.humanwareos.com/api/invites/claim";

function request({ method = "POST", origin } = {}) {
  return new Request(CLAIM_URL, {
    method,
    headers: origin ? { Origin: origin } : undefined,
  });
}

test("invite claims without a desktop Origin are rejected", () => {
  assert.equal(shouldRejectInviteClaim(request()), true);
  assert.equal(
    shouldRejectInviteClaim(request({ origin: "https://mobile.example" })),
    true,
  );
});

test("released Tauri desktop origins may claim invites", () => {
  assert.equal(
    shouldRejectInviteClaim(request({ origin: "tauri://localhost" })),
    false,
  );
  assert.equal(
    shouldRejectInviteClaim(request({ origin: "http://tauri.localhost" })),
    false,
  );
});

test("the gate does not affect preflight or other relay endpoints", () => {
  assert.equal(shouldRejectInviteClaim(request({ method: "OPTIONS" })), false);
  assert.equal(
    shouldRejectInviteClaim(
      new Request("https://community.humanwareos.com/events", {
        method: "POST",
      }),
    ),
    false,
  );
});
