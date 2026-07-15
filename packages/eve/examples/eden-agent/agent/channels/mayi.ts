import { mayiChannel } from "@mayi/eve";
import { credentials } from "../credentials.server";

export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
});
