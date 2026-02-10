#!/bin/bash
# TinyClaw - Main daemon using tmux + Claude + multi-channel clients

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="tinyclaw"
LOG_DIR="$SCRIPT_DIR/.tinyclaw/logs"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/daemon.log"
}

load_settings() {
    if [ ! -f "$SETTINGS_FILE" ]; then
        return 1
    fi

    CHANNEL=$(grep -o '"channel"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    DISCORD_TOKEN=$(grep -o '"discord_bot_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    TELEGRAM_TOKEN=$(grep -o '"telegram_token"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
    TELEGRAM_ALLOWED_ID=$(grep -o '"telegram_allowed_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)

    return 0
}

set_env_var() {
    local key="$1"
    local value="$2"
    local env_file="$SCRIPT_DIR/.env"

    touch "$env_file"

    if grep -q "^${key}=" "$env_file"; then
        awk -v k="$key" -v v="$value" '
            BEGIN { FS=OFS="=" }
            $1 == k { $0 = k "=" v }
            { print }
        ' "$env_file" > "${env_file}.tmp" && mv "${env_file}.tmp" "$env_file"
    else
        echo "${key}=${value}" >> "$env_file"
    fi
}

session_exists() {
    tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

resolve_channels() {
    HAS_DISCORD=false
    HAS_WHATSAPP=false
    HAS_TELEGRAM=false

    case "$CHANNEL" in
        discord) HAS_DISCORD=true ;;
        whatsapp) HAS_WHATSAPP=true ;;
        telegram) HAS_TELEGRAM=true ;;
        both) HAS_DISCORD=true; HAS_WHATSAPP=true ;;
        discord_telegram) HAS_DISCORD=true; HAS_TELEGRAM=true ;;
        whatsapp_telegram) HAS_WHATSAPP=true; HAS_TELEGRAM=true ;;
        all) HAS_DISCORD=true; HAS_WHATSAPP=true; HAS_TELEGRAM=true ;;
        *)
            echo -e "${RED}Invalid channel config: $CHANNEL${NC}"
            echo "Run './tinyclaw.sh setup' to reconfigure"
            return 1
            ;;
    esac

    return 0
}

maybe_build() {
    if [ ! -d "$SCRIPT_DIR/dist" ] \
        || [ "$SCRIPT_DIR/src/whatsapp-client.ts" -nt "$SCRIPT_DIR/dist/whatsapp-client.js" ] \
        || [ "$SCRIPT_DIR/src/discord-client.ts" -nt "$SCRIPT_DIR/dist/discord-client.js" ] \
        || [ "$SCRIPT_DIR/src/queue-processor.ts" -nt "$SCRIPT_DIR/dist/queue-processor.js" ] \
        || [ "$SCRIPT_DIR/src/clients/telegram.ts" -nt "$SCRIPT_DIR/dist/clients/telegram.js" ]; then
        echo -e "${YELLOW}Building TypeScript...${NC}"
        cd "$SCRIPT_DIR" || return 1
        npm run build || return 1
    fi

    return 0
}

start_tmux() {
    local LOG_TAIL_CMD="tail -f .tinyclaw/logs/queue.log"
    local pane_count=0
    local i=0

    [ "$HAS_DISCORD" = true ] && LOG_TAIL_CMD="$LOG_TAIL_CMD .tinyclaw/logs/discord.log"
    [ "$HAS_WHATSAPP" = true ] && LOG_TAIL_CMD="$LOG_TAIL_CMD .tinyclaw/logs/whatsapp.log"
    [ "$HAS_TELEGRAM" = true ] && LOG_TAIL_CMD="$LOG_TAIL_CMD .tinyclaw/logs/telegram.log"

    local -a PANE_CMDS=()
    local -a PANE_TITLES=()

    WHATSAPP_PANE=-1

    if [ "$HAS_WHATSAPP" = true ]; then
        WHATSAPP_PANE=${#PANE_CMDS[@]}
        PANE_CMDS+=("cd '$SCRIPT_DIR' && node dist/whatsapp-client.js")
        PANE_TITLES+=("WhatsApp")
    fi

    if [ "$HAS_DISCORD" = true ]; then
        PANE_CMDS+=("cd '$SCRIPT_DIR' && node dist/discord-client.js")
        PANE_TITLES+=("Discord")
    fi

    if [ "$HAS_TELEGRAM" = true ]; then
        PANE_CMDS+=("cd '$SCRIPT_DIR' && node dist/clients/telegram.js")
        PANE_TITLES+=("Telegram")
    fi

    PANE_CMDS+=("cd '$SCRIPT_DIR' && node dist/queue-processor.js")
    PANE_TITLES+=("Queue")

    PANE_CMDS+=("cd '$SCRIPT_DIR' && ./heartbeat-cron.sh")
    PANE_TITLES+=("Heartbeat")

    PANE_CMDS+=("cd '$SCRIPT_DIR' && $LOG_TAIL_CMD")
    PANE_TITLES+=("Logs")

    pane_count=${#PANE_CMDS[@]}
    PANE_COUNT=$pane_count

    tmux new-session -d -s "$TMUX_SESSION" -n "tinyclaw" -c "$SCRIPT_DIR"

    for ((i = 1; i < pane_count; i++)); do
        tmux split-window -t "$TMUX_SESSION:0" -c "$SCRIPT_DIR"
        tmux select-layout -t "$TMUX_SESSION:0" tiled
    done

    for ((i = 0; i < pane_count; i++)); do
        tmux send-keys -t "$TMUX_SESSION:0.$i" "${PANE_CMDS[$i]}" C-m
        tmux select-pane -t "$TMUX_SESSION:0.$i" -T "${PANE_TITLES[$i]}"
    done
}

show_whatsapp_qr_flow() {
    if [ "$WHATSAPP_PANE" -lt 0 ]; then
        return
    fi

    echo -e "${YELLOW}Starting WhatsApp client...${NC}"
    echo ""

    local QR_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_qr.txt"
    local READY_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"
    local QR_DISPLAYED=false
    local i=0

    for i in {1..60}; do
        sleep 1

        if [ -f "$READY_FILE" ]; then
            echo ""
            echo -e "${GREEN}WhatsApp connected and ready.${NC}"
            rm -f "$QR_FILE"
            break
        fi

        if [ -f "$QR_FILE" ] && [ "$QR_DISPLAYED" = false ]; then
            sleep 1
            clear
            echo ""
            echo -e "${BLUE}====================== WhatsApp QR ======================${NC}"
            echo ""
            cat "$QR_FILE"
            echo ""
            echo -e "${BLUE}==========================================================${NC}"
            echo "Scan with WhatsApp:"
            echo "  1. Open WhatsApp on your phone"
            echo "  2. Settings -> Linked Devices"
            echo "  3. Tap 'Link a Device'"
            echo "  4. Scan the QR code above"
            echo ""
            echo -e "${BLUE}Waiting for connection...${NC}"
            QR_DISPLAYED=true
        fi

        if [ "$QR_DISPLAYED" = true ] || [ "$i" -gt 10 ]; then
            echo -n "."
        fi
    done
    echo ""

    if [ "$i" -eq 60 ] && [ ! -f "$READY_FILE" ]; then
        echo ""
        echo -e "${RED}WhatsApp did not connect within 60 seconds.${NC}"
        echo ""
        echo "Try:"
        echo "  ./tinyclaw.sh restart"
        echo "  ./tinyclaw.sh logs whatsapp"
        echo "  tmux attach -t $TMUX_SESSION"
        echo ""
    fi
}

start_daemon() {
    if session_exists; then
        echo -e "${YELLOW}Session already running${NC}"
        return 1
    fi

    log "Starting TinyClaw daemon..."

    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        echo -e "${YELLOW}Installing Node.js dependencies...${NC}"
        cd "$SCRIPT_DIR" || return 1
        PUPPETEER_SKIP_DOWNLOAD=true npm install || return 1
    fi

    maybe_build || return 1

    if ! load_settings; then
        echo -e "${YELLOW}No configuration found. Running setup wizard...${NC}"
        echo ""
        "$SCRIPT_DIR/setup-wizard.sh" || return 1
        load_settings || return 1
    fi

    resolve_channels || return 1

    if [ "$HAS_DISCORD" = true ] && [ -z "${DISCORD_TOKEN:-}" ]; then
        echo -e "${RED}Discord is enabled but discord_bot_token is missing.${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure."
        return 1
    fi

    if [ "$HAS_TELEGRAM" = true ] && [ -z "${TELEGRAM_TOKEN:-}" ]; then
        echo -e "${RED}Telegram is enabled but telegram_token is missing.${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure."
        return 1
    fi

    if [ "$HAS_TELEGRAM" = true ] && [ -z "${TELEGRAM_ALLOWED_ID:-}" ]; then
        echo -e "${RED}Telegram is enabled but telegram_allowed_id is missing.${NC}"
        echo "Run './tinyclaw.sh setup' to reconfigure."
        return 1
    fi

    [ "$HAS_DISCORD" = true ] && set_env_var "DISCORD_BOT_TOKEN" "$DISCORD_TOKEN"
    if [ "$HAS_TELEGRAM" = true ]; then
        set_env_var "TELEGRAM_TOKEN" "$TELEGRAM_TOKEN"
        set_env_var "TELEGRAM_ALLOWED_ID" "$TELEGRAM_ALLOWED_ID"
    fi

    echo -e "${BLUE}Channels:${NC}"
    [ "$HAS_DISCORD" = true ] && echo -e "  ${GREEN}OK${NC} Discord"
    [ "$HAS_WHATSAPP" = true ] && echo -e "  ${GREEN}OK${NC} WhatsApp"
    [ "$HAS_TELEGRAM" = true ] && echo -e "  ${GREEN}OK${NC} Telegram"
    echo ""

    start_tmux

    echo ""
    echo -e "${GREEN}TinyClaw started${NC}"
    echo ""

    show_whatsapp_qr_flow

    echo ""
    echo -e "${GREEN}Commands:${NC}"
    echo "  Status:  ./tinyclaw.sh status"
    echo "  Logs:    ./tinyclaw.sh logs [whatsapp|discord|telegram|queue|heartbeat|daemon]"
    echo "  Attach:  tmux attach -t $TMUX_SESSION"
    echo ""

    log "Daemon started with $PANE_COUNT panes (discord=$HAS_DISCORD, whatsapp=$HAS_WHATSAPP, telegram=$HAS_TELEGRAM)"
}

stop_daemon() {
    log "Stopping TinyClaw..."

    if session_exists; then
        tmux kill-session -t "$TMUX_SESSION"
    fi

    pkill -f "dist/whatsapp-client.js" || true
    pkill -f "dist/discord-client.js" || true
    pkill -f "dist/clients/telegram.js" || true
    pkill -f "dist/queue-processor.js" || true
    pkill -f "heartbeat-cron.sh" || true

    echo -e "${GREEN}TinyClaw stopped${NC}"
    log "Daemon stopped"
}

send_message() {
    local message="$1"
    local source="${2:-manual}"

    log "[$source] Sending: ${message:0:50}..."
    cd "$SCRIPT_DIR" || return 1

    RESPONSE=$(claude --dangerously-skip-permissions -c -p "$message" 2>&1)
    echo "$RESPONSE"

    log "[$source] Response length: ${#RESPONSE} chars"
}

status_daemon() {
    echo -e "${BLUE}TinyClaw Status${NC}"
    echo "==============="
    echo ""

    if session_exists; then
        echo -e "Tmux Session: ${GREEN}Running${NC}"
        echo "  Attach: tmux attach -t $TMUX_SESSION"
    else
        echo -e "Tmux Session: ${RED}Not Running${NC}"
        echo "  Start: ./tinyclaw.sh start"
    fi

    echo ""

    local READY_FILE="$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"

    if pgrep -f "dist/whatsapp-client.js" > /dev/null; then
        if [ -f "$READY_FILE" ]; then
            echo -e "WhatsApp Client: ${GREEN}Running & Ready${NC}"
        else
            echo -e "WhatsApp Client: ${YELLOW}Running (not ready yet)${NC}"
        fi
    else
        echo -e "WhatsApp Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/discord-client.js" > /dev/null; then
        echo -e "Discord Client:  ${GREEN}Running${NC}"
    else
        echo -e "Discord Client:  ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/clients/telegram.js" > /dev/null; then
        echo -e "Telegram Client: ${GREEN}Running${NC}"
    else
        echo -e "Telegram Client: ${RED}Not Running${NC}"
    fi

    if pgrep -f "dist/queue-processor.js" > /dev/null; then
        echo -e "Queue Processor: ${GREEN}Running${NC}"
    else
        echo -e "Queue Processor: ${RED}Not Running${NC}"
    fi

    if pgrep -f "heartbeat-cron.sh" > /dev/null; then
        echo -e "Heartbeat: ${GREEN}Running${NC}"
    else
        echo -e "Heartbeat: ${RED}Not Running${NC}"
    fi

    echo ""
    echo "Recent Telegram Activity:"
    echo "-------------------------"
    tail -n 5 "$LOG_DIR/telegram.log" 2>/dev/null || echo "  No Telegram activity yet"

    echo ""
    echo "Recent WhatsApp Activity:"
    echo "-------------------------"
    tail -n 5 "$LOG_DIR/whatsapp.log" 2>/dev/null || echo "  No WhatsApp activity yet"

    echo ""
    echo "Recent Discord Activity:"
    echo "------------------------"
    tail -n 5 "$LOG_DIR/discord.log" 2>/dev/null || echo "  No Discord activity yet"

    echo ""
    echo "Recent Queue Activity:"
    echo "----------------------"
    tail -n 5 "$LOG_DIR/queue.log" 2>/dev/null || echo "  No queue activity yet"

    echo ""
    echo "Recent Heartbeats:"
    echo "------------------"
    tail -n 3 "$LOG_DIR/heartbeat.log" 2>/dev/null || echo "  No heartbeat logs yet"
}

logs() {
    case "${1:-queue}" in
        whatsapp|wa)
            tail -f "$LOG_DIR/whatsapp.log"
            ;;
        discord|dc)
            tail -f "$LOG_DIR/discord.log"
            ;;
        telegram|tg)
            tail -f "$LOG_DIR/telegram.log"
            ;;
        queue|q)
            tail -f "$LOG_DIR/queue.log"
            ;;
        heartbeat|hb)
            tail -f "$LOG_DIR/heartbeat.log"
            ;;
        daemon)
            tail -f "$LOG_DIR/daemon.log"
            ;;
        all)
            tail -f "$LOG_DIR/daemon.log" "$LOG_DIR/queue.log" "$LOG_DIR/heartbeat.log" "$LOG_DIR/whatsapp.log" "$LOG_DIR/discord.log" "$LOG_DIR/telegram.log" 2>/dev/null
            ;;
        *)
            echo "Usage: $0 logs [whatsapp|discord|telegram|queue|heartbeat|daemon|all]"
            ;;
    esac
}

show_usage() {
    echo -e "${BLUE}TinyClaw - Claude Code + WhatsApp + Discord + Telegram${NC}"
    echo ""
    echo "Usage: $0 {start|stop|restart|status|setup|send|logs|reset|channels|model|attach}"
    echo ""
    echo "Commands:"
    echo "  start                    Start TinyClaw"
    echo "  stop                     Stop all processes"
    echo "  restart                  Restart TinyClaw"
    echo "  status                   Show current status"
    echo "  setup                    Run setup wizard"
    echo "  send <msg>               Send message to Claude manually"
    echo "  logs [type]              View logs"
    echo "  reset                    Reset conversation (next message starts fresh)"
    echo "  channels reset <channel> Reset channel auth (whatsapp|discord|telegram)"
    echo "  model [sonnet|opus]      Show or switch Claude model"
    echo "  attach                   Attach to tmux session"
    echo ""
}

case "${1:-}" in
    start)
        start_daemon
        ;;
    stop)
        stop_daemon
        ;;
    restart)
        stop_daemon
        sleep 2
        start_daemon
        ;;
    status)
        status_daemon
        ;;
    send)
        if [ -z "${2:-}" ]; then
            echo "Usage: $0 send <message>"
            exit 1
        fi
        send_message "$2" "cli"
        ;;
    logs)
        logs "${2:-}"
        ;;
    reset)
        echo -e "${YELLOW}Resetting conversation...${NC}"
        touch "$SCRIPT_DIR/.tinyclaw/reset_flag"
        echo -e "${GREEN}Reset flag set${NC}"
        echo "The next message will start a fresh conversation (without -c)."
        ;;
    channels)
        if [ "${2:-}" != "reset" ]; then
            echo "Usage: $0 channels reset {whatsapp|discord|telegram}"
            exit 1
        fi

        case "${3:-}" in
            whatsapp)
                echo -e "${YELLOW}Resetting WhatsApp authentication...${NC}"
                rm -rf "$SCRIPT_DIR/.tinyclaw/whatsapp-session"
                rm -f "$SCRIPT_DIR/.tinyclaw/channels/whatsapp_ready"
                rm -f "$SCRIPT_DIR/.tinyclaw/channels/whatsapp_qr.txt"
                rm -rf "$SCRIPT_DIR/.wwebjs_cache"
                echo -e "${GREEN}WhatsApp session cleared${NC}"
                echo "Restart TinyClaw to re-authenticate:"
                echo "  ./tinyclaw.sh restart"
                ;;
            discord)
                echo -e "${YELLOW}Resetting Discord authentication...${NC}"
                echo "Run setup to update discord_bot_token:"
                echo "  ./tinyclaw.sh setup"
                ;;
            telegram)
                echo -e "${YELLOW}Resetting Telegram authentication...${NC}"
                echo "Run setup to update telegram_token / telegram_allowed_id:"
                echo "  ./tinyclaw.sh setup"
                ;;
            *)
                echo "Usage: $0 channels reset {whatsapp|discord|telegram}"
                exit 1
                ;;
        esac
        ;;
    model)
        if [ -z "${2:-}" ]; then
            if [ ! -f "$SETTINGS_FILE" ]; then
                echo -e "${RED}No settings file found${NC}"
                exit 1
            fi
            CURRENT_MODEL=$(grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
            echo -e "${BLUE}Current model: ${GREEN}${CURRENT_MODEL}${NC}"
            exit 0
        fi

        case "$2" in
            sonnet|opus)
                if [ ! -f "$SETTINGS_FILE" ]; then
                    echo -e "${RED}No settings file found. Run setup first.${NC}"
                    exit 1
                fi

                if [[ "$OSTYPE" == "darwin"* ]]; then
                    sed -i '' "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                else
                    sed -i "s/\"model\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"model\": \"$2\"/" "$SETTINGS_FILE"
                fi

                echo -e "${GREEN}Model switched to: $2${NC}"
                echo "Changes take effect on next message."
                ;;
            *)
                echo "Usage: $0 model {sonnet|opus}"
                exit 1
                ;;
        esac
        ;;
    attach)
        tmux attach -t "$TMUX_SESSION"
        ;;
    setup)
        "$SCRIPT_DIR/setup-wizard.sh"
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
