/** Shared GitHub API helper. */
export function makeGhApi(token: string, agentName: string) {
  return async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": agentName,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
}
