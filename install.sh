#!/bin/bash

set -e

# Configuration
REPO="1960697431/openclaw-mem0"
BRANCH="main"
INSTALL_DIR="$HOME/.openclaw/extensions/openclaw-mem0"
TEMP_DIR=$(mktemp -d)

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧠 OpenClaw Mem0 Plugin Installer${NC}"
echo "----------------------------------------"

# 1. Check Pre-requisites
if ! command -v npm &> /dev/null; then
    echo -e "${YELLOW}❌ Error: npm is not installed. Please install Node.js first.${NC}"
    exit 1
fi

# 2. Prepare Directory
echo -e "${BLUE}📂 Preparing installation directory...${NC}"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# 3. Download
echo -e "${BLUE}⬇️  Downloading plugin from GitHub...${NC}"
curl -L "https://github.com/$REPO/archive/refs/heads/$BRANCH.zip" -o "$TEMP_DIR/plugin.zip"

# 4. Extract
echo -e "${BLUE}📦 Extracting files...${NC}"
unzip -q "$TEMP_DIR/plugin.zip" -d "$TEMP_DIR"
# Move contents of the inner folder (e.g. openclaw-mem0-main) to install dir
mv "$TEMP_DIR/openclaw-mem0-$BRANCH"/* "$INSTALL_DIR/"

# 5. Install Dependencies
echo -e "${BLUE}🚀 Installing dependencies...${NC}"
cd "$INSTALL_DIR"
npm install --production --no-audit --no-fund --silent

# 6. Cleanup
rm -rf "$TEMP_DIR"

# 7. Success Message
echo "----------------------------------------"
echo -e "${GREEN}✅ Installation Complete!${NC}"
echo ""
echo -e "To enable the plugin, add this to your ${YELLOW}~/.openclaw/openclaw.json${NC}:"
echo ""
echo -e "${GREEN}\"openclaw-mem0\": {${NC}"
echo -e "${GREEN}  \"enabled\": true,${NC}"
echo -e "${GREEN}  \"config\": {${NC}"
echo -e "${GREEN}    \"provider\": \"deepseek\",${NC}"
echo -e "${GREEN}    \"apiKey\": \"sk-YOUR_API_KEY\"${NC}"
echo -e "${GREEN}  }${NC}"
echo -e "${GREEN}}${NC}"
echo ""
echo -e "Then restart OpenClaw: ${YELLOW}openclaw gateway restart${NC}"
