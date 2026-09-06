import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function roomCode() {
  const bytes = randomBytes(6);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function eventId() {
  return randomBytes(8).toString("hex");
}
