// Exercise the production nginx template without app credentials or a database:
// the scheme forwarded to /api, and the frame headers on the HTML routes.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const template = readFileSync(new URL('../apps/portal/nginx.conf.template', import.meta.url), 'utf8');
// The probe answers like the API: helmet sends its own X-Frame-Options.
const config = template + `
server {
    listen 8081;
    location /probe {
        add_header X-Frame-Options "SAMEORIGIN";
        return 200 "$http_x_forwarded_proto";
    }
}
`;
const check = `
set -eu
mkdir -p /etc/nginx/templates
cat > /etc/nginx/templates/default.conf.template
/docker-entrypoint.sh nginx -t
nginx
check() {
    expected="$1"
    shift
    actual=$(wget -qO- "$@" http://127.0.0.1:8080/api/probe)
    test "$actual" = "$expected" || {
        echo "Expected $expected, received $actual" >&2
        exit 1
    }
}
check https --header='X-Forwarded-Proto: https'
check http --header='X-Forwarded-Proto: http'
check http
check http --header='X-Forwarded-Proto: invalid'
check http --header='X-Forwarded-Proto: https, http'
echo 'PASS: HTTPS preservation and four HTTP/fallback cases'

# Response headers of a GET, lowercased, one per line.
headers() {
    wget -qS -O /dev/null "http://127.0.0.1:8080$1" 2>&1 | tr -d '\\r' | sed 's/^ *//' | tr 'A-Z' 'a-z'
}
# Every $2 header on the response to $1 is exactly $3 (empty: there is none).
only() {
    actual=$(headers "$1" | grep "^$2:" || true)
    test "$actual" = "$3" || {
        echo "$1: expected $2 [$3], received [$actual]" >&2
        exit 1
    }
}
# /50x.html is a real file the stock image ships, so the fallback location
# serves it directly; the other paths end in the index.html location.
for path in / /index.html /t/acme/login /50x.html; do
    only "$path" content-security-policy "content-security-policy: frame-ancestors 'none'"
    only "$path" x-frame-options 'x-frame-options: deny'
done
only /t/acme/login cache-control 'cache-control: no-cache'
only /api/probe x-frame-options 'x-frame-options: sameorigin'
only /api/probe content-security-policy ''
echo 'PASS: frame headers on four HTML routes, none added to /api'

# The response to $1 has the header line $2.
has() {
    headers "$1" | grep -qxF "$2" || {
        echo "$1: expected [$2], received:" >&2
        headers "$1" >&2
        exit 1
    }
}
# A year's cache only for Vite's hashed /assets/. Root files keep their
# names across builds, op.js above all: brands' sites load it.
html=/usr/share/nginx/html
mkdir -p $html/assets
echo x > $html/assets/index-AbC123.js
echo x > $html/op.js
has /assets/index-AbC123.js 'cache-control: public, immutable'
only /op.js cache-control 'cache-control: public, max-age=10, s-maxage=86400'
has /missing.js 'http/1.1 404 not found'
has /assets/missing-AbC123.js 'http/1.1 404 not found'
echo 'PASS: immutable cache only under /assets/, short cache for op.js, missing assets 404'
`;
process.stdout.write(execFileSync('docker', [
  'run', '--rm', '-i', '-e', 'API_UPSTREAM=127.0.0.1:8081',
  'nginx:1.27-alpine', 'sh', '-c', check,
], { input: config, encoding: 'utf8', timeout: 120_000 }));
