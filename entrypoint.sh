#!/bin/sh
set -e
# Ensure the data directory is writable by the sshweb user.
# On Linux, bind-mounted host directories are often created by root
# (Docker daemon), so we chown here before dropping privileges.
chown -R sshweb:sshweb /data 2>/dev/null || true
exec su-exec sshweb "$@"
