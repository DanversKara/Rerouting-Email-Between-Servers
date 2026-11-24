#!/bin/sh
# Install or update the home side of the mail mirror, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/DanversKara/Rerouting-Email-Between-Servers/main/home-inject/install.sh | sh
#
# Safe to run any number of times. It:
#   1. downloads the latest mail-inject / state-watch files from GitHub
#      (main branch) and installs them in /opt/mail-inject,
#   2. installs/updates the systemd units, including an hourly timer that
#      re-runs this script, so the home server keeps itself up to date,
#   3. makes sure every mirrored mailbox has a Sent folder,
#   4. restarts the services ONLY when a file actually changed.
#
# Needs /opt/mail-inject/mail-inject.env to exist (it holds your token and
# user list and is never touched by this script).
#
# To stop automatic updates:  systemctl disable --now mail-inject-update.timer

set -eu

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/DanversKara/Rerouting-Email-Between-Servers/main/home-inject}"
DIR=/opt/mail-inject
ENV_FILE="$DIR/mail-inject.env"
UNIT_DIR=/etc/systemd/system
QUIET="${1:-}"

say() { [ "$QUIET" = "--quiet" ] || echo "$@"; }

if [ "$(id -u)" != 0 ]; then
	echo "Run as root." >&2
	exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
	echo "Missing $ENV_FILE — create it first (see home-inject/README.md, step 3)." >&2
	exit 1
fi

env_get() {
	# value of KEY from the env file, or $2 when unset
	v=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
	[ -n "$v" ] && echo "$v" || echo "$2"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. Download everything first; install nothing unless all of it arrived
#    and the Python files compile (a half-downloaded file must never
#    replace a working one).
for f in mail-inject.py state-watch.py mail-inject.service state-watch.service \
         mail-inject-update.service mail-inject-update.timer install.sh; do
	curl -fsSL --retry 3 -o "$TMP/$f" "$REPO_RAW/$f"
done
python3 -m py_compile "$TMP/mail-inject.py" "$TMP/state-watch.py"
sh -n "$TMP/install.sh"

CODE_CHANGED=0
UNITS_CHANGED=0
put() {
	# put SRC DEST MODE -> returns 0 when the file changed
	if [ -f "$2" ] && cmp -s "$1" "$2"; then
		return 1
	fi
	cp "$1" "$2.new"
	chmod "$3" "$2.new"
	mv -f "$2.new" "$2"   # atomic: a running copy of this script is not disturbed
	say "updated $2"
	return 0
}

mkdir -p "$DIR"
for f in mail-inject.py state-watch.py; do
	if put "$TMP/$f" "$DIR/$f" 755; then CODE_CHANGED=1; fi
done
put "$TMP/install.sh" "$DIR/install.sh" 755 || true
for f in mail-inject.service state-watch.service mail-inject-update.service mail-inject-update.timer; do
	if put "$TMP/$f" "$UNIT_DIR/$f" 644; then UNITS_CHANGED=1; fi
done

if [ "$UNITS_CHANGED" = 1 ]; then
	systemctl daemon-reload
fi
systemctl enable --quiet mail-inject state-watch mail-inject-update.timer
systemctl start --quiet mail-inject-update.timer

# 3. Every mirrored mailbox needs a Sent folder for mail sent from the backup.
MAILSTORE=$(env_get MAILSTORE_CONTAINER plmail-mail-server-mailstore-1)
SENT=$(env_get MAIL_SENT_FOLDER Sent)
USERS=$(env_get MAIL_INJECT_USERS "" | tr ',' ' ')
for u in $USERS; do
	if docker exec "$MAILSTORE" doveadm mailbox list -u "$u" 2>/dev/null | grep -qx "$SENT"; then
		continue
	fi
	if docker exec "$MAILSTORE" doveadm mailbox create -s -u "$u" "$SENT" 2>/dev/null; then
		say "created $SENT folder for $u"
	fi
done

# 4. Restart only when something changed (or a service is not running).
if [ "$CODE_CHANGED" = 1 ] || [ "$UNITS_CHANGED" = 1 ]; then
	systemctl restart mail-inject state-watch
	say "services restarted"
else
	systemctl is-active --quiet mail-inject || systemctl restart mail-inject
	systemctl is-active --quiet state-watch || systemctl restart state-watch
	say "already up to date"
fi
