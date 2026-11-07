# Restoring Next Up from a backup

Every night at 04:00 UTC the web container copies the database to the host folder in `BACKUP_DIR` (see `docker-compose.yml`), as
`next-up-YYYY-MM-DD.db` (the UTC date). Each copy is taken with SQLite's online backup, so it is consistent even if
someone was editing a board at the time, and it is checked with `PRAGMA integrity_check` before it is kept. The last 30
days are kept; older ones are deleted automatically. A failed backup is logged as `[backup] FAILED` in
`docker logs next-up`, and the earlier backups stay.

**A backup holds everything in the database**, board password hashes and the key that signs access cookies included.
Keep the folder private (no public network share) and never copy a backup anywhere public.

**Restoring puts every board back exactly as it was at the time of that backup.** Every change made since (boards,
cards, sign-ups, history, password changes, deletions) is lost, for every board. Codes created after the backup are
free again. Browsers keep working: their access cookies are signed with a key that is inside the backup too.

All commands run on the host, as root, from the deploy folder (where `docker-compose.yml` is), with `BIND_IP`
and `BACKUP_DIR` set in the shell or in `.env` (compose refuses to start without them). The examples use
`$BACKUP_DIR` for the backup folder and `$BIND_IP` for the published address.

## 1. Pick the backup

```bash
cd /path/to/next-up
ls -l "$BACKUP_DIR"/
```

## 2. Check it, inside the app image

```bash
docker run --rm -v "$BACKUP_DIR":/backups:ro --entrypoint node next-up:local \
  server/tools/backup.js verify /backups/next-up-2026-10-15.db
# [backup] next-up-2026-10-15.db: integrity ok, 12 boards, 3481 events
```

Anything other than `integrity ok` means: don't use that file, try the day before.

## 3. Stop both containers

Both the web app and the MCP server hold the database open.

```bash
docker compose stop next-up next-up-mcp
```

## 4. Move the current database aside (never delete it)

The `-wal` and `-shm` files belong to the current database: move them with it, or SQLite would replay them into the
restored one.

```bash
aside=data/before-restore-$(date +%Y%m%d-%H%M)
mkdir -p "$aside"
mv data/next-up.db* "$aside"/     # next-up.db, and -wal / -shm if they exist
ls data/                          # next-up.db must be gone
```

## 5. Copy the backup in

```bash
cp "$BACKUP_DIR"/next-up-2026-10-15.db data/next-up.db
chown "$PUID:$PGID" data/next-up.db   # the PUID:PGID in .env (default 1000:1000)
```

## 6. Start them again and check

```bash
docker compose up -d
docker logs --tail 20 next-up     # "listening on 0.0.0.0:3230", no errors
curl -s "http://$BIND_IP:3230/health"
```

Open a board you know was in the backup. Anyone who had a board open should reload the page: their live view was
following the newer database.

## Undo a restore

Stop both containers, move `data/next-up.db` aside, move the files from `data/before-restore-…/` back into `data/`,
start them again.

## Take a backup by hand

Before anything risky (a migration, a restore):

```bash
docker exec next-up node server/tools/backup.js now
docker exec next-up node server/tools/backup.js list
```

It writes today's file (replacing today's nightly one, if it already ran).

## How this was tested

Before this shipped, on a Mac, with the real web server on a scratch database: a board and a card were created, a
backup was taken with `backup.js now` while the server was running, a second board was created after it, the server
was stopped, steps 4–6 were followed, and after the restart the first board and its card were back, the second board's
code was free, the browser's access cookie still opened the board, and new changes saved. `server/test/backup.test.js`
covers the backup itself: a copy taken while writes land mid-copy passes `integrity_check`, a damaged copy is refused,
30 days are kept, and a failure is logged loudly.
