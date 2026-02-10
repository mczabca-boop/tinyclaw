#!/bin/bash
# TinyClaw Setup Wizard

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$SCRIPT_DIR/.tinyclaw"

echo ""
echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}  TinyClaw - Setup Wizard${NC}"
echo -e "${BLUE}======================================================${NC}"
echo ""

# Channel selection
echo "Which messaging channel do you want to use?"
echo ""
echo "  1) Discord"
echo "  2) WhatsApp"
echo "  3) Telegram"
echo "  4) Discord + WhatsApp"
echo "  5) Discord + Telegram"
echo "  6) WhatsApp + Telegram"
echo "  7) All (Discord + WhatsApp + Telegram)"
echo ""
read -rp "Choose [1-7]: " CHANNEL_CHOICE

case "$CHANNEL_CHOICE" in
    1) CHANNEL="discord" ;;
    2) CHANNEL="whatsapp" ;;
    3) CHANNEL="telegram" ;;
    4) CHANNEL="both" ;;
    5) CHANNEL="discord_telegram" ;;
    6) CHANNEL="whatsapp_telegram" ;;
    7) CHANNEL="all" ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
echo -e "${GREEN}✓ Channel: $CHANNEL${NC}"
echo ""

# Determine required credentials
NEEDS_DISCORD=false
NEEDS_TELEGRAM=false

case "$CHANNEL" in
    discord|both|discord_telegram|all) NEEDS_DISCORD=true ;;
esac

case "$CHANNEL" in
    telegram|discord_telegram|whatsapp_telegram|all) NEEDS_TELEGRAM=true ;;
esac

# Discord bot token (if needed)
DISCORD_TOKEN=""
if [ "$NEEDS_DISCORD" = true ]; then
    echo "Enter your Discord bot token:"
    echo -e "${YELLOW}(Get one at: https://discord.com/developers/applications)${NC}"
    echo ""
    read -rp "Token: " DISCORD_TOKEN

    if [ -z "$DISCORD_TOKEN" ]; then
        echo -e "${RED}Discord bot token is required${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Discord token saved${NC}"
    echo ""
fi

# Telegram credentials (if needed)
TELEGRAM_TOKEN=""
TELEGRAM_ALLOWED_ID=""
if [ "$NEEDS_TELEGRAM" = true ]; then
    echo "Enter your Telegram bot token:"
    echo -e "${YELLOW}(Get one at: https://t.me/BotFather)${NC}"
    echo ""
    read -rp "Token: " TELEGRAM_TOKEN

    if [ -z "$TELEGRAM_TOKEN" ]; then
        echo -e "${RED}Telegram bot token is required${NC}"
        exit 1
    fi

    echo ""
    echo "Enter allowed Telegram chat/user ID:"
    echo -e "${YELLOW}(Only this ID can use the bot, e.g. 123456789)${NC}"
    echo ""
    read -rp "Allowed ID: " TELEGRAM_ALLOWED_ID

    if ! [[ "$TELEGRAM_ALLOWED_ID" =~ ^-?[0-9]+$ ]]; then
        echo -e "${RED}Telegram allowed ID must be a number${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Telegram credentials saved${NC}"
    echo ""
fi

# Model selection
echo "Which Claude model?"
echo ""
echo "  1) Sonnet  (fast, recommended)"
echo "  2) Opus    (smartest)"
echo ""
read -rp "Choose [1-2]: " MODEL_CHOICE

case "$MODEL_CHOICE" in
    1) MODEL="sonnet" ;;
    2) MODEL="opus" ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
echo -e "${GREEN}✓ Model: $MODEL${NC}"
echo ""

# Heartbeat interval
echo "Heartbeat interval (seconds)?"
echo -e "${YELLOW}(How often Claude checks in proactively)${NC}"
echo ""
read -rp "Interval [default: 500]: " HEARTBEAT_INPUT
HEARTBEAT_INTERVAL=${HEARTBEAT_INPUT:-500}

# Validate it's a number
if ! [[ "$HEARTBEAT_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Invalid interval, using default 500${NC}"
    HEARTBEAT_INTERVAL=500
fi
echo -e "${GREEN}✓ Heartbeat interval: ${HEARTBEAT_INTERVAL}s${NC}"
echo ""

# Write settings.json
cat > "$SETTINGS_FILE" <<EOF
{
  "channel": "$CHANNEL",
  "model": "$MODEL",
  "discord_bot_token": "$DISCORD_TOKEN",
  "telegram_token": "$TELEGRAM_TOKEN",
  "telegram_allowed_id": "$TELEGRAM_ALLOWED_ID",
  "heartbeat_interval": $HEARTBEAT_INTERVAL
}
EOF

echo -e "${GREEN}✓ Configuration saved to .tinyclaw/settings.json${NC}"
echo ""
echo "You can now start TinyClaw:"
echo -e "  ${GREEN}./tinyclaw.sh start${NC}"
echo ""
