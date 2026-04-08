#!/bin/bash
# Setup membot for SNARC dual-write experiment.
# Run from any machine to enable embedding-based memory alongside FTS5.
#
# Prerequisites:
#   - Python 3.10+
#   - membot repo cloned to ai-agents/membot
#   - pip install -r membot/requirements.txt
#
# What this does:
#   1. Verifies membot is available
#   2. Starts membot HTTP server (writable mode, background)
#   3. Creates initial empty cartridge for this project
#
# Usage:
#   cd /path/to/ai-agents/engram
#   bash scripts/setup-membot.sh
#
# To stop: kill $(lsof -t -i :8000)

set -e

# Find base directory
if [ -d "/mnt/c/projects/ai-agents" ]; then
  BASE="/mnt/c/projects/ai-agents"
elif [ -d "/mnt/c/exe/projects/ai-agents" ]; then
  BASE="/mnt/c/exe/projects/ai-agents"
elif [ -d "$HOME/ai-workspace" ]; then
  BASE="$HOME/ai-workspace"
elif [ -d "$HOME/ai-agents" ]; then
  BASE="$HOME/ai-agents"
else
  echo "Cannot find ai-agents directory"
  exit 1
fi

MEMBOT_DIR="$BASE/membot"
MEMBOT_PORT="${MEMBOT_PORT:-8000}"

# Check membot exists
if [ ! -f "$MEMBOT_DIR/membot_server.py" ]; then
  echo "membot not found at $MEMBOT_DIR"
  echo "Clone it: git clone https://github.com/dp-web4/membot.git $MEMBOT_DIR"
  exit 1
fi

# Use venv if available
PYTHON="python3"
if [ -f "$MEMBOT_DIR/.venv/bin/python" ]; then
  PYTHON="$MEMBOT_DIR/.venv/bin/python"
fi

# Check Python deps
$PYTHON -c "import fastmcp, numpy, sentence_transformers" 2>/dev/null || {
  echo "Installing membot dependencies..."
  $PYTHON -m pip install -r "$MEMBOT_DIR/requirements.txt"
}

# Check if already running
if lsof -t -i ":$MEMBOT_PORT" >/dev/null 2>&1; then
  echo "membot already running on port $MEMBOT_PORT"
  exit 0
fi

# Start membot HTTP server (writable, background)
echo "Starting membot on port $MEMBOT_PORT (writable mode)..."
cd "$MEMBOT_DIR"
$PYTHON membot_server.py --transport http --port "$MEMBOT_PORT" --writable &
MEMBOT_PID=$!

# Wait for startup
sleep 5
if kill -0 $MEMBOT_PID 2>/dev/null; then
  echo "membot running (PID $MEMBOT_PID)"
  echo "Experiment log: ~/.snarc/membot/experiment_log.jsonl"
else
  echo "membot failed to start — check $MEMBOT_DIR/membot.log"
  exit 1
fi
