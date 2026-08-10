# Humanware OS launch site

Static launch page for `humanwareos.com`.

## Preview

```sh
cd site
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Deploy

The directory is intentionally dependency-free. Configure the hosting service
to publish `site/` as the static output directory.
