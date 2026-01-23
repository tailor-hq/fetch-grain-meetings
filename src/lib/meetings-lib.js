#!/usr/bin/env node
/**
 * Core library for managing Grain meeting files
 * Handles file operations, progress tracking, and meeting metadata
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MEETINGS_DIR = path.join(ROOT_DIR, 'downloaded-grain-meetings');
const PROGRESS_FILE = path.join(ROOT_DIR, 'fetch-progress.json');
// Date range constants (used for legacy functions only)
// Main script uses dynamic date calculation based on stored meetings
// Default start date (1 year ago) - can be overridden with FETCH_START_DATE env var
const defaultStartDate = new Date();
defaultStartDate.setFullYear(defaultStartDate.getFullYear() - 1);
const START_DATE = process.env.FETCH_START_DATE || defaultStartDate.toISOString().split('T')[0];
const END_DATE = process.env.FETCH_END_DATE || new Date().toISOString().split('T')[0];

/**
 * Get year range for scanning meeting files
 * Defaults to current year ± 2 years, or can be overridden via env vars
 * @returns {Object} { startYear, endYear }
 */
function getYearRange() {
  const currentYear = new Date().getFullYear();
  
  // Allow env vars to override (e.g., SCAN_START_YEAR=2020 SCAN_END_YEAR=2030)
  const startYear = process.env.SCAN_START_YEAR 
    ? (parseInt(process.env.SCAN_START_YEAR, 10) || currentYear - 2)
    : currentYear - 2;
  const endYear = process.env.SCAN_END_YEAR
    ? (parseInt(process.env.SCAN_END_YEAR, 10) || currentYear + 2)
    : currentYear + 2;
  
  // If meetings directory exists, scan for actual year folders and expand range if needed
  if (fs.existsSync(MEETINGS_DIR)) {
    try {
      const dirs = fs.readdirSync(MEETINGS_DIR).filter(d => {
        const fullPath = path.join(MEETINGS_DIR, d);
        return fs.statSync(fullPath).isDirectory() && /^\d{4}$/.test(d);
      });
      if (dirs.length > 0) {
        const years = dirs.map(d => parseInt(d, 10)).sort((a, b) => a - b);
        const minYear = Math.min(startYear, years[0]);
        const maxYear = Math.max(endYear, years[years.length - 1]);
        return { startYear: minYear, endYear: maxYear };
      }
    } catch (err) {
      // If we can't read the directory, use defaults
    }
  }
  
  return { startYear, endYear };
}

/**
 * Iterate over all meeting files in year/month directories
 * @param {Function} callback - Function called for each file: callback(filepath, content, year, month)
 * @param {Object} options - Options: { onError: (filepath, err) => void }
 * @returns {number} Number of files processed
 */
function iterateMeetingFiles(callback, options = {}) {
  const { startYear, endYear } = getYearRange();
  let count = 0;
  
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
          callback(filepath, content, year, month);
          count++;
        } catch (err) {
          if (options.onError) {
            options.onError(filepath, err);
          } else if (process.env.DEBUG) {
            console.error(`Error reading ${filepath}: ${err.message}`);
          }
        }
      }
    }
  }
  
  return count;
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  }
  return {
    processedMeetingIds: new Set(),
    lastCursor: null,
    totalFetched: 0,
    totalCreated: 0
  };
}

function saveProgress(progress) {
  // Convert Set to Array for JSON serialization
  const toSave = {
    processedMeetingIds: Array.from(progress.processedMeetingIds),
    lastCursor: progress.lastCursor,
    totalFetched: progress.totalFetched,
    totalCreated: progress.totalCreated
  };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(toSave, null, 2));
}

function restoreProgress(data) {
  return {
    processedMeetingIds: new Set(data.processedMeetingIds || []),
    lastCursor: data.lastCursor,
    totalFetched: data.totalFetched || 0,
    totalCreated: data.totalCreated || 0
  };
}

function sanitizeFilename(title) {
  return title
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 100);
}

function getYearMonth(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return { year, month };
}

function formatMeetingFile(meeting) {
  const date = new Date(meeting.start_datetime);
  const formattedDate = date.toISOString().split('T')[0];
  const formattedTime = date.toLocaleTimeString('en-US', { hour12: false });
  
  let content = `# ${meeting.title}\n\n`;
  content += `**Date:** ${formattedDate} ${formattedTime} UTC\n`;
  content += `**Duration:** ${meeting.duration || 'N/A'}\n`;
  content += `**Meeting ID:** ${meeting.id}\n`;
  content += `**Participant Scope:** ${meeting.participant_scope || 'unknown'}\n\n`;
  
  if (meeting.participants && meeting.participants.length > 0) {
    content += `## Participants\n\n`;
    meeting.participants.forEach(p => {
      content += `- ${p.name}${p.email ? ` (${p.email})` : ''} [${p.scope || 'unknown'}]\n`;
    });
    content += `\n`;
  }
  
  if (meeting.summary) {
    content += `## Summary\n\n${meeting.summary}\n\n`;
  }
  
  content += `---\n\n`;
  content += `## Transcript\n\n*Transcript will be added in second pass*\n`;
  
  return content;
}

function findExistingMeetingFile(meeting) {
  // First, search ALL folders for this meeting ID (in case it was saved in wrong folder)
  const { startYear, endYear } = getYearRange();
  for (let year = startYear; year <= endYear; year++) {
    const yearDir = path.join(MEETINGS_DIR, year.toString());
    if (!fs.existsSync(yearDir)) continue;
    
    const months = fs.readdirSync(yearDir).filter(f => 
      fs.statSync(path.join(yearDir, f)).isDirectory() && /^\d{2}$/.test(f)
    );
    
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      const files = fs.readdirSync(monthDir).filter(f => f.endsWith('.md'));
      
      for (const file of files) {
        const filepath = path.join(monthDir, file);
        try {
          const content = fs.readFileSync(filepath, 'utf8');
          // Check if this file contains the meeting ID
          if (content.includes(meeting.id)) {
            return filepath;
          }
        } catch (err) {
          // Skip files we can't read
        }
      }
    }
  }
  
  // Also check the expected location by filename pattern
  const { year, month } = getYearMonth(meeting.start_datetime);
  const dir = path.join(MEETINGS_DIR, year.toString(), month);
  
  if (fs.existsSync(dir)) {
    const filename = sanitizeFilename(meeting.title);
    const dateStr = meeting.start_datetime.split('T')[0];
    const expectedFilepath = path.join(dir, `${filename}_${dateStr}.md`);
    if (fs.existsSync(expectedFilepath)) {
      // Double-check it has the right meeting ID
      try {
        const content = fs.readFileSync(expectedFilepath, 'utf8');
        if (content.includes(meeting.id)) {
          return expectedFilepath;
        }
      } catch (err) {
        // If we can't read it, assume it's not a match
      }
    }
  }
  
  return null;
}

function createMeetingFile(meeting, progress) {
  const date = new Date(meeting.start_datetime);
  const dateStr = date.toISOString().split('T')[0];
  
  // Always check if file already exists first (most reliable check)
  const existing = findExistingMeetingFile(meeting);
  if (existing) {
    console.log(`  ⊘ Skipped (file exists): ${path.relative(ROOT_DIR, existing)}`);
    progress.processedMeetingIds.add(meeting.id);
    return false;
  }
  
  // Also check if already processed (in case file was deleted but ID is in progress)
  if (progress.processedMeetingIds.has(meeting.id)) {
    console.log(`  ⊘ Skipped (already processed): ${meeting.id.substring(0, 8)}... - ${dateStr}`);
    return false;
  }
  
  const { year, month } = getYearMonth(meeting.start_datetime);
  const dir = path.join(MEETINGS_DIR, year.toString(), month);
  
  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const filename = sanitizeFilename(meeting.title);
  const filepath = path.join(dir, `${filename}_${dateStr}.md`);
  
  const content = formatMeetingFile(meeting);
  fs.writeFileSync(filepath, content);
  console.log(`  ✓ Created: ${year}/${month}/${path.basename(filepath)}`);
  progress.processedMeetingIds.add(meeting.id);
  progress.totalCreated++;
  return true;
}

function isInDateRange(dateStr) {
  const date = new Date(dateStr);
  const start = new Date(START_DATE);
  const end = new Date(END_DATE);
  return date >= start && date < end;
}

function scanExistingFiles(progress) {
  console.log(`\n=== Scanning existing files ===`);
  let found = 0;
  
  iterateMeetingFiles((filepath, content) => {
    // Extract meeting ID from file content
    const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
    if (idMatch) {
      const meetingId = idMatch[1];
      if (!progress.processedMeetingIds.has(meetingId)) {
        progress.processedMeetingIds.add(meetingId);
        found++;
      }
    }
  }, {
    onError: (filepath, err) => {
      if (process.env.DEBUG) {
        console.error(`Error reading ${filepath}: ${err.message}`);
      }
    }
  });
  
  if (found > 0) {
    console.log(`Found ${found} existing meeting files to mark as processed`);
  } else {
    console.log(`No new existing files found`);
  }
  
  return found;
}

async function fetchAllMeetings() {
  let progress = loadProgress();
  
  // Restore Set from array
  if (Array.isArray(progress.processedMeetingIds)) {
    progress = restoreProgress(progress);
  }
  
  // Scan existing files to mark them as processed
  scanExistingFiles(progress);
  saveProgress(progress);
  
  console.log(`\n=== Starting fetch ===`);
  console.log(`Already processed: ${progress.processedMeetingIds.size} meetings`);
  console.log(`Date range: ${START_DATE} to ${END_DATE}`);
  console.log(`Last cursor: ${progress.lastCursor ? 'Yes' : 'No'}\n`);
  
  let cursor = progress.lastCursor;
  let batchNum = 0;
  let allMeetings = [];
  
  while (true) {
    batchNum++;
    const batchStartTime = Date.now();
    console.log(`\n=== Batch ${batchNum} ===`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`Fetching with cursor: ${cursor || 'none (first batch)'}...`);
    
    try {
      // Note: This would need to be called via MCP tools
      // For now, this is the structure - you'll need to call the MCP tool
      console.log(`\n⚠️  To continue, call the MCP tool with:`);
      console.log(`  limit: 100`);
      if (cursor) {
        console.log(`  cursor: ${cursor}`);
      }
      console.log(`\nThen pass the results to processMeetings() function.`);
      break;
      
    } catch (error) {
      console.error(`Error fetching batch ${batchNum}:`, error.message);
      break;
    }
  }
  
  // Process meetings
  console.log(`\n=== Processing Meetings ===`);
  let newMeetings = 0;
  let skippedMeetings = 0;
  let outOfRangeMeetings = 0;
  let processedCount = 0;
  const totalToProcess = allMeetings.length;
  
  for (const meeting of allMeetings) {
    processedCount++;
    progress.totalFetched++;
    
    const date = new Date(meeting.start_datetime);
    const dateStr = date.toISOString().split('T')[0];
    const timeStr = date.toLocaleTimeString('en-US', { hour12: false });
    
    // Show progress
    console.log(`\n[${processedCount}/${totalToProcess}] Processing: ${dateStr} ${timeStr} - ${meeting.title.substring(0, 60)}...`);
    
    if (!isInDateRange(meeting.start_datetime)) {
      outOfRangeMeetings++;
      console.log(`  ⊘ Out of date range (${dateStr})`);
      continue;
    }
    
    // createMeetingFile now handles checking if already processed
    const created = createMeetingFile(meeting, progress);
    if (created) {
      newMeetings++;
    } else {
      skippedMeetings++;
    }
    
    // Save progress every 10 meetings
    if (processedCount % 10 === 0) {
      saveProgress(progress);
      console.log(`  💾 Progress saved (${processedCount}/${totalToProcess} processed)`);
    }
  }
  
  // Sync totalFetched with processedMeetingIds.size to ensure consistency
  progress.totalFetched = progress.processedMeetingIds.size;
  
  console.log(`\n=== Summary ===`);
  console.log(`New meetings created: ${newMeetings}`);
  console.log(`Skipped (already processed): ${skippedMeetings}`);
  console.log(`Out of date range: ${outOfRangeMeetings}`);
  console.log(`Total meetings fetched: ${progress.totalFetched}`);
  console.log(`Total files created: ${progress.totalCreated}`);
  console.log(`Total unique meetings processed: ${progress.processedMeetingIds.size}`);
  
  saveProgress(progress);
  console.log(`\n💾 Progress saved to ${PROGRESS_FILE}`);
  console.log(`⏱️  Completed at: ${new Date().toISOString()}`);
}

function processMeetings(meetingsResult, progress) {
  // This function can be called with MCP results
  const allMeetings = meetingsResult.list || [];
  const cursor = meetingsResult.cursor || null;
  
  console.log(`\n📥 Received ${allMeetings.length} meetings`);
  if (cursor) {
    console.log(`📄 Next cursor available: ${cursor.substring(0, 20)}...`);
    progress.lastCursor = cursor;
  } else {
    console.log(`✅ No more pages (cursor is null)`);
  }
  
  // Process meetings
  console.log(`\n=== Processing Meetings ===`);
  let newMeetings = 0;
  let skippedMeetings = 0;
  let outOfRangeMeetings = 0;
  let processedCount = 0;
  const totalToProcess = allMeetings.length;
  
  for (const meeting of allMeetings) {
    processedCount++;
    progress.totalFetched++;
    
    const date = new Date(meeting.start_datetime);
    const dateStr = date.toISOString().split('T')[0];
    const timeStr = date.toLocaleTimeString('en-US', { hour12: false });
    
    // Show progress
    console.log(`\n[${processedCount}/${totalToProcess}] Processing: ${dateStr} ${timeStr} - ${meeting.title.substring(0, 60)}...`);
    
    if (!isInDateRange(meeting.start_datetime)) {
      outOfRangeMeetings++;
      console.log(`  ⊘ Out of date range (${dateStr})`);
      continue;
    }
    
    // createMeetingFile now handles checking if already processed
    const created = createMeetingFile(meeting, progress);
    if (created) {
      newMeetings++;
    } else {
      skippedMeetings++;
    }
    
    // Save progress every 10 meetings
    if (processedCount % 10 === 0) {
      saveProgress(progress);
      console.log(`  💾 Progress saved (${processedCount}/${totalToProcess} processed)`);
    }
  }
  
  console.log(`\n=== Batch Summary ===`);
  console.log(`New meetings created: ${newMeetings}`);
  console.log(`Skipped (already processed): ${skippedMeetings}`);
  console.log(`Out of date range: ${outOfRangeMeetings}`);
  console.log(`Total meetings fetched: ${progress.totalFetched}`);
  console.log(`Total files created: ${progress.totalCreated}`);
  console.log(`Total unique meetings processed: ${progress.processedMeetingIds.size}`);
  
  saveProgress(progress);
  console.log(`\n💾 Progress saved to ${PROGRESS_FILE}`);
  
  return { cursor, hasMore: cursor !== null };
}

// Run if called directly
if (require.main === module) {
  fetchAllMeetings().catch(console.error);
}

module.exports = { 
  fetchAllMeetings, 
  processMeetings,
  loadProgress, 
  saveProgress,
  scanExistingFiles,
  restoreProgress,
  findExistingMeetingFile,
  formatMeetingFile,
  getYearMonth,
  sanitizeFilename,
  getYearRange,
  iterateMeetingFiles
};
