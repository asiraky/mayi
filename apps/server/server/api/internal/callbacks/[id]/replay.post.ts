import { createError, defineEventHandler, getRouterParam } from "h3";
import { Id } from "@mayi/contracts";
import { CallbackDeliveryError, replayDeadLetterCallback } from "../../../../utils/callback-outbox";
import { requireCronSecret } from "../../../../utils/internal-auth";

export default defineEventHandler(async (event) => {
  requireCronSecret(event);
  const id = Id.parse(getRouterParam(event, "id"));
  try {
    return await replayDeadLetterCallback(id);
  } catch (error) {
    if (error instanceof CallbackDeliveryError && error.code === "callback_not_dead_lettered") {
      throw createError({ statusCode: 409, statusMessage: "Callback is not dead-lettered" });
    }
    if (error instanceof CallbackDeliveryError && error.code === "callback_replay_window_expired") {
      throw createError({ statusCode: 410, statusMessage: "Callback replay window has expired" });
    }
    throw error;
  }
});
