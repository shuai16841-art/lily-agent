import "dotenv/config";
import { getDatabase } from "./lib/db.js";
import { startQueueWorker } from "./lib/queue.js";

await getDatabase().initialize();
startQueueWorker();
console.log("Lily background worker is running.");
