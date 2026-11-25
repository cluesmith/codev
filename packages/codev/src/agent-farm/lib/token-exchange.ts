/**
 * Token exchange for Tower cloud registration.
 *
 * Shared between CLI (tower-cloud.ts) and Tower server (tower-tunnel.ts)
 * for exchanging an OAuth registration token for API credentials.
 */

/** What the cloud registered this tower as (Issue #1871). */
export interface RedeemResult {
  towerId: string;
  apiKey: string;
  /**
   * The routing identity (`/t/<slug>/`), derived by the cloud. It differs from
   * the requested name when that name was taken (`<name>-2`) or not slug-shaped.
   */
  slug: string;
  /** Display name, as the cloud stored it. */
  name: string;
}

/**
 * Exchange a registration token for API key and tower ID.
 *
 * POSTs to {serverUrl}/api/towers/register/redeem with the token,
 * tower name, and machine ID. Handles 301/302 redirects manually
 * to preserve the POST method (fetch follows redirects as GET).
 *
 * `claimSlug` asks the cloud to take the name over from a disconnected tower of
 * the same user instead of bumping to `<name>-2`; it is sent only when asked.
 * A cloud deployment that predates `slug`/`name` in the response gets the
 * requested name for both, which is what Tower assumed before #1871.
 */
export async function redeemToken(
  serverUrl: string,
  token: string,
  towerName: string,
  machineId: string,
  options: { claimSlug?: boolean } = {},
): Promise<RedeemResult> {
  const url = `${serverUrl}/api/towers/register/redeem`;
  const body = JSON.stringify({
    token,
    name: towerName,
    machineId,
    ...(options.claimSlug ? { claimSlug: true } : {}),
  });

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

  const data = (await response.json()) as {
    towerId?: string;
    apiKey?: string;
    slug?: unknown;
    name?: unknown;
  };

  if (!data.towerId || !data.apiKey) {
    throw new Error('Invalid response from registration server: missing towerId or apiKey');
  }

  return {
    towerId: data.towerId,
    apiKey: data.apiKey,
    slug: typeof data.slug === 'string' && data.slug ? data.slug : towerName,
    name: typeof data.name === 'string' && data.name ? data.name : towerName,
  };
}
