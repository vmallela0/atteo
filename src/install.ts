// The CLI installer served at /install.sh. Short and readable on purpose: people should be able to read it before
// running it. It downloads one file (the bundled CLI, served by this server), puts it on your PATH, and offers to
// sign in. Nothing runs as root, nothing else is touched.

export function installScript(origin: string): string {
  return `#!/bin/sh
# Atteo CLI installer (${origin}/install.sh)
# Downloads one file, the agent-soup command, to ~/.local/bin (or $AGENT_SOUP_BIN), then offers to sign you in.
set -eu
SERVER="\${AGENT_SOUP_SERVER:-${origin}}"
DIR="\${AGENT_SOUP_BIN:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 20 ? 1 : 0)'; then
  echo "Atteo needs Node.js 20 or newer. Get it from https://nodejs.org (or: brew install node), then run this again." >&2
  exit 1
fi

mkdir -p "$DIR"
curl -fsSL "$SERVER/cli/agent-soup.mjs" -o "$DIR/agent-soup.download"
mv "$DIR/agent-soup.download" "$DIR/agent-soup"
chmod +x "$DIR/agent-soup"
echo "Installed agent-soup to $DIR/agent-soup"

case ":$PATH:" in
  *":$DIR:"*) BIN=agent-soup ;;
  *) BIN="$DIR/agent-soup"
     echo "Add it to your PATH (then open a new terminal):  echo 'export PATH=\\"$DIR:\\$PATH\\"' >> ~/.zshrc" ;;
esac

# Sign in now if there's a person at a terminal (curl | sh reads the script from stdin, so ask on /dev/tty).
if [ -z "\${AGENT_SOUP_NO_LOGIN:-}" ] && [ -t 1 ] && [ -r /dev/tty ]; then
  AGENT_BOARD_SERVER="$SERVER" "$DIR/agent-soup" login </dev/tty || echo "Sign in later with: $BIN login"
else
  echo "Next: $BIN login"
fi
`;
}
