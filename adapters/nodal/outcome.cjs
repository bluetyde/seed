"use strict";
// NODAL's mapping from the runner's final reply to the wrapper's status (see adapters/shared/job.cjs). Differs from the default in two ways: a run
// folder that did not validate is a failure whatever the status says, and the model's own stop-advancement trip ends a run on purpose: it is
// reported as a trip (status "tripped"), never as a result.

module.exports = function outcome({ reply, code, signal, stderr }) {
  const failed = (detail) => ({ status: "failed", detail });
  const folderIssues = reply && Array.isArray(reply.folderIssues) ? reply.folderIssues : [];
  if (reply && reply.ok === true && reply.status === "completed") {
    if (code === 0 && folderIssues.length === 0) return { status: "finished" };
    return failed("the run folder did not validate: " + (folderIssues[0] ? folderIssues[0].code : "exit " + code));
  }
  if (reply && reply.ok === true && folderIssues.length > 0) return failed("the run folder did not validate: " + folderIssues[0].code);
  if (reply && reply.ok === true && reply.status === "terminated-by-trip") return { status: "tripped", detail: "the run stopped on its stop-advancement trip" };
  if (reply && reply.ok === true && reply.status) return failed("the run ended " + reply.status + (reply.reason ? ": " + reply.reason : ""));
  if (reply && Array.isArray(reply.errors) && reply.errors[0]) return failed("the runner refused the model: " + reply.errors[0].code + " " + reply.errors[0].message);
  return failed("the runner exited with " + (signal || code) + (stderr ? ": " + String(stderr).trim().slice(-300) : ""));
};
