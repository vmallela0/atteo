// Settings from the environment are ATTEO_<NAME>. The names from before the rename (AGENT_SOUP_<NAME>,
// AGENT_BOARD_<NAME>) still work, so existing shells, services and hooks keep their settings.
export function env(name: string): string | undefined {
  return process.env[`ATTEO_${name}`] ?? process.env[`AGENT_SOUP_${name}`] ?? process.env[`AGENT_BOARD_${name}`];
}
