#!/usr/bin/env bash
set +e
printf 'Chel - Diagnóstico\n'
uname -a
for cmd in node npm pnpm rustc cargo git claude codex agy tailscale; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '[OK] %-18s %s\n' "$cmd" "$("$cmd" --version 2>&1 | head -n 1)"
    printf '     %s\n' "$(command -v "$cmd")"
  else
    printf '[AUSENTE] %s\n' "$cmd"
  fi
done
