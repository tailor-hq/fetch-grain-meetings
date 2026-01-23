#!/usr/bin/env node
/**
 * Find duplicate meeting files and incomplete files
 */

const fs = require('fs');
const path = require('path');
const { getYearRange } = require('../lib/meetings-lib');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MEETINGS_DIR = path.join(ROOT_DIR, 'downloaded-grain-meetings');

const meetingIds = new Map(); // meetingId -> [filepaths]
const titleDateMap = new Map(); // "title_date" -> [filepaths]
const incompleteFiles = [];

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
          
          // Check if incomplete (very short, missing transcript marker, etc.)
          if (content.length < 200 || 
              !content.includes('Meeting ID:') ||
              (!content.includes('Transcript') && !content.includes('## Transcript'))) {
            incompleteFiles.push({ filepath, reason: 'incomplete', size: content.length });
            continue;
          }
          
          // Extract meeting ID
          const idMatch = content.match(/\*\*Meeting ID:\*\* ([a-f0-9-]+)/);
          if (idMatch) {
            const meetingId = idMatch[1];
            if (!meetingIds.has(meetingId)) {
              meetingIds.set(meetingId, []);
            }
            meetingIds.get(meetingId).push(filepath);
          }
          
          // Extract title and date for duplicate detection
          const titleMatch = content.match(/^# (.+)$/m);
          const dateMatch = content.match(/\*\*Date:\*\* ([0-9-]+)/);
          if (titleMatch && dateMatch) {
            const key = `${titleMatch[1]}_${dateMatch[1]}`;
            if (!titleDateMap.has(key)) {
              titleDateMap.set(key, []);
            }
            titleDateMap.get(key).push(filepath);
          }
        } catch (err) {
          incompleteFiles.push({ filepath, reason: 'read_error', error: err.message });
        }
      }
    }
  }
}

scanFiles();

console.log('=== Duplicate Meeting IDs ===');
let duplicateCount = 0;
for (const [meetingId, filepaths] of meetingIds.entries()) {
  if (filepaths.length > 1) {
    duplicateCount++;
    console.log(`\nMeeting ID: ${meetingId.substring(0, 8)}...`);
    filepaths.forEach(fp => console.log(`  - ${fp}`));
  }
}

console.log(`\n=== Duplicate Title/Date Combinations ===`);
let titleDupCount = 0;
for (const [key, filepaths] of titleDateMap.entries()) {
  if (filepaths.length > 1) {
    titleDupCount++;
    console.log(`\n${key}`);
    filepaths.forEach(fp => console.log(`  - ${fp}`));
  }
}

console.log(`\n=== Incomplete Files ===`);
incompleteFiles.forEach(({ filepath, reason, size, error }) => {
  console.log(`${filepath} - ${reason}${size ? ` (${size} bytes)` : ''}${error ? ` - ${error}` : ''}`);
});

console.log(`\n=== Summary ===`);
console.log(`Duplicate meeting IDs: ${duplicateCount}`);
console.log(`Duplicate title/date: ${titleDupCount}`);
console.log(`Incomplete files: ${incompleteFiles.length}`);

// Output files to delete (keep the first one, delete the rest)
const filesToDelete = [];
for (const [meetingId, filepaths] of meetingIds.entries()) {
  if (filepaths.length > 1) {
    // Keep the first, delete the rest
    filesToDelete.push(...filepaths.slice(1));
  }
}
for (const [key, filepaths] of titleDateMap.entries()) {
  if (filepaths.length > 1) {
    // Check if we already marked these for deletion
    const newDups = filepaths.filter(fp => !filesToDelete.includes(fp));
    if (newDups.length > 1) {
      filesToDelete.push(...newDups.slice(1));
    }
  }
}
// Add incomplete files
incompleteFiles.forEach(({ filepath }) => {
  if (!filesToDelete.includes(filepath)) {
    filesToDelete.push(filepath);
  }
});

if (filesToDelete.length > 0) {
  console.log(`\n=== Files to Delete (${filesToDelete.length}) ===`);
  filesToDelete.forEach(fp => console.log(fp));
  
  // Write to file for review
  fs.writeFileSync(
    path.join(__dirname, 'files-to-delete.txt'),
    filesToDelete.join('\n')
  );
  console.log(`\nList written to files-to-delete.txt`);
}
