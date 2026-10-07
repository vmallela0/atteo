// The CLI installer served at /install.sh. Short and readable on purpose: people should be able to read it before
// running it. It downloads one file (the bundled CLI, served by this server), puts it on your PATH, and offers to
// sign in. Nothing runs as root, nothing else is touched.

export function installScript(origin: string): string {
  return `#!/bin/sh
# Atteo CLI installer (${origin}/install.sh)
# Downloads one file, the atteo command, to ~/.local/bin (or $ATTEO_BIN), then offers to sign you in.
# With an agent (curl -fsSL ${origin}/install.sh | sh -s claude) it sets that agent up instead: atteo harness <agent>.
set -eu
SERVER="\${ATTEO_SERVER:-\${AGENT_SOUP_SERVER:-${origin}}}"
DIR="\${ATTEO_BIN:-\${AGENT_SOUP_BIN:-$HOME/.local/bin}}"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(+process.versions.node.split(".")[0] < 20 ? 1 : 0)'; then
  echo "Atteo needs Node.js 20 or newer. Get it from https://nodejs.org (or: brew install node), then run this again." >&2
  exit 1
fi

mkdir -p "$DIR"
curl -fsSL "$SERVER/cli/atteo.mjs" -o "$DIR/atteo.download"
mv "$DIR/atteo.download" "$DIR/atteo"
chmod +x "$DIR/atteo"
ln -sf atteo "$DIR/agent-soup" 2>/dev/null || true # the command's name before the rename, so existing hooks and scripts keep working
echo "Installed atteo to $DIR/atteo"

case ":$PATH:" in
  *":$DIR:"*) BIN=atteo ;;
  *) BIN="$DIR/atteo"
     echo "Add it to your PATH (then open a new terminal):  echo 'export PATH=\\"$DIR:\\$PATH\\"' >> ~/.zshrc" ;;
esac

# An agent named: set it up (sign-in included). Else sign in now if there's a person at a terminal (curl | sh reads the
# script from stdin, so ask on /dev/tty).
if [ $# -gt 0 ]; then
  ATTEO_SERVER="$SERVER" "$DIR/atteo" harness "$@"
elif [ -z "\${ATTEO_NO_LOGIN:-}\${AGENT_SOUP_NO_LOGIN:-}" ] && [ -t 1 ] && [ -r /dev/tty ]; then
  ATTEO_SERVER="$SERVER" "$DIR/atteo" login </dev/tty || echo "Sign in later with: $BIN login"
else
  echo "Next: $BIN harness claude   (or codex, gemini, cursor, opencode)"
fi
`;
}
