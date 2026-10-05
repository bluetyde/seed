"use strict";
// Default mapping from a runner's one-line JSON reply to the wrapper's final status, used by adapters/shared/job.cjs unless an adapter names
// its own module (same signature). Returns {status: "finished" | "failed" | "cancelled" | <the app's own word>, detail?}.
//
// Only a reply that says `completed` with exit code 0 is a success. Everything else is a failure with the most specific reason available;
// a run that is cancelled, truncated or incomplete is never `finished`.

module.exports = function outcome({ reply, code, signal, stderr }) {
  if (reply && reply.ok === true && reply.status === "completed" && code === 0) return { status: "finished" };
  if (reply && reply.ok === true && reply.status === "cancelled") return { status: "cancelled", detail: "the runner reported the run cancelled" };
  if (reply && reply.ok === true && reply.status) return { status: "failed", detail: "the run ended " + reply.status + (reply.reason ? ": " + String(reply.reason).slice(0, 600) : "") };
  if (reply && reply.ok === true && reply.reason) return { status: "failed", detail: "the run ended failed: " + String(reply.reason).slice(0, 600) };
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return { status: "failed", detail: "the runner reported " + reply.errors[0].code + ": " + String(reply.errors[0].message).slice(-600) };
  return { status: "failed", detail: "the runner exited with " + (signal || code) + (stderr ? ": " + String(stderr).trim().slice(-300) : "") };
};
