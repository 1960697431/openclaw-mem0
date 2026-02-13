#!/bin/bash

set -e

# Configuration
REPO="1960697431/openclaw-mem0"
BRANCH="main"
INSTALL_DIR="$HOME/.openclaw/extensions/openclaw-mem0"
TEMP_DIR=$(mktemp -d)
ZIP_URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.zip"

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧠 OpenClaw Mem0 Plugin Installer${NC}"
echo "----------------------------------------"

# 1. Check Pre-requisites
if ! command -v curl &> /dev/null; then
    echo -e "${YELLOW}❌ Error: curl is not installed.${NC}"
    exit 1
fi

if ! command -v unzip &> /dev/null; then
    echo -e "${YELLOW}❌ Error: unzip is not installed.${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}❌ Error: npm is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# 2. Download
echo -e "${BLUE}⬇️  Downloading plugin from GitHub...${NC}"
curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 180 \
    "$ZIP_URL" -o "$TEMP_DIR/plugin.zip"

# 3. Extract
echo -e "${BLUE}📦 Extracting files...${NC}"
unzip -q "$TEMP_DIR/plugin.zip" -d "$TEMP_DIR"
EXTRACTED_DIR="$TEMP_DIR/openclaw-mem0-$BRANCH"
if [ ! -d "$EXTRACTED_DIR" ]; then
    echo -e "${YELLOW}❌ Error: extracted directory not found: $EXTRACTED_DIR${NC}"
    exit 1
fi

# 4. Prepare Directory
echo -e "${BLUE}📂 Preparing installation directory...${NC}"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$EXTRACTED_DIR"/. "$INSTALL_DIR"/

# 5. Install Dependencies
echo -e "${BLUE}🚀 Installing dependencies...${NC}"
cd "$INSTALL_DIR"
npm install --production --no-audit --no-fund --silent

# 6. Configure OpenClaw (Enable Plugin & Disable Legacy Memory)
echo -e "${BLUE}⚙️  Configuring OpenClaw...${NC}"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"

if [ -f "$CONFIG_FILE" ]; then
    # Create backup
    cp "$CONFIG_FILE" "$CONFIG_FILE.bak"
    
    # Use python to safely update JSON
    python3 -c "
import sys, json, os

config_path = os.path.expanduser('$CONFIG_FILE')
try:
    with open(config_path, 'r') as f:
        data = json.load(f)

    # 1. Enable Plugin
    if 'plugins' not in data: data['plugins'] = {}
    if 'entries' not in data['plugins']: data['plugins']['entries'] = {}
    if 'slots' not in data['plugins']: data['plugins']['slots'] = {}
    
    # Set as default memory provider
    data['plugins']['slots']['memory'] = 'openclaw-mem0'
    
    # Enable plugin entry if not exists
    if 'openclaw-mem0' not in data['plugins']['entries']:
        data['plugins']['entries']['openclaw-mem0'] = { 'enabled': True }
    else:
        data['plugins']['entries']['openclaw-mem0']['enabled'] = True

    # 2. Disable Legacy Memory Hook (Prevent split-brain)
    if 'hooks' not in data: data['hooks'] = {}
    if 'internal' not in data['hooks']: data['hooks']['internal'] = {}
    if 'entries' not in data['hooks']['internal']: data['hooks']['internal']['entries'] = {}
    
    if 'session-memory' not in data['hooks']['internal']['entries']:
        data['hooks']['internal']['entries']['session-memory'] = {}
    
    data['hooks']['internal']['entries']['session-memory']['enabled'] = False
    print('✅ Disabled legacy session-memory hook')

    # Save
    with open(config_path, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    
    print('✅ Updated openclaw.json')
except Exception as e:
    print(f'⚠️  Config update failed: {e}')
"
else
    echo -e "${YELLOW}⚠️  openclaw.json not found. Skipping auto-config.${NC}"
fi

# 7. Cleanup
trap - EXIT
cleanup

# 8. Success Message
echo "----------------------------------------"
echo -e "${GREEN}✅ Installation Complete!${NC}"
echo ""
echo -e "The plugin has been enabled and legacy memory disabled."
echo -e "Please restart OpenClaw Gateway to apply changes:"
echo ""
echo -e "${BLUE}openclaw gateway restart${NC}"
echo ""
