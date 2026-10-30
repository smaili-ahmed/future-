import "dotenv/config";

import { initialize, seedIfEmpty } from "../src/db.js";
import { app } from "../src/server.js";

initialize();
seedIfEmpty();

export default app;
