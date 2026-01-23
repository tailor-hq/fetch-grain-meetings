#!/usr/bin/env node
/**
 * Wrapper script - runs the main fetch script from src/scripts/
 */
const { main } = require('./src/scripts/fetch-new-grain-meetings.js');
main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
