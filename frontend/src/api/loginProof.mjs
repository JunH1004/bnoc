export function acceptsLoginMessage(event, popup, challenge) {
  if (!popup || !challenge || event.source !== popup) return false;
  let origin;
  try { origin = new URL(challenge.providerUrl).origin; } catch { return false; }
  return event.origin === origin && event.data?.type === 'bnoc-auth'
    && event.data.loginAttempt === challenge.loginAttempt
    && typeof event.data.ticket === 'string' && event.data.ticket.length > 0;
}
