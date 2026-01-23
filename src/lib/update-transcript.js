#!/usr/bin/env node
/**
 * Update a meeting file with a transcript from MCP response
 * 
 * Usage:
 *   node update-transcript.js <meeting-id> <mcp-response-file>
 * 
 * Reads transcript from the specified file (preferred method).
 * Automatically extracts transcript from MCP response format.
 * 
 * The file can contain:
 * - Plain text transcript
 * - JSON with MCP response format: {"content": [{"text": "..."}]}
 * - JSON with direct transcript: {"transcript": "..."}
 */

const fs = require('fs');
const path = require('path');
const { findMeetingsNeedingTranscripts, updateFileWithTranscript } = require('./transcripts-status');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PROGRESS_FILE = path.join(ROOT_DIR, 'transcript-progress.json');

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch (err) {
      console.error(`Error loading progress: ${err.message}`);
    }
  }
  return {
    processedMeetingIds: [],
    totalFetched: 0,
    totalUpdated: 0,
    errors: []
  };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

/**
 * Extract transcript from MCP response format
 * Handles various formats:
 * - Direct string: "transcript text"
 * - MCP content format: {"content": [{"text": "transcript..."}]}
 * - Plain text
 */
function extractTranscript(input) {
  // If input is already a plain string (not JSON), return it
  if (typeof input === 'string' && !input.trim().startsWith('{') && !input.trim().startsWith('[')) {
    return input.trim();
  }
  
  // Try to parse as JSON
  let parsed;
  try {
    parsed = typeof input === 'object' ? input : JSON.parse(input);
  } catch (err) {
    // If not JSON, treat as plain text
    return String(input).trim();
  }
  
  // Handle MCP response format: {content: [{text: "..."}]}
  if (parsed.content && Array.isArray(parsed.content) && parsed.content.length > 0) {
    if (parsed.content[0].text) {
      return parsed.content[0].text.trim();
    }
    // Sometimes content is just an array of strings
    if (typeof parsed.content[0] === 'string') {
      return parsed.content.join('\n').trim();
    }
  }
  
  // Handle direct text field
  if (parsed.text) {
    return parsed.text.trim();
  }
  
  // Handle transcript field
  if (parsed.transcript) {
    return parsed.transcript.trim();
  }
  
  // If it's an object but we can't find transcript, stringify it
  return JSON.stringify(parsed, null, 2);
}

function updateTranscript(meetingId, transcriptOrResponse) {
  const meetings = findMeetingsNeedingTranscripts();
  const meeting = meetings.find(m => m.id === meetingId);
  
  if (!meeting) {
    console.error(`❌ Meeting ${meetingId} not found or already has transcript`);
    return false;
  }
  
  // Extract transcript from MCP response format
  const transcript = extractTranscript(transcriptOrResponse);
  
  if (!transcript) {
    console.error(`❌ No transcript found in response`);
    return false;
  }
  
  const updated = updateFileWithTranscript(meeting.filepath, transcript);
  
  if (updated) {
    const progress = loadProgress();
    if (!progress.processedMeetingIds.includes(meetingId)) {
      progress.processedMeetingIds.push(meetingId);
      progress.totalFetched++;
      progress.totalUpdated++;
    }
    saveProgress(progress);
    
    console.log(`✅ Updated transcript for: ${meeting.title}`);
    console.log(`   File: ${meeting.relativePath}`);
    console.log(`   Progress: ${progress.totalUpdated}/${meetings.length} transcripts fetched`);
    return true;
  } else {
    console.error(`❌ Failed to update transcript for meeting ${meetingId}`);
    return false;
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error('Usage: node update-transcript.js <meeting-id> <mcp-response-file>');
    console.error('');
    console.error('The response file can contain:');
    console.error('  - Plain text transcript');
    console.error('  - JSON: {"content": [{"text": "..."}]}');
    console.error('  - JSON: {"transcript": "..."}');
    process.exit(1);
  }
  
  const meetingId = args[0];
  const responseFile = args[1];
  
  if (!fs.existsSync(responseFile)) {
    console.error(`❌ Response file not found: ${responseFile}`);
    process.exit(1);
  }
  
  const input = fs.readFileSync(responseFile, 'utf8');
  const success = updateTranscript(meetingId, input);
  
  // Clean up temp file if it matches the pattern
  if (responseFile.startsWith(path.join(__dirname, 'temp-transcript-'))) {
    try {
      fs.unlinkSync(responseFile);
      console.log(`   Cleaned up temp file: ${path.basename(responseFile)}`);
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  
  process.exit(success ? 0 : 1);
}

module.exports = { updateTranscript, extractTranscript, loadProgress, saveProgress };
