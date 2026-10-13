// Exercise the production nginx template without app credentials or a database.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const template = readFileSync(new URL('../apps/portal/nginx.conf.template', import.meta.url), 'utf8');
const config = template + `
server {
    listen 8081;
    location /probe { return 200 "$http_x_forwarded_proto"; }
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
`;
process.stdout.write(execFileSync('docker', [
  'run', '--rm', '-i', '-e', 'API_UPSTREAM=127.0.0.1:8081',
  'nginx:1.27-alpine', 'sh', '-c', check,
], { input: config, encoding: 'utf8', timeout: 120_000 }));
