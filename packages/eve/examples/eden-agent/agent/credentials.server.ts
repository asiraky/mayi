interface EdenCredentials {
  getAccessToken(integration: "mayi"): Promise<string>;
}

/**
 * Eden replaces this placeholder with its generated credential binding. Eden
 * owns the Mayi OAuth grant and refreshes it; the agent receives only a current
 * access token when the channel makes an authenticated request.
 */
export const credentials: EdenCredentials = {
  async getAccessToken() {
    throw new Error("Eden must inject the generated Mayi OAuth credential binding");
  },
};
