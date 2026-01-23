#!/usr/bin/env node
/**
 * Check status and get instructions for fetching transcripts (second pass)
 * 
 * This script:
 * 1. Scans all meeting files for the transcript placeholder
 * 2. Extracts meeting IDs from files that need transcripts
 * 3. Shows status and provides instructions for fetching transcripts
 * 
 * To actually fetch transcripts, use Cursor's MCP tool 'fetch_meeting_transcript'
 * with each meeting ID, then update the file using updateTranscript().
 */

const fs = require('fs');
const path = require('path');
const { getYearRange, iterateMeetingFiles } = require('./meetings-lib');

const TRANSCRIPT_PLACEHOLDER = '*Transcript will be added in second pass*';

const ROOT_DIR = path.join(__dirname, '..', '..');
const MEETINGS_DIR = path.join(ROOT_DIR, 'downloaded-grain-meetings');

function findMeetingsNeedingTranscripts() {
  const meetings = [];
  
  iterateMeetingFiles((filepath, content) => {
    // Check if it has the placeholder
    if (content.includes(TRANSCRIPT_PLACEHOLDER)) {
      // Extract meeting ID
      const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
      if (idMatch) {
        const meetingId = idMatch[1];
        // Extract title for display
        const titleMatch = content.match(/^# (.+)$/m);
        const title = titleMatch ? titleMatch[1] : path.basename(filepath);
        
        meetings.push({
          id: meetingId,
          title: title,
          filepath: filepath,
          relativePath: path.relative(ROOT_DIR, filepath)
        });
      }
    }
  }, {
    onError: (filepath, err) => {
      console.error(`Error reading ${filepath}: ${err.message}`);
    }
  });
  
  return meetings;
}

function updateFileWithTranscript(filepath, transcript) {
  try {
    let content = fs.readFileSync(filepath, 'utf8');
    
    // Replace the placeholder with the actual transcript
    if (content.includes(TRANSCRIPT_PLACEHOLDER)) {
      content = content.replace(
        TRANSCRIPT_PLACEHOLDER,
        transcript || '*No transcript available*'
      );
      fs.writeFileSync(filepath, content);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Error updating ${filepath}: ${err.message}`);
    return false;
  }
}

function showStatus() {
  console.log('=== Transcript Fetcher (Second Pass) ===\n');
  
  const meetings = findMeetingsNeedingTranscripts();
  
  console.log(`📊 Status:`);
  console.log(`   - Meetings needing transcripts: ${meetings.length}`);
  
  if (meetings.length === 0) {
    console.log(`\n✅ All transcripts have been fetched!`);
    return { meetings: [] };
  }
  
  console.log(`\n📋 Meetings needing transcripts:`);
  meetings.slice(0, 10).forEach((m, i) => {
    console.log(`   ${i + 1}. ${m.title.substring(0, 60)}...`);
    console.log(`      ID: ${m.id.substring(0, 8)}... | File: ${m.relativePath}`);
  });
  
  if (meetings.length > 10) {
    console.log(`   ... and ${meetings.length - 10} more`);
  }
  
  console.log(`\n🔧 To fetch transcripts in Cursor:`);
  console.log(`   1. Use the MCP tool 'fetch_meeting_transcript' for each meeting ID`);
  console.log(`   2. Update the file using updateFileWithTranscript()`);
  console.log(`\n   Example for first meeting:`);
  if (meetings.length > 0) {
    const first = meetings[0];
    console.log(`   - Meeting ID: ${first.id}`);
    console.log(`   - File: ${first.relativePath}`);
  }
  
  console.log(`\n💡 Tip: You can process meetings in batches to avoid rate limits.`);
  
  return { meetings };
}

// Function to update a file with transcript (can be called from Cursor)
function updateTranscript(meetingId, transcript) {
  const meetings = findMeetingsNeedingTranscripts();
  const meeting = meetings.find(m => m.id === meetingId);
  
  if (!meeting) {
    console.error(`Meeting ${meetingId} not found or already has transcript`);
    return false;
  }
  
  const updated = updateFileWithTranscript(meeting.filepath, transcript);
  if (updated) {
    console.log(`✅ Updated transcript for: ${meeting.title}`);
    console.log(`   File: ${meeting.relativePath}`);
    return true;
  }
  
  return false;
}

// If run directly, show status
if (require.main === module) {
  showStatus();
}

module.exports = { 
  showStatus, 
  findMeetingsNeedingTranscripts,
  updateFileWithTranscript,
  updateTranscript
};
