#!/usr/bin/env node
/**
 * Fetch new Grain meetings and transcripts - all-in-one script
 * 
 * This script:
 * 1. Handles MCP OAuth authentication (checks for tokens, prompts if needed)
 * 2. Fetches new meeting metadata from today back to a configurable start date (defaults to 1 year ago, or last stored meeting)
 * 3. Fetches new transcripts for meetings that are missing them
 * 
 * Usage:
 *   node fetch-new-grain-meetings.js [--skip-oauth] [--skip-transcripts]
 * 
 * Options:
 *   --skip-oauth        Skip OAuth check (assume already authenticated)
 *   --skip-transcripts  Only fetch meeting metadata, skip transcript fetching
 * 
 * The script automatically:
 * - Skips meetings that already exist
 * - Skips transcripts that are already fetched
 * - Resumes from where it left off if interrupted
 * - Organizes files by year/month
 * 
 * SAFETY:
 * - Don't delete or remove final meeting/transcript markdown files
 * - Don't overwrite existing meeting files
 * - When fetching transcripts, only update files that have the transcript placeholder
 * - Cleans up temporary files (temp-*.json) automatically
 * - Builds progress file from existing files (no need to rescan every time)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Import existing functions
const { 
  findMeetingsNeedingTranscripts, 
  updateFileWithTranscript
} = require('../lib/transcripts-status');
const { updateTranscript, loadProgress, saveProgress, extractTranscript } = require('../lib/update-transcript');
const {
  formatMeetingFile,
  findExistingMeetingFile,
  getYearMonth,
  sanitizeFilename,
  scanExistingFiles,
  getYearRange
} = require('../lib/meetings-lib');

// Configuration
const MCP_REMOTE_URL = "https://api.grain.com/_/mcp";
const ROOT_DIR = path.join(__dirname, '..', '..');
const CACHE_DIR = process.env.MCP_REMOTE_CACHE_DIR || path.join(ROOT_DIR, '.mcp-cache');
const MEETINGS_DIR = path.join(ROOT_DIR, 'downloaded-grain-meetings');
const MEETINGS_PROGRESS_FILE = path.join(ROOT_DIR, 'fetch-progress.json');
const TRANSCRIPT_PROGRESS_FILE = path.join(ROOT_DIR, 'transcript-progress.json');

// Configuration: delays and timeouts (can be overridden via env vars)
// Helper to safely parse int with fallback
function safeParseInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 0 ? defaultValue : parsed;
}

const BATCH_DELAY_MS = safeParseInt(process.env.BATCH_DELAY_MS, 1000);
const TRANSCRIPT_DELAY_MS = safeParseInt(process.env.TRANSCRIPT_DELAY_MS, 2000);
const MCP_TIMEOUT_MS = safeParseInt(process.env.MCP_TIMEOUT_MS, 60000);
const OAUTH_TIMEOUT_MS = safeParseInt(process.env.OAUTH_TIMEOUT_MS, 30000);

// Date range: today back to configurable start date
const today = new Date();
today.setHours(23, 59, 59, 999); // End of today
// Default to 1 year ago OR 2025-01-01, whichever is earlier (ensures we go back to at least 2025)
// Can be overridden with FETCH_START_DATE env var (format: YYYY-MM-DD)
const oneYearAgo = new Date(today);
oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
const minStartDate = new Date('2025-01-01T00:00:00Z');
// Use the earlier of the two dates (further back in time)
const defaultStartDate = new Date(Math.min(oneYearAgo.getTime(), minStartDate.getTime()));
const START_DATE = process.env.FETCH_START_DATE || defaultStartDate.toISOString().split('T')[0];
const END_DATE = today.toISOString().split('T')[0] + 'T23:59:59Z';

// Parse command line arguments
const args = process.argv.slice(2);
const skipOAuth = args.includes('--skip-oauth');
const skipTranscripts = args.includes('--skip-transcripts');

// ============================================================================
// OAuth and MCP Helpers
// ============================================================================

/**
 * Check if OAuth tokens are available
 */
function checkOAuth() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      return files.length > 0;
    }
  } catch (err) {
    return false;
  }
  return false;
}

/**
 * Initialize OAuth by running MCP remote CLI (opens browser)
 */
async function initializeOAuth() {
  console.log('\n🔐 Initializing OAuth...');
  console.log('   This will open your browser for authentication.\n');
  
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.MCP_REMOTE_CACHE_DIR = CACHE_DIR;

    const child = spawn("npx", ["-y", "mcp-remote", MCP_REMOTE_URL, "tools/list"], {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    let resolved = false;
    let stderrBuffer = '';
    let stdoutBuffer = '';

    // Check if streams are available before attaching listeners
    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        // If we get any output, assume it's working
        if (!resolved && stdoutBuffer.trim()) {
          resolved = true;
          child.kill();
          resolve(true);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        const dataStr = data.toString();
        stderrBuffer += dataStr;
        // Display stderr to console (OAuth messages)
        process.stderr.write(dataStr);
        // Look for OAuth URL or successful connection
        if (stderrBuffer.includes('Please authorize') || 
            stderrBuffer.includes('Connected') ||
            stderrBuffer.includes('Proxy established')) {
          if (!resolved) {
            // Give it a moment for OAuth to complete, then resolve
            setTimeout(() => {
              if (!resolved) {
                resolved = true;
                child.kill();
                resolve(true);
              }
            }, 3000);
          }
        }
      });
    }

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start OAuth: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        // Exit code 0 or 130 (Ctrl+C) means success
        // Or if we saw connection messages
        if (code === 0 || code === 130 || 
            stderrBuffer.includes('authorize') ||
            stderrBuffer.includes('Connected')) {
          resolve(true);
        } else if (code !== null) {
          reject(new Error(`OAuth initialization failed with code ${code}`));
        } else {
          // Process was killed, but might have succeeded
          resolve(true);
        }
      }
    });

    // Timeout (configurable via OAUTH_TIMEOUT_MS env var)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        // If we saw connection messages, assume it worked
        if (stderrBuffer.includes('Connected') || stderrBuffer.includes('authorize')) {
          resolve(true);
        } else {
          reject(new Error(`OAuth initialization timeout (${OAUTH_TIMEOUT_MS}ms)`));
        }
      }
    }, OAUTH_TIMEOUT_MS);
  });
}

// ============================================================================
// MCP Communication Helpers
// ============================================================================

function createRawJSONReader(stream, onMessage) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        onMessage(msg);
      } catch (err) {
        // Ignore parse errors for non-JSON lines
      }
    }
  });
}

function writeRawJSON(stream, msg) {
  const json = JSON.stringify(msg) + "\n";
  stream.write(json, "utf8");
}

/**
 * Call MCP tool via remote CLI
 */
function callMCPTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.MCP_REMOTE_CACHE_DIR = CACHE_DIR;

    const child = spawn("npx", ["-y", "mcp-remote", MCP_REMOTE_URL], {
      stdio: ["pipe", "pipe", "pipe"],
      env
    });

    let callId = Math.floor(Math.random() * 10000) + 1000;
    let timeout;
    let stderrBuffer = '';

    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn MCP process: ${err.message}`));
    });

    createRawJSONReader(child.stdout, (msg) => {
      if (msg.id === 0 && msg.result) {
        setTimeout(() => {
          writeRawJSON(child.stdin, {
            jsonrpc: "2.0",
            method: "notifications/initialized"
          });
          
          setTimeout(() => {
            writeRawJSON(child.stdin, {
              jsonrpc: "2.0",
              id: callId,
              method: "tools/call",
              params: {
                name: toolName,
                arguments: args
              }
            });
          }, 100);
        }, 100);
      }
      
      if (msg.id === callId) {
        clearTimeout(timeout);
        child.kill();
        
        if (msg.error) {
          reject(new Error(msg.error.message || 'Unknown MCP error'));
          return;
        }
        
        resolve(msg.result);
      }
    });

    // Send initialize
    setTimeout(() => {
      writeRawJSON(child.stdin, {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "fetch-new-grain-meetings",
            version: "1.0.0"
          }
        }
      });
    }, 500);

    // Timeout (configurable via MCP_TIMEOUT_MS env var)
    timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout waiting for MCP response (tool: ${toolName}, timeout: ${MCP_TIMEOUT_MS}ms)`));
    }, MCP_TIMEOUT_MS);
  });
}

/**
 * Parse MCP tool result - handles the nested content structure
 * The API returns: { content: [{ type: "text", text: "{\"list\": [...], \"cursor\": \"...\"}" }], isError: false }
 */
function parseMCPResult(result) {
  if (result.isError) {
    throw new Error('MCP tool returned an error');
  }
  
  if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error('MCP tool returned empty or invalid content');
  }
  
  // Extract the text content (should be JSON string)
  const textContent = result.content[0].text;
  if (!textContent) {
    throw new Error('MCP tool returned content without text field');
  }
  
  // Parse the JSON string
  const parsed = JSON.parse(textContent);
  
  // Return in the format expected by the rest of the code
  return {
    meetings: parsed.list || [],
    cursor: parsed.cursor
  };
}

// ============================================================================
// Meeting Fetching
// ============================================================================

function loadMeetingsProgress() {
  if (fs.existsSync(MEETINGS_PROGRESS_FILE)) {
    const data = JSON.parse(fs.readFileSync(MEETINGS_PROGRESS_FILE, 'utf8'));
    return {
      processedMeetingIds: new Set(data.processedMeetingIds || []),
      lastCursor: data.lastCursor,
      totalFetched: data.totalFetched || 0,
      totalCreated: data.totalCreated || 0,
      lastFetchTimestamp: data.lastFetchTimestamp || null
    };
  }
  return {
    processedMeetingIds: new Set(),
    lastCursor: null,
    totalFetched: 0,
    totalCreated: 0,
    lastFetchTimestamp: null
  };
}

function saveMeetingsProgress(progress) {
  const toSave = {
    processedMeetingIds: Array.from(progress.processedMeetingIds),
    lastCursor: progress.lastCursor,
    totalFetched: progress.totalFetched,
    totalCreated: progress.totalCreated,
    lastFetchTimestamp: progress.lastFetchTimestamp || null,
    lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync(MEETINGS_PROGRESS_FILE, JSON.stringify(toSave, null, 2));
}

/**
 * Rebuild meetings progress by scanning all existing meeting files
 */
function rebuildMeetingsProgress() {
  console.log('📋 Scanning existing meeting files to rebuild progress...');
  const progress = loadMeetingsProgress();
  
  // Scan all year folders
  let scanned = 0;
  const { startYear, endYear } = getYearRange();
  for (let year = startYear; year <= endYear; year++) {
    const yearDir = path.join(MEETINGS_DIR, year.toString());
    if (!fs.existsSync(yearDir)) continue;
    const months = fs.readdirSync(yearDir).filter(f => {
      const fullPath = path.join(yearDir, f);
      return fs.statSync(fullPath).isDirectory() && /^\d{2}$/.test(f);
    });
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filepath = path.join(monthDir, file);
        try {
          const content = fs.readFileSync(filepath, 'utf8');
          const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
          if (idMatch) {
            const meetingId = idMatch[1];
            if (!progress.processedMeetingIds.has(meetingId)) {
              progress.processedMeetingIds.add(meetingId);
              scanned++;
            }
          }
        } catch (err) {
          // Skip files we can't read, but log for debugging
          if (process.env.DEBUG) {
            console.error(`   ⚠️  Skipped file ${path.basename(filepath)}: ${err.message}`);
          }
        }
      }
    }
  }
  
  console.log(`   ✅ Found ${scanned} existing meeting files`);
  // Sync totalFetched with processedMeetingIds.size
  progress.totalFetched = progress.processedMeetingIds.size;
  saveMeetingsProgress(progress);
  return progress;
}

/**
 * Rebuild transcript progress using library function
 */
function rebuildTranscriptProgress() {
  console.log('📋 Scanning existing transcript files to rebuild progress...');
  const meetings = findMeetingsNeedingTranscripts();
  const progress = loadProgress();
  
  // Count files with and without transcripts
  let withTranscripts = 0;
  const allMeetings = new Set();
  const { startYear, endYear } = getYearRange();
  for (let year = startYear; year <= endYear; year++) {
    const yearDir = path.join(MEETINGS_DIR, year.toString());
    if (!fs.existsSync(yearDir)) continue;
    const months = fs.readdirSync(yearDir).filter(f => {
      const fullPath = path.join(yearDir, f);
      return fs.statSync(fullPath).isDirectory() && /^\d{2}$/.test(f);
    });
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filepath = path.join(monthDir, file);
        try {
          const content = fs.readFileSync(filepath, 'utf8');
          const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
          if (idMatch) {
            const meetingId = idMatch[1];
            allMeetings.add(meetingId);
            if (!content.includes('*Transcript will be added in second pass*')) {
              if (!progress.processedMeetingIds.includes(meetingId)) {
                progress.processedMeetingIds.push(meetingId);
                progress.totalFetched++;
                progress.totalUpdated++;
              }
              withTranscripts++;
            }
          }
        } catch (err) {
          // Skip files we can't read, but log for debugging
          if (process.env.DEBUG) {
            console.error(`   ⚠️  Skipped file ${path.basename(filepath)}: ${err.message}`);
          }
        }
      }
    }
  }
  
  console.log(`   ✅ Found ${withTranscripts} files with transcripts`);
  console.log(`   ⏳ Found ${meetings.length} files still needing transcripts`);
  saveProgress(progress);
  return progress;
}

/**
 * Clean up temporary files (temp-transcript-*.json, temp-batch-*.json, etc.)
 * NEVER deletes meeting/transcript markdown files
 */
function cleanupTempFiles() {
  const tempPatterns = [
    /^temp-transcript-.*\.json$/,
    /^temp-batch-.*\.json$/,
    /^temp-.*\.json$/
  ];
  
  let cleaned = 0;
  try {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      // Only match temp files, never .md files
      if (file.endsWith('.md')) continue;
      
      for (const pattern of tempPatterns) {
        if (pattern.test(file)) {
          const filepath = path.join(ROOT_DIR, file);
          try {
            fs.unlinkSync(filepath);
            cleaned++;
          } catch (err) {
            // Ignore cleanup errors for temp files
          }
          break;
        }
      }
    }
  } catch (err) {
    // Ignore cleanup errors
  }
  
  if (cleaned > 0) {
    console.log(`   🗑️  Cleaned up ${cleaned} temporary file(s)`);
  }
  return cleaned;
}

async function fetchMeetings() {
  console.log('\n=== Fetching Meeting Metadata ===\n');
  
  // Rebuild progress from existing files if needed (first run or if progress is empty)
  let progress = loadMeetingsProgress();
  if (progress.processedMeetingIds.size === 0 || !fs.existsSync(MEETINGS_PROGRESS_FILE)) {
    progress = rebuildMeetingsProgress();
  } else {
    // Quick sync: scan for any new files that aren't in progress yet
    // This catches files added outside this script
    const existingFiles = new Set();
    const { startYear, endYear } = getYearRange();
    for (let year = startYear; year <= endYear; year++) {
      const yearDir = path.join(MEETINGS_DIR, year.toString());
      if (!fs.existsSync(yearDir)) continue;
      const months = fs.readdirSync(yearDir).filter(f => {
        const fullPath = path.join(yearDir, f);
        return fs.statSync(fullPath).isDirectory() && /^\d{2}$/.test(f);
      });
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const filepath = path.join(monthDir, file);
          try {
            const content = fs.readFileSync(filepath, 'utf8');
            const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
            if (idMatch) {
              existingFiles.add(idMatch[1]);
            }
          } catch (err) {
            // Skip files we can't read
          }
        }
      }
    }
    // Add any existing files not in progress
    existingFiles.forEach(id => {
      if (!progress.processedMeetingIds.has(id)) {
        progress.processedMeetingIds.add(id);
      }
    });
  }
  
  // Find the most recent meeting date from stored files
  // This ensures we fetch from the last meeting we actually have, not just the last fetch attempt
  function findMostRecentMeetingDate() {
    let mostRecentDate = null;
    
    // Check if meetings directory exists
    if (!fs.existsSync(MEETINGS_DIR)) {
      return null;
    }
    
    const years = fs.readdirSync(MEETINGS_DIR).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    
    for (const year of years) {
      const yearDir = path.join(MEETINGS_DIR, year);
      if (!fs.existsSync(yearDir)) continue;
      
      const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
      
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.md'));
        
        for (const file of files) {
          const filepath = path.join(monthDir, file);
          try {
            const content = fs.readFileSync(filepath, 'utf8');
            const dateMatch = content.match(/\*\*Date:\*\* ([0-9-]+) ([0-9:]+) UTC/);
            if (dateMatch) {
              const dateStr = `${dateMatch[1]}T${dateMatch[2]}Z`;
              const meetingDate = new Date(dateStr);
              if (!mostRecentDate || meetingDate > mostRecentDate) {
                mostRecentDate = meetingDate;
              }
            }
          } catch (err) {
            // Skip files we can't read
          }
        }
        
        // If we found a date in this month, we can stop (months are sorted reverse)
        if (mostRecentDate) break;
      }
      
      // If we found a date in this year, we can stop (years are sorted reverse)
      if (mostRecentDate) break;
    }
    
    return mostRecentDate;
  }
  
  // Determine the start date for fetching
  // Use the most recent stored meeting date, or fall back to START_DATE
  let fetchStartDate = START_DATE;
  const mostRecentMeeting = findMostRecentMeetingDate();
  
  if (mostRecentMeeting) {
    fetchStartDate = mostRecentMeeting.toISOString().split('.')[0] + 'Z';
    console.log(`📅 Most recent stored meeting: ${mostRecentMeeting.toISOString().split('T')[0]}`);
    console.log(`   Fetching new meetings since then...`);
  } else {
    console.log(`📅 No existing meetings found, starting from ${START_DATE.split('T')[0]}`);
  }
  
  let cursor = progress.lastCursor;
  let batchNum = 0;
  let newMeetings = 0;
  let skippedMeetings = 0;
  let retriedWithoutCursor = false;
  let fetchCompletedSuccessfully = false;

  console.log(`📊 Status:`);
  console.log(`   - Already processed: ${progress.processedMeetingIds.size} meetings`);
  console.log(`   - Date range: ${fetchStartDate.split('T')[0]} to ${END_DATE.split('T')[0]}`);
  console.log(`   - Resuming from cursor: ${cursor ? 'Yes' : 'No'}\n`);

  while (true) {
    batchNum++;
    console.log(`\n--- Batch ${batchNum} ---`);
    
    try {
      const rawResult = await callMCPTool('list_attended_meetings', {
        limit: 100,
        cursor: cursor || undefined,
        filters: {
          after_datetime: fetchStartDate.includes('T') ? fetchStartDate : fetchStartDate + 'T00:00:00Z',
          before_datetime: END_DATE
        }
      });

      // Parse the nested MCP response structure
      const result = parseMCPResult(rawResult);
      const meetings = result.meetings || [];
      const nextCursor = result.cursor;

      // If we got 0 meetings with a cursor, the cursor might be stale
      // Retry once without cursor to catch any new meetings
      if (meetings.length === 0 && cursor && !retriedWithoutCursor) {
        console.log('   ⚠️  No meetings found with cursor (might be stale)');
        console.log('   🔄 Retrying without cursor to check for new meetings...');
        cursor = null;
        retriedWithoutCursor = true;
        continue;
      }

      if (meetings.length === 0) {
        console.log('   No more meetings found');
        break;
      }

      console.log(`   Fetched ${meetings.length} meetings`);

      // Process each meeting
      for (const meeting of meetings) {
        const meetingId = meeting.id;
        const meetingTitle = meeting.title.substring(0, 50);
        
        // Single source of truth: check if file already exists
        const existingFile = findExistingMeetingFile(meeting);
        if (existingFile) {
          console.log(`   ⊘ Skipping ${meetingTitle}... (file exists: ${path.basename(existingFile)})`);
          // Keep processedMeetingIds in sync (for performance, but file existence is source of truth)
          progress.processedMeetingIds.add(meetingId);
          skippedMeetings++;
          continue;
        }
        
        // Count as fetched only when we're actually processing it
        progress.totalFetched++;

        // Create meeting file
        const { year, month } = getYearMonth(meeting.start_datetime);
        const yearDir = path.join(MEETINGS_DIR, year.toString());
        const monthDir = path.join(yearDir, month.toString().padStart(2, '0'));

        if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });
        if (!fs.existsSync(monthDir)) fs.mkdirSync(monthDir, { recursive: true });

        const date = new Date(meeting.start_datetime);
        const formattedDate = date.toISOString().split('T')[0];
        const sanitizedTitle = sanitizeFilename(meeting.title);
        const filename = `${sanitizedTitle}_${formattedDate}.md`;
        const filepath = path.join(monthDir, filename);

        // Safety check: Never overwrite existing files (shouldn't happen if findExistingMeetingFile worked, but double-check)
        if (fs.existsSync(filepath)) {
          console.log(`   ⚠️  Skipping ${meetingTitle}... (file already exists at expected path: ${filename})`);
          progress.processedMeetingIds.add(meetingId);
          skippedMeetings++;
          continue;
        }

        const content = formatMeetingFile(meeting);
        fs.writeFileSync(filepath, content, 'utf8');

        progress.processedMeetingIds.add(meetingId);
        progress.totalCreated++;
        newMeetings++;

        console.log(`   ✅ Created: ${filename}`);
      }

      // Save progress after each batch
      progress.lastCursor = nextCursor;
      saveMeetingsProgress(progress);

      if (!nextCursor) {
        console.log('\n   ✅ Reached end of meetings');
        fetchCompletedSuccessfully = true;
        break;
      }

      cursor = nextCursor;
      
      // Delay between batches (configurable via BATCH_DELAY_MS env var)
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));

    } catch (error) {
      console.error(`\n   ❌ Error fetching batch ${batchNum}: ${error.message}`);
      fetchCompletedSuccessfully = false;
      break;
    }
  }

  // Sync totalFetched with processedMeetingIds.size for consistency
  progress.totalFetched = progress.processedMeetingIds.size;
  
  // Only update lastFetchTimestamp if we successfully completed without errors
  if (fetchCompletedSuccessfully) {
    progress.lastFetchTimestamp = new Date().toISOString();
  } else {
    console.log(`\n   ⚠️  Fetch did not complete successfully - not updating lastFetchTimestamp`);
  }
  
  saveMeetingsProgress(progress);

  console.log(`\n📊 Meeting Fetch Summary:`);
  console.log(`   ✅ New meetings created: ${newMeetings}`);
  console.log(`   ⊘ Meetings skipped: ${skippedMeetings}`);
  console.log(`   📁 Total processed: ${progress.processedMeetingIds.size}`);

  return { newMeetings, skippedMeetings };
}

// ============================================================================
// Transcript Fetching
// ============================================================================

async function fetchTranscripts() {
  console.log('\n=== Fetching Transcripts ===\n');

  // Rebuild progress from existing files if needed (first run or if progress is empty)
  let progress = loadProgress();
  if (progress.processedMeetingIds.length === 0 || !fs.existsSync(TRANSCRIPT_PROGRESS_FILE)) {
    progress = rebuildTranscriptProgress();
  }
  const meetings = findMeetingsNeedingTranscripts();
  
  const meetingsToProcess = meetings.filter(m => 
    !progress.processedMeetingIds.includes(m.id)
  );

  if (meetingsToProcess.length === 0) {
    console.log('✅ All transcripts have been fetched!');
    return { fetched: 0, errors: 0 };
  }

  console.log(`📊 Status:`);
  console.log(`   - Meetings needing transcripts: ${meetings.length}`);
  console.log(`   - Already processed: ${progress.totalUpdated}`);
  console.log(`   - Remaining: ${meetingsToProcess.length}\n`);

  let fetched = 0;
  let errors = 0;

  for (let i = 0; i < meetingsToProcess.length; i++) {
    const meeting = meetingsToProcess[i];
    const { id, title } = meeting;

    console.log(`[${i + 1}/${meetingsToProcess.length}] ${title}`);
    console.log(`   Meeting ID: ${id}`);

    try {
      // Fetch transcript via MCP
      const mcpResponse = await callMCPTool('fetch_meeting_transcript', {
        meeting_id: id,
        include_timestamps: false
      });

      // Update meeting file
      const success = updateTranscript(id, JSON.stringify(mcpResponse));

      if (success) {
        fetched++;
        console.log(`   ✅ Success`);
      } else {
        errors++;
        console.log(`   ❌ Failed to update file`);
      }

      // Delay between requests (configurable via TRANSCRIPT_DELAY_MS env var)
      if (i < meetingsToProcess.length - 1) {
        await new Promise(resolve => setTimeout(resolve, TRANSCRIPT_DELAY_MS));
      }

    } catch (error) {
      errors++;
      console.log(`   ❌ Error: ${error.message}`);
    }
  }

  console.log(`\n📊 Transcript Fetch Summary:`);
  console.log(`   ✅ Transcripts fetched: ${fetched}`);
  console.log(`   ❌ Errors: ${errors}`);

  const finalProgress = loadProgress();
  console.log(`   📁 Total processed: ${finalProgress.totalUpdated}/${meetings.length}`);

  return { fetched, errors };
}

// ============================================================================
// Main Function
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Fetch New Grain Meetings & Transcripts                ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Clean up temp files at start (but never delete meeting/transcript files)
  cleanupTempFiles();

  // Step 1: OAuth Authentication
  if (!skipOAuth) {
    const hasOAuth = checkOAuth();
    if (!hasOAuth) {
      console.log('⚠️  OAuth tokens not found');
      try {
        await initializeOAuth();
        console.log('\n✅ OAuth authentication complete\n');
      } catch (error) {
        console.error(`\n❌ OAuth initialization failed: ${error.message}`);
        console.error('\nPlease run manually:');
        console.error(`  MCP_REMOTE_CACHE_DIR=${CACHE_DIR} \\`);
        console.error('  npx -y mcp-remote https://api.grain.com/_/mcp tools/list');
        process.exit(1);
      }
    } else {
      console.log('✅ OAuth tokens found\n');
    }
  } else {
    console.log('⏭️  Skipping OAuth check (--skip-oauth)\n');
  }

  // Step 2: Fetch Meeting Metadata
  try {
    const meetingResults = await fetchMeetings();
    if (meetingResults.newMeetings === 0) {
      console.log('\n💡 No new meetings to fetch');
    }
  } catch (error) {
    console.error(`\n❌ Error fetching meetings: ${error.message}`);
    process.exit(1);
  }

  // Step 3: Fetch Transcripts
  if (!skipTranscripts) {
    try {
      const transcriptResults = await fetchTranscripts();
      if (transcriptResults.fetched === 0) {
        console.log('\n💡 No new transcripts to fetch');
      }
    } catch (error) {
      console.error(`\n❌ Error fetching transcripts: ${error.message}`);
      // Don't exit on transcript errors, as meetings are already fetched
    }
  } else {
    console.log('\n⏭️  Skipping transcript fetching (--skip-transcripts)\n');
  }

  console.log('\n✅ Done!\n');
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  });
}

module.exports = { main, fetchMeetings, fetchTranscripts };
