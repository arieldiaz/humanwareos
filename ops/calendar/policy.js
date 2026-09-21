export function authorizeMutation(policy, {allowInbound = false, trustedRecipients = []} = {}) {
  if (!policy?.operationId || !policy.reason) throw new Error("mutation policy requires operationId and reason");
  if (policy.origin === "agent") {
    if (policy.approved !== true || typeof policy.actor !== "string" || !policy.actor.startsWith("agent:")) throw new Error("calendar mutations require an approved agent actor");
    return {...policy, recipient: null};
  }
  if (allowInbound && policy.origin === "inbound_invitation") {
    const recipient = policy.recipient?.toLowerCase();
    if (!recipient || !trustedRecipients.map((value) => value.toLowerCase()).includes(recipient)) throw new Error("invitation recipient is not trusted");
    return {...policy, actor: `inbound:${recipient}`, approved: true, recipient};
  }
  throw new Error("calendar mutations are agent-only except trusted inbound invitations");
}
