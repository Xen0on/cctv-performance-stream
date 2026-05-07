#!/bin/bash
# DATA WORKER STREAM - Mac one-click launcher
# Double-click this file in Finder to start the server

# Move to the script's directory (so it works regardless of where the user double-clicked)
cd "$(dirname "$0")"

clear
echo "═══════════════════════════════════════════════"
echo "   📡  DATA WORKER STREAM — Mac launcher"
echo "═══════════════════════════════════════════════"
echo ""

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found."
    echo ""
    echo "   Install it from: https://nodejs.org  (click the LTS button)"
    echo "   Then double-click this file again."
    echo ""
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
fi

echo "✅ Node.js: $(node -v)"
echo ""

# 2. Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 First-time setup — installing dependencies (one-time, ~30s)..."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ npm install failed. Check the error above."
        read -n 1 -s -r -p "Press any key to close..."
        exit 1
    fi
    echo ""
fi

# 3. Run the server
echo "🚀 Starting server..."
echo ""
npm start

# Keep window open if server crashes
echo ""
read -n 1 -s -r -p "Server stopped. Press any key to close..."
