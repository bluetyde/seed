import { sha256Hex } from "../../src/core/canonical";

/** A request id for running one oracle entry through a manager: "req-<oracleId>", or a hash of it when that would pass the 64-character id limit. */
export const oracleRequestId = (oracleId: string): string => {
  const plain = "req-" + oracleId;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(plain) ? plain : "req-" + sha256Hex(oracleId).slice(0, 32);
};
