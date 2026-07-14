import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./index";

const database = createDatabase();
try {
  await migrate(database.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  console.log("Database migrations applied");
} finally {
  await database.close();
}
