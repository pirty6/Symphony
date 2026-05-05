import * as crypto from "node:crypto";

export function defaultClock(): string {
  return new Date().toISOString();
}

export function defaultPauseIdFactory(): string {
  return crypto.randomUUID();
}
