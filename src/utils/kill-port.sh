#!/bin/bash
# Kill process using a specified port (default: 45701)
# Usage: kill-port.sh [PORT]
#   or: PORT=8080 kill-port.sh
#   or: kill-port.sh 8080

# Use environment variable, command line argument, or default
PORT="${PORT:-${1:-45701}}"

PID=$(lsof -ti:$PORT 2>/dev/null)
if [ -z "$PID" ]; then
  echo "No process found using port $PORT"
  exit 0
else
  echo "Killing process $PID using port $PORT"
  kill -9 $PID
  echo "Done"
fi
