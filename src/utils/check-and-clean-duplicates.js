#!/usr/bin/env node
/**
 * Check for and optionally remove duplicate meeting files
 */

const fs = require('fs');
const path = require('path');
const { getYearRange } = require('../lib/meetings-lib');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MEETINGS_DIR = path.join(ROOT_DIR, 'downloaded-grain-meetings');

const meetingIds = new Map(); // meetingId -> [filepaths]
const filesByContent = new Map(); // content hash -> [filepaths]
const filesToDelete = new Set();

function scanFiles() {
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
          
          // Extract meeting ID
          const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
          if (idMatch) {
            const meetingId = idMatch[1];
            if (!meetingIds.has(meetingId)) {
              meetingIds.set(meetingId, []);
            }
            meetingIds.get(meetingId).push(filepath);
          }
          
          // Also check by content hash (for exact duplicates)
          const contentHash = require('crypto').createHash('md5').update(content).digest('hex');
          if (!filesByContent.has(contentHash)) {
            filesByContent.set(contentHash, []);
          }
          filesByContent.get(contentHash).push(filepath);
        } catch (err) {
          console.error(`Error reading ${filepath}: ${err.message}`);
        }
      }
    }
  }
}

function findDuplicates() {
  // Find duplicates by meeting ID (keep first, mark rest for deletion)
  for (const [meetingId, filepaths] of meetingIds.entries()) {
    if (filepaths.length > 1) {
      console.log(`\n⚠️  Duplicate Meeting ID: ${meetingId.substring(0, 8)}... (${filepaths.length} files)`);
      // Keep the first one (usually the one in the correct date folder)
      const sorted = filepaths.sort();
      const keep = sorted[0];
      const duplicates = sorted.slice(1);
      console.log(`  ✓ Keep: ${keep}`);
      duplicates.forEach(fp => {
        console.log(`  ✗ Delete: ${fp}`);
        filesToDelete.add(fp);
      });
    }
  }
  
  // Find exact content duplicates (keep first, mark rest)
  for (const [hash, filepaths] of filesByContent.entries()) {
    if (filepaths.length > 1) {
      // Check if these are already marked for deletion by meeting ID
      const notAlreadyMarked = filepaths.filter(fp => !filesToDelete.has(fp));
      if (notAlreadyMarked.length > 1) {
        console.log(`\n⚠️  Exact duplicate content (${notAlreadyMarked.length} files)`);
        const sorted = notAlreadyMarked.sort();
        const keep = sorted[0];
        const duplicates = sorted.slice(1);
        console.log(`  ✓ Keep: ${keep}`);
        duplicates.forEach(fp => {
          console.log(`  ✗ Delete: ${fp}`);
          filesToDelete.add(fp);
        });
      }
    }
  }
}

function findIncompleteFiles() {
  const incomplete = [];
  
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
        if (filesToDelete.has(filepath)) continue; // Already marked for deletion
        
        try {
          const content = fs.readFileSync(filepath, 'utf8');
          const stats = fs.statSync(filepath);
          
          // Check if incomplete
          const hasMeetingId = content.includes('Meeting ID:');
          const hasSummary = content.includes('## Summary');
          const hasTranscriptMarker = content.includes('Transcript');
          const isVeryShort = content.length < 100;
          const isEmpty = content.trim().length === 0;
          
          if (isEmpty || isVeryShort || !hasMeetingId || !hasSummary) {
            incomplete.push({
              filepath,
              reason: isEmpty ? 'empty' : isVeryShort ? 'too_short' : !hasMeetingId ? 'no_meeting_id' : 'no_summary',
              size: stats.size
            });
          }
        } catch (err) {
          incomplete.push({ filepath, reason: 'read_error', error: err.message });
        }
      }
    }
  }
  
  if (incomplete.length > 0) {
    console.log(`\n⚠️  Incomplete Files (${incomplete.length}):`);
    incomplete.forEach(({ filepath, reason, size, error }) => {
      console.log(`  ✗ ${filepath} - ${reason}${size ? ` (${size} bytes)` : ''}${error ? ` - ${error}` : ''}`);
      filesToDelete.add(filepath);
    });
  }
  
  return incomplete;
}

// Main
console.log('=== Scanning files ===');
scanFiles();

console.log(`\n=== Checking for duplicates ===`);
findDuplicates();

console.log(`\n=== Checking for incomplete files ===`);
const incomplete = findIncompleteFiles();

console.log(`\n=== Summary ===`);
console.log(`Total files scanned: ${Array.from(meetingIds.values()).flat().length}`);
console.log(`Unique meeting IDs: ${meetingIds.size}`);
console.log(`Files to delete: ${filesToDelete.size}`);

if (filesToDelete.size > 0) {
  console.log(`\n=== Files to delete ===`);
  Array.from(filesToDelete).sort().forEach(fp => console.log(fp));
  
  // Ask for confirmation
  const args = process.argv.slice(2);
  if (args.includes('--delete')) {
    console.log(`\n🗑️  Deleting ${filesToDelete.size} files...`);
    let deleted = 0;
    for (const filepath of filesToDelete) {
      try {
        fs.unlinkSync(filepath);
        deleted++;
        console.log(`  ✓ Deleted: ${filepath}`);
      } catch (err) {
        console.error(`  ✗ Error deleting ${filepath}: ${err.message}`);
      }
    }
    console.log(`\n✅ Deleted ${deleted} files`);
  } else {
    console.log(`\n💡 Run with --delete flag to actually delete these files`);
    fs.writeFileSync(
      path.join(__dirname, 'files-to-delete.txt'),
      Array.from(filesToDelete).sort().join('\n')
    );
    console.log(`   List saved to files-to-delete.txt`);
  }
} else {
  console.log(`\n✅ No duplicates or incomplete files found!`);
}
