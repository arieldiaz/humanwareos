import {randomUUID} from "node:crypto";

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const COLOR = /^#[0-9a-f]{6}$/i;

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function email(value, name) {
  const normalized = required(value, name).toLowerCase();
  if (!EMAIL.test(normalized)) throw new Error(`${name} must be an email address`);
  return normalized;
}

export function normalizeCalendar(input, {id = randomUUID(), revision = 1, now = new Date().toISOString()} = {}) {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("calendar revision must be a positive integer");
  const color = input.color ?? "#3367d6";
  if (!COLOR.test(color)) throw new Error("calendar color must be a six-digit hex color");
  return {
    id: required(id, "calendar id"),
    revision,
    state: input.state ?? "active",
    name: required(input.name, "calendar name"),
    description: input.description ?? null,
    ownerAddress: email(input.ownerAddress, "calendar owner address"),
    managerAgents: [...new Set((input.managerAgents ?? []).map((actor) => required(actor, "manager agent")))].sort(),
    members: (input.members ?? []).map((member) => ({email: email(member.email, "member email"), name: member.name ?? null})),
    defaultForInbound: input.defaultForInbound === true,
    timeZone: required(input.timeZone ?? "UTC", "calendar time zone"),
    color: color.toLowerCase(),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export function reviseCalendar(current, patch, now = new Date().toISOString()) {
  if (patch.ownerAddress && patch.ownerAddress.toLowerCase() !== current.ownerAddress) throw new Error("calendar owner address is immutable");
  return normalizeCalendar({...current, ...patch, ownerAddress: current.ownerAddress, createdAt: current.createdAt}, {id: current.id, revision: current.revision + 1, now});
}
