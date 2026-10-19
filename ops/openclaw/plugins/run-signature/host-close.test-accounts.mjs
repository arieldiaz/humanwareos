// Test double for the Slack accounts runtime module.
export function resolveSlackAccount({accountId}) {
  return {botToken: `token-${accountId}`};
}

export async function removeOwnSlackReactions() {
  return [];
}
