// Bind-address policy for the webhook channels.
//
// The channels must only be reachable through Caddy TLS. Defaulting to loopback is not
// enough on its own: a .env copied from an older example still sets 0.0.0.0 explicitly,
// and an empty value slips past `??` and makes Node bind every interface. So anything
// other than a loopback address is a startup error, not something to quietly correct.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Read a channel's bind host, refusing anything that is not loopback.
 * @param env The process environment.
 * @param name The variable holding the bind host.
 * @returns The host to bind, `127.0.0.1` when the variable is unset.
 * @throws Error when the variable is set to an empty or non-loopback value.
 */
export function requireLoopbackHost(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined) return "127.0.0.1";

  const host = value.trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `${name}=${JSON.stringify(value)} is not a loopback address; the webhook channels are ` +
        "reached through Caddy TLS and must bind 127.0.0.1 (see INSTALL.md §9b)",
    );
  }
  return host;
}
