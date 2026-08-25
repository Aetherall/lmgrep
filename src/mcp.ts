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

const shutdown = (): void => {
	core.dispose().finally(() => process.exit(0));
};
process.on("exit", () => {
	core.dispose().catch(() => {});
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new LmgrepMcpServer(core).serve();
