/**
 * Token exchange for Tower cloud registration.
 *
 * Shared between CLI (tower-cloud.ts) and Tower server (tower-tunnel.ts)
 * for exchanging an OAuth registration token for API credentials.
 */

/**
 * Exchange a registration token for API key and tower ID.
 *
 * POSTs to {serverUrl}/api/towers/register/redeem with the token,
 * tower name, and machine ID. Handles 301/302 redirects manually
 * to preserve the POST method (fetch follows redirects as GET).
 */
export async function redeemToken(
  serverUrl: string,
  token: string,
  towerName: string,
  machineId: string,
): Promise<{ towerId: string; apiKey: string }> {
  const url = `${serverUrl}/api/towers/register/redeem`;
  const body = JSON.stringify({ token, name: towerName, machineId });

  // Use manual redirect to preserve POST method across 301/302 redirects
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  }).then((res) => {
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        return fetch(location, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      }
    }
    return res;
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Registration failed (${response.status}): ${text || response.statusText}`);
  }

  const data = (await response.json()) as { towerId?: string; apiKey?: string };

  if (!data.towerId || !data.apiKey) {
    throw new Error('Invalid response from registration server: missing towerId or apiKey');
  }

  return { towerId: data.towerId, apiKey: data.apiKey };
}
