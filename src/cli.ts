#!/usr/bin/env node
process.title = "lmgrep";

// Must come first — sets TOKIO/RAYON/UV thread caps before the LanceDB native
// binding initializes its runtime.
import "./infrastructure/lancedb/NativeTuning.js";

import { Cli } from "./presentation/cli/Cli.js";

await new Cli().run();
