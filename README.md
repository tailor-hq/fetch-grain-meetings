# Grain Meetings Fetcher

Fetch and organize Grain meeting recordings and transcripts locally. This tool connects to the Grain API via MCP (Model Context Protocol) to download your meeting metadata and transcripts, organizing them as markdown files.

## Prerequisites

- Node.js (v14 or higher)
- A Grain account with MCP access
- OAuth authentication (handled automatically on first run)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd fetch-grain-meetings

# No npm install needed - uses npx for dependencies
```

## Quick Start

```bash
# Authenticate and fetch new meetings/transcripts
node fetch-new-grain-meetings.js
# Or: ./fetch-new-grain-meetings.js
```

That's it! The script handles OAuth authentication, fetches new meetings, and downloads missing transcripts automatically.

## What This Does

Fetches meeting metadata and transcripts from Grain API and organizes them as markdown files in `YYYY/MM/` folders. Automatically:
- Skips meetings and transcripts that already exist
- Resumes from where it left off if interrupted  
- Organizes files by year/month
- Tracks progress in `fetch-progress.json` and `transcript-progress.json`

## Scripts

### Main Script
**`fetch-new-grain-meetings.js`** (or `src/scripts/fetch-new-grain-meetings.js`) - Main entry point. Handles OAuth, fetches new meetings from today back to the most recent stored meeting (or 1 year ago by default), and fetches missing transcripts.

Options:
- `--skip-oauth` - Skip OAuth check (if already authenticated)
- `--skip-transcripts` - Only fetch meeting metadata, skip transcripts

### Utilities

**`src/utils/check-oauth.sh`** - Check if OAuth tokens are configured. Run if authentication fails.

**`src/utils/find-duplicates.js`** - Find duplicate meeting files (diagnostic).

**`src/utils/check-and-clean-duplicates.js`** - Clean duplicate files. Use `--delete` to actually remove them.

### MCP Integration (for Cursor users)

**`src/mcp/mcp-shim.js` + `src/mcp/run-mcp-shim.sh`** - Enable Grain MCP tools in Cursor. Configure in Cursor Settings → MCP → Add server:
- Type: `Stdio`
- Command: `/path/to/fetch-grain-meetings/src/mcp/run-mcp-shim.sh`

Then use MCP tools `list_attended_meetings` and `fetch_meeting_transcript` directly in Cursor.

## Folder Structure

```
fetch-grain-meetings/
├── src/
│   ├── lib/              # Core libraries
│   ├── scripts/          # Main executable scripts
│   ├── utils/            # Utility scripts
│   └── mcp/              # MCP integration
├── downloaded-grain-meetings/  # Meeting files organized by year/month
│   └── 2025/, 2026/, ...      # Year folders (01/, 02/, etc. inside each)
├── fetch-progress.json   # Meeting fetch progress (auto-generated)
└── transcript-progress.json  # Transcript fetch progress (auto-generated)
```

## Setup

**First Time Only:**
1. Run `node fetch-new-grain-meetings.js`
2. Complete OAuth in browser when prompted
3. Script saves tokens for future runs

**Customize Date Range:**
Set `FETCH_START_DATE` environment variable to change the default start date (format: YYYY-MM-DD). Default: 1 year ago from today.
```bash
FETCH_START_DATE=2024-01-01 node fetch-new-grain-meetings.js
```

**Check Authentication:**
```bash
./src/utils/check-oauth.sh
```

## Advanced Usage

**Fetch only meeting metadata (skip transcripts):**
```bash
node fetch-new-grain-meetings.js --skip-transcripts
```

**Skip OAuth check (if already authenticated):**
```bash
node fetch-new-grain-meetings.js --skip-oauth
```

**Custom date range:**
```bash
# Default: 1 year ago from today
# Override: Start from a specific date
FETCH_START_DATE=2024-01-01 node fetch-new-grain-meetings.js
```

**Custom year scanning range:**
```bash
# Default: current year ± 2 years (e.g., 2024-2028 in 2026)
# Override: Scan a specific year range
SCAN_START_YEAR=2020 SCAN_END_YEAR=2030 node fetch-new-grain-meetings.js
```

**Custom delays and timeouts:**
```bash
# Default: 1000ms (1 second) delay between batches
# Override: Faster batch processing
BATCH_DELAY_MS=500 node fetch-new-grain-meetings.js

# Default: 2000ms (2 seconds) delay between transcript requests
# Override: Faster transcript fetching
TRANSCRIPT_DELAY_MS=1000 node fetch-new-grain-meetings.js

# Default: 60000ms (60 seconds) timeout for MCP calls
# Override: Longer timeout for slow connections
MCP_TIMEOUT_MS=120000 node fetch-new-grain-meetings.js

# Default: 30000ms (30 seconds) timeout for OAuth
# Override: Longer timeout for OAuth initialization
OAUTH_TIMEOUT_MS=60000 node fetch-new-grain-meetings.js

# Combine multiple settings
BATCH_DELAY_MS=500 TRANSCRIPT_DELAY_MS=1000 node fetch-new-grain-meetings.js
```

**Enable debug logging:**
```bash
# Default: disabled (no debug output)
# Override: Enable verbose error logging for troubleshooting
DEBUG=1 node fetch-new-grain-meetings.js
```

**Check status:**
The main script shows status at the beginning of each run, including how many meetings have been processed and whether it will resume from a cursor.

**Find and clean duplicates:**
```bash
node src/utils/check-and-clean-duplicates.js --delete
```

## Configuration

All configuration is done via environment variables. Here's a complete reference:

### Date and Year Ranges
- `FETCH_START_DATE` - Start date for fetching meetings (format: YYYY-MM-DD). Default: 1 year ago
- `FETCH_END_DATE` - End date for fetching meetings (format: YYYY-MM-DD). Default: today
- `SCAN_START_YEAR` - Start year for scanning existing files. Default: current year - 2
- `SCAN_END_YEAR` - End year for scanning existing files. Default: current year + 2

### Timing and Delays
- `BATCH_DELAY_MS` - Delay between meeting batches in milliseconds. Default: 1000ms
- `TRANSCRIPT_DELAY_MS` - Delay between transcript requests in milliseconds. Default: 2000ms
- `MCP_TIMEOUT_MS` - Timeout for MCP tool calls in milliseconds. Default: 60000ms (60s)
- `OAUTH_TIMEOUT_MS` - Timeout for OAuth initialization in milliseconds. Default: 30000ms (30s)

### Paths and Directories
- `MCP_REMOTE_CACHE_DIR` - Directory for OAuth token cache. Default: `.mcp-cache` in project root

### Debugging
- `DEBUG` - Enable debug logging (set to `1` or any truthy value). Default: disabled (no debug output)

### Examples
```bash
# Full configuration example
FETCH_START_DATE=2024-01-01 \
SCAN_START_YEAR=2020 \
SCAN_END_YEAR=2030 \
BATCH_DELAY_MS=500 \
TRANSCRIPT_DELAY_MS=1000 \
DEBUG=1 \
node fetch-new-grain-meetings.js
```

## Safety

The script **never**:
- Deletes or removes meeting/transcript markdown files
- Overwrites existing meeting files
- Modifies files that already have transcripts

It **only**:
- Creates new meeting files
- Updates files with the transcript placeholder
- Cleans temporary JSON files

## Troubleshooting

**OAuth errors:** Run `./src/utils/check-oauth.sh` to verify tokens. If missing, run the main script again to re-authenticate.

**Port conflicts:** Run `./src/utils/kill-port.sh` to kill processes using MCP ports.

**See progress:** Check `fetch-progress.json` and `transcript-progress.json` for detailed status.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
