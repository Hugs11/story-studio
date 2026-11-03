/** Closing the question leaves the durable three-state choice untouched. */
export async function askLuniiPermission(api, ask, active = () => true) {
  const permission = await api.luniiPermission();
  if (permission !== null || !active()) return;
  const answer = await ask();
  if (typeof answer === 'boolean' && active()) await api.setLuniiPermission(answer);
}
