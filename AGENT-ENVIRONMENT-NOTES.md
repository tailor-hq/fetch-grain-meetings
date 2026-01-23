# Notes on Running Scripts in Agent vs Terminal Environment

## Issue: Scripts work in terminal but not in Cursor agent

### Problem Summary

Scripts successfully run in a terminal environment but may fail/timeout when executed by the Cursor agent.

### Root Causes

1. **OAuth Token Access**
   - The script requires OAuth tokens stored in `.mcp-cache` (project-local directory)
   - The agent's sandbox may not have access to files outside the workspace directory
   - OAuth tokens must be set up before running the script

2. **Non-Interactive Environment**
   - The agent environment is non-interactive (no TTY)
   - MCP remote CLI may require interactive OAuth flow (opening browser)
   - This fails in non-interactive environments

3. **Process Spawning Limitations**
   - The script spawns `npx mcp-remote` subprocess
   - Subprocesses in agent environment may have restrictions
   - Network access may be limited or require explicit permissions

4. **Environment Variables**
   - `MCP_REMOTE_CACHE_DIR` must be set correctly
   - Agent environment may not inherit terminal environment variables

### Solutions Implemented

The script has been improved with:

1. **OAuth Pre-Check**
   - Checks for OAuth tokens before starting
   - Provides clear error messages if tokens are missing
   - Detects non-interactive environments

2. **Better Error Messages**
   - Clear instructions on how to authenticate
   - Diagnostic information about environment
   - Warnings for non-interactive environments

3. **Enhanced Diagnostics**
   - Captures stderr from MCP subprocess
   - Logs OAuth/authentication errors
   - Better timeout error messages

### Recommended Approach

**For Production Use: Run in Terminal**

```bash
cd /path/to/your/fetch-grain-meetings
node fetch-new-grain-meetings.js
```

**Why terminal works better:**
- Full access to OAuth cache directory
- Interactive OAuth flow if needed
- No sandbox restrictions
- Full network access

**For Agent Environment:**

The script will now:
1. Detect non-interactive environment
2. Check for OAuth tokens
3. Exit early with clear instructions if tokens are missing
4. Provide better error messages for debugging

### Verification

To verify transcripts were fetched correctly:

```bash
# Check status
# (Status is shown at the start of each run of fetch-new-grain-meetings.js)

# Verify a specific file has transcript
grep -A 5 "## Transcript" downloaded-grain-meetings/YYYY/MM/Meeting_Title_YYYY-MM-DD.md

# Check progress
cat transcript-progress.json
```

### Future Improvements

1. Consider using MCP resources directly (if available in agent)
2. Support batch processing with resume capability
3. Add retry logic for transient failures
4. Better handling of OAuth token refresh
