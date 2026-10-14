#!/usr/bin/env bash
# Post-deploy smoke test for the credit-cards app. Needs only bash + curl.
#
#   scripts/smoke-test.sh https://rewards.erankam.dev
#   scripts/smoke-test.sh http://127.0.0.1:3006 --no-register
#   BASE_URL=http://127.0.0.1:3001 scripts/smoke-test.sh
#
# Anonymous checks (always): /api/health = 200, anonymous /api/cards = 401, security headers
# (CSP, X-Content-Type-Options, Cache-Control no-store on /api), SPA shell, cross-site POST = 403.
#
# Account checks (skipped with --no-register, or when SMOKE_INVITE is unset because registration is
# invite-only: pass a single-use invite token, e.g. SMOKE_INVITE=<token>): registers a throwaway user, then runs
# me -> logout -> me, and verifies the session cookie flags (HttpOnly, SameSite, Secure on https)
# and that the OLD cookie value is rejected after logout (server-side revocation).
#
# The throwaway user (smoke-<random>@example.com) is NOT deleted: the app has no delete-account
# endpoint. On production use --no-register unless you accept one extra row in `users`; to
# remove it: sqlite3 data/rewards.db "DELETE FROM users WHERE email LIKE 'smoke-%@example.com'"
# (stop the container first, or use the online node snippet in deploy/DEPLOY.md).
#
# Options via env: CURL_OPTS (e.g. "-k" for a self-signed certificate).
# Exit code 0 = all checks passed, 1 = at least one failed, 2 = usage error.

set -u

BASE_URL="${BASE_URL:-}"
REGISTER=1
for arg in "$@"; do
  case "$arg" in
    --no-register) REGISTER=0 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) BASE_URL="$arg" ;;
  esac
done
if [ "$REGISTER" = 1 ] && [ -z "${SMOKE_INVITE:-}" ]; then
  echo "Note: registration is invite-only and SMOKE_INVITE is not set; account checks will be skipped." >&2
  REGISTER=0
fi
if [ -z "$BASE_URL" ]; then
  echo "Usage: $0 BASE_URL [--no-register]" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in
  http://*|https://*) ;;
  *) echo "BASE_URL must start with http:// or https://" >&2; exit 2 ;;
esac
ORIGIN="$(printf '%s' "$BASE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
IS_HTTPS=0
case "$BASE_URL" in https://*) IS_HTTPS=1 ;; esac

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

TMP="$(mktemp -d)"
[ -n "$TMP" ] && [ -d "$TMP" ] || { echo "mktemp failed" >&2; exit 2; }
trap 'rm -rf -- "$TMP"' EXIT
JAR="$TMP/jar"
PASS=0
FAIL=0
WARN=0

ok()   { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; }
warn() { WARN=$((WARN + 1)); printf '  WARN  %s\n' "$1"; }
# IMPORTANT: capture the condition's status with `rc=$?` on the line BEFORE calling check, and pass
# "$rc". Never put `$(...)` in the description and `$?` in the same call: the command substitution
# runs first and overwrites `$?`, so the check would always pass.
check() { # check "description" <exit status of the condition>
  if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi
}

# request METHOD PATH [curl args...] -> sets STATUS, HEADERS (file), BODY (file)
HEADERS="$TMP/headers"
BODY="$TMP/body"
STATUS=""
request() {
  local method="$1" path="$2"
  shift 2
  # shellcheck disable=SC2086
  STATUS="$(curl -sS ${CURL_OPTS:-} --max-time 20 -X "$method" -D "$HEADERS" -o "$BODY" \
    -w '%{http_code}' "$@" "$BASE_URL$path" 2>"$TMP/curl-err")" || {
    STATUS="000"
    printf '        curl error: %s\n' "$(tr -d '\n' <"$TMP/curl-err")"
  }
  tr -d '\r' <"$HEADERS" >"$HEADERS.clean" && mv "$HEADERS.clean" "$HEADERS"
}
header() { grep -i "^$1:" "$HEADERS" | head -n 1 | sed -E 's/^[^:]*:[[:space:]]*//'; }
has_header() { grep -qi "^$1:" "$HEADERS"; }
json_field() { sed -n -E "s/.*\"$1\":\"([^\"]*)\".*/\1/p" "$BODY" | head -n 1; }

echo "Smoke test: $BASE_URL"

echo "Anonymous checks"
request GET /api/health
check "GET /api/health -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
grep -q '"ok":true' "$BODY"; check "health body is {ok:true}" $?

request GET /api/cards
check "anonymous GET /api/cards -> 401 (got $STATUS)" "$([ "$STATUS" = 401 ]; echo $?)"
header Cache-Control | grep -qi 'no-store'; rc=$?
check "Cache-Control: no-store on /api (got '$(header Cache-Control)')" "$rc"
if grep -q 'riseup_pat\|"email"' "$BODY"; then bad "401 body leaks data"; else ok "401 body carries no data"; fi

request GET /
check "GET / -> 200 SPA shell (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
grep -qi '<div id="root"' "$BODY"; check "SPA shell contains the React root element" $?
header Content-Type | grep -qi 'text/html'; check "SPA shell is text/html" $?
has_header Content-Security-Policy; check "Content-Security-Policy present on /" $?
header Content-Security-Policy | grep -q "default-src 'self'"; check "CSP default-src 'self'" $?
header X-Content-Type-Options | grep -qi nosniff; check "X-Content-Type-Options: nosniff on /" $?
header Cache-Control | grep -qi 'no-cache'; rc=$?
check "index.html is Cache-Control: no-cache (got '$(header Cache-Control)')" "$rc"

request GET /login
check "SPA fallback: GET /login -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"

request GET /api/health
has_header Content-Security-Policy; check "Content-Security-Policy present on /api responses" $?
header X-Content-Type-Options | grep -qi nosniff; check "X-Content-Type-Options: nosniff on /api" $?
if [ "$IS_HTTPS" -eq 1 ]; then
  if has_header Strict-Transport-Security; then ok "Strict-Transport-Security present (https)"
  else warn "no Strict-Transport-Security header (the app sends it only with NODE_ENV=production; do not add it in nginx, see deploy/DEPLOY.md)"; fi
fi

request POST /api/auth/login -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  --data '{"email":"nobody@example.com","password":"not-a-real-password"}'
check "cross-site Origin POST is rejected by CSRF check -> 403 (got $STATUS)" "$([ "$STATUS" = 403 ]; echo $?)"

request POST /api/auth/login -H 'Content-Type: application/json' \
  --data '{"email":"nobody@example.com","password":"not-a-real-password"}'
check "POST without Origin is rejected -> 403 (got $STATUS)" "$([ "$STATUS" = 403 ]; echo $?)"

if [ "$REGISTER" -eq 1 ]; then
  echo "Account checks (throwaway user)"
  RAND="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  EMAIL="smoke-$RAND@example.com"
  # 24 random alphanumerics + fixed suffix: satisfies the 10-128 character policy, never logged.
  PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')Aa1"
  JSON_HDR='Content-Type: application/json'
  # Secrets never go in curl's argv (visible in `ps`): the credentials JSON is read from a file
  # (--data @file) and session cookies are sent via a header file (-H @file). $TMP is mode 700.
  CRED="$TMP/cred.json"
  ( umask 077; printf '{"email":"%s","password":"%s","invite":"%s"}' "$EMAIL" "$PASSWORD" "${SMOKE_INVITE:-}" >"$CRED" )
  cookie_hdr() { ( umask 077; printf 'Cookie: %s=%s\n' "$1" "$2" >"$TMP/cookie-hdr" ); }
  ORIGIN_HDR="Origin: $ORIGIN"

  request POST /api/auth/register -c "$JAR" -b "$JAR" -H "$JSON_HDR" -H "$ORIGIN_HDR" \
    --data @"$CRED"
  check "register -> 201 (got $STATUS)" "$([ "$STATUS" = 201 ]; echo $?)"
  if [ "$STATUS" != 201 ]; then
    printf '        body: %s\n' "$(head -c 300 "$BODY")"
    echo "Cannot continue account checks (is this origin allowed? is the register rate limit hit?)"
  else
    SETCOOKIE="$(grep -i '^set-cookie:' "$HEADERS" | head -n 1 | sed -E 's/^[^:]*:[[:space:]]*//')"
    COOKIE_NAME="${SETCOOKIE%%=*}"
    COOKIE_VALUE="$(printf '%s' "$SETCOOKIE" | sed -E 's/^[^=]*=([^;]*).*/\1/')"
    [ -n "$COOKIE_VALUE" ]; rc=$?
    check "register sets a session cookie ($COOKIE_NAME)" "$rc"
    printf '%s' "$SETCOOKIE" | grep -qi '; *HttpOnly'; check "cookie has HttpOnly" $?
    printf '%s' "$SETCOOKIE" | grep -qi '; *SameSite=\(Lax\|Strict\)'; check "cookie has SameSite=Lax|Strict" $?
    printf '%s' "$SETCOOKIE" | grep -qi '; *Path=/\(;\|$\)'; check "cookie has Path=/" $?
    if printf '%s' "$SETCOOKIE" | grep -qi '; *Domain='; then bad "cookie must not set Domain (host-only)"; else ok "cookie is host-only (no Domain)"; fi
    if [ "$IS_HTTPS" -eq 1 ]; then
      printf '%s' "$SETCOOKIE" | grep -qi '; *Secure'; check "cookie has Secure (https)" $?
      [ "$COOKIE_NAME" = "__Host-sid" ]; rc=$?
      check "cookie name is __Host-sid (got $COOKIE_NAME)" "$rc"
    else
      if printf '%s' "$SETCOOKIE" | grep -qi '; *Secure'; then
        warn "http origin but the cookie is Secure: the browser will drop it. Set COOKIE_SECURE=false for plain http, or use https"
      else
        warn "http origin: cookie has no Secure flag (expected only for plain-http/local deployments)"
      fi
    fi

    request GET /api/auth/me -c "$JAR" -b "$JAR"
    check "me after register -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    [ "$(json_field email)" = "$EMAIL" ]; check "me returns the registered email" $?

    # Fresh login with a separate jar: the new session must differ from the registration one.
    JAR2="$TMP/jar2"
    request POST /api/auth/login -c "$JAR2" -b "$JAR2" -H "$JSON_HDR" -H "$ORIGIN_HDR" \
      --data @"$CRED"
    check "login -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    LOGIN_COOKIE="$(grep -i '^set-cookie:' "$HEADERS" | head -n 1 | sed -E 's/^[^=]*=([^;]*).*/\1/')"
    [ -n "$LOGIN_COOKIE" ] && [ "$LOGIN_COOKIE" != "$COOKIE_VALUE" ]; check "login issues a new session token" $?

    request GET /api/auth/me -c "$JAR2" -b "$JAR2"
    check "me after login -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    request GET /api/cards -c "$JAR2" -b "$JAR2"
    check "authenticated GET /api/cards -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    [ "$(head -c 2 "$BODY")" = "[]" ]; check "new user starts with no cards (data isolation)" $?

    request POST /api/auth/logout -c "$JAR2" -b "$JAR2" -H "$JSON_HDR" -H "$ORIGIN_HDR" --data '{}'
    check "logout -> 200 (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    grep -i '^set-cookie:' "$HEADERS" | grep -qi 'Max-Age=0'; check "logout clears the cookie (Max-Age=0)" $?

    # Replay the OLD token by hand: proves the session is revoked server-side, not just dropped
    # from the client's cookie jar.
    cookie_hdr "$COOKIE_NAME" "$LOGIN_COOKIE"
    request GET /api/auth/me -H @"$TMP/cookie-hdr"
    check "logged-out session token is rejected -> 401 (got $STATUS)" "$([ "$STATUS" = 401 ]; echo $?)"
    cookie_hdr "$COOKIE_NAME" "$COOKIE_VALUE"
    request GET /api/auth/me -H @"$TMP/cookie-hdr"
    check "registration session token still valid until its own logout (got $STATUS)" "$([ "$STATUS" = 200 ]; echo $?)"
    request POST /api/auth/logout -H "$JSON_HDR" -H "$ORIGIN_HDR" -H @"$TMP/cookie-hdr" --data '{}'
    request GET /api/auth/me -H @"$TMP/cookie-hdr"
    check "after logout the registration token is rejected -> 401 (got $STATUS)" "$([ "$STATUS" = 401 ]; echo $?)"
    echo "  note  throwaway user left in the database: $EMAIL"
  fi
else
  echo "Account checks skipped (--no-register)"
fi

echo
echo "Result: $PASS passed, $FAIL failed, $WARN warnings"
[ "$FAIL" -eq 0 ]
