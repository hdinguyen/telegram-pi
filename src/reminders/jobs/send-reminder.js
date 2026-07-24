import { parentPort, workerData } from "node:worker_threads";

function triggerReminder() {
  if (!parentPort) return;
  const { reminderId } = workerData;
  parentPort.postMessage({
    type: "reminder:trigger",
    reminderId,
    triggeredAt: new Date().toISOString(),
  });
  parentPort.postMessage("done");
}

triggerReminder();
