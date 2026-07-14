import { z } from "zod";
import { createError, defineEventHandler } from "h3";
import { bodyAs } from "../../utils/http";
import { database } from "../../utils/runtime";
import { randomToken } from "../../utils/crypto";

const Registration = z.object({ client_name: z.string().min(1).max(100), redirect_uris: z.array(z.url()).min(1).max(5) });

export default defineEventHandler(async (event) => {
  const input = await bodyAs(event, Registration);
  for (const value of input.redirect_uris) {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
      throw createError({ statusCode: 400, statusMessage: "Redirect URIs must use HTTPS (localhost HTTP is allowed)" });
    }
  }
  const id = `mcp_${randomToken(18)}`;
  await database().sql`insert into oauth_clients (id, name, redirect_uris) values (${id}, ${input.client_name}, ${input.redirect_uris})`;
  return { client_id: id, client_name: input.client_name, redirect_uris: input.redirect_uris, token_endpoint_auth_method: "none" };
});
