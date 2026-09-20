# Local GeoIP database (MaxMind GeoLite2)

QRganize resolves approximate login locations from a **local** MaxMind GeoLite2
City database. No IP addresses are sent to third-party geolocation APIs.

## Setup

1. Create a free MaxMind account and generate a license key:
   https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
2. Download **GeoLite2-City** (`.mmdb` format).
3. Place the file at:

   `data/geoip/GeoLite2-City.mmdb`

   Or set an absolute/relative path:

   `GEOIP_DB_PATH=data/geoip/GeoLite2-City.mmdb`

4. Restart the Next.js server. The database is **not** downloaded on startup.

## Behavior

- Missing database → login still works; UI shows `Location unavailable`.
- Localhost (`127.0.0.1` / `::1`) → `Local development` (no lookup).
- Private LAN IPs → `Private network`.

## Proxy / public IP

Set `TRUST_PROXY=true` only when QRganize runs behind a trusted reverse proxy
that sets `X-Forwarded-For` / `X-Real-IP`. Do not enable this on an unproxied
public Node process.

## License note

GeoLite2 has its own license and attribution requirements from MaxMind.
Do not commit the `.mmdb` file to git.
