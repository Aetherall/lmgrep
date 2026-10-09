#!/usr/bin/env node
process.title = "lmgrep-mcp";

// Must come first — sets TOKIO/RAYON/UV thread caps before the LanceDB native
// binding initializes its runtime.
import "./infrastructure/lancedb/NativeTuning.js";

import { LmgrepCore } from "./presentation/mcp/LmgrepCore.js";
import { LmgrepMcpServer } from "./presentation/mcp/McpServer.js";

const core = await LmgrepCore.open({
	cwd: process.cwd(),
	database: process.env.LMGREP_DATABASE || undefined,
});

let shuttingDown = false;
const shutdown = (): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	core.dispose().finally(() => process.exit(0));
};
process.on("exit", () => {
	core.dispose().catch(() => {});
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A client that crashes or is killed sends no signal; its end of stdin just
// closes. The watcher keeps the event loop alive, so without these the server
// outlives every client that ever started it.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

await new LmgrepMcpServer(core).serve();
