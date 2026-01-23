#!/usr/bin/env bash
# Set cache directory for mcp-remote OAuth tokens (project-local)
# Get the project root directory (parent of src/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export MCP_REMOTE_CACHE_DIR="${MCP_REMOTE_CACHE_DIR:-$PROJECT_ROOT/.mcp-cache}"

# Ensure cache directory exists
mkdir -p "$MCP_REMOTE_CACHE_DIR"

# Run the shim (use relative path from script location)
exec node "$SCRIPT_DIR/mcp-shim.js"
