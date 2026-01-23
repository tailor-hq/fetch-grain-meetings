#!/usr/bin/env bash
# Check OAuth status and provide instructions

# Get project root (parent of src/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CACHE_DIR="${MCP_REMOTE_CACHE_DIR:-$PROJECT_ROOT/.mcp-cache}"

echo "Checking OAuth authentication status..."
echo "Cache directory: $CACHE_DIR"
echo ""

if [ -d "$CACHE_DIR" ] && [ "$(ls -A $CACHE_DIR 2>/dev/null)" ]; then
  echo "✅ OAuth tokens found in cache directory"
  echo "   Cursor should be able to use cached authentication"
  echo ""
  echo "Files in cache:"
  ls -la "$CACHE_DIR" | head -10
else
  echo "❌ No OAuth tokens found"
  echo ""
  echo "To authenticate, run:"
  echo "  MCP_REMOTE_CACHE_DIR=$CACHE_DIR \\"
  echo "  npx -y mcp-remote https://api.grain.com/_/mcp tools/list"
  echo ""
  echo "Complete the OAuth flow in the terminal, then Cursor will use the cached token."
fi
