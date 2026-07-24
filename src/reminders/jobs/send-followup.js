import { parentPort, workerData } from "node:worker_threads";

function triggerFollowup() {
  if (!parentPort) return;
  const { occurrenceId } = workerData;
  parentPort.postMessage({
    type: "followup:trigger",
    occurrenceId,
    triggeredAt: new Date().toISOString(),
  });
  parentPort.postMessage("done");
}

triggerFollowup();
