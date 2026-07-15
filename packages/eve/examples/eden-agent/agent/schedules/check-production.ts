import { defineSchedule } from "eve/schedules";
import mayi from "../channels/mayi";

export default defineSchedule({
  cron: "0 * * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(receive(mayi, {
      message: "Check production and deploy if needed.",
      target: { mayiUserId: "AbCdEfGhIjKl" },
      auth: appAuth,
    }));
  },
});
