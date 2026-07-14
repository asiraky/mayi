import { createDatabase } from "./index";

const database = createDatabase();
try {
  console.log("No required seed data; sign up to create a personal workspace.");
} finally {
  await database.close();
}
