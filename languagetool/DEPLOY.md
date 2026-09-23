# Deploying LAITA to Collabora Online

How to give everyone on a Nextcloud + Collabora Online installation AI proofreading, with
nothing installed by any of them and no document text leaving your server.

You need shell access to the machine running Collabora, and about twenty minutes.
[`README.md`](README.md) explains *why* it is built this way; this file is only the steps.

---

## 1. What you are installing

A small Python service on the host, speaking the LanguageTool API. Collabora already knows
how to talk to a LanguageTool server — it is a standard setting — so it needs no plugin, no
extension and no per-user configuration. The service asks your own Ollama and hands the
answers back as grammar suggestions.

```
  browser            Collabora container             host
  ┌──────────┐       ┌──────────────────┐            ┌───────────────┐
  │ Nextcloud│──────▶│ coolwsd          │───────────▶│ LAITA server  │
  │  editor  │  wopi │  (LibreOffice)   │  /v2/check │      │        │
  └──────────┘       └──────────────────┘            │      ▼        │
                                                     │   Ollama      │
                                                     └───────────────┘
```

**Nothing leaves the machine.** The document text goes from Collabora to the LAITA service
to Ollama, all on your own host.

### What users get, and what they do not

Suggestions appear as coloured underlines with a right-click menu, exactly like the
built-in spell checker — errors in red, style in orange, rephrasings in blue.

Two limits are worth telling your users about, because both look like bugs otherwise:

- **Suggestions arrive a few seconds late, on the next keystroke.** The service answers
  instantly and asks the model in the background; there is no way for it to tell the editor
  "look again". If someone stops typing and waits, nothing appears — one more keystroke, or
  clicking back into the paragraph, brings it up.
- **"Ignore All" silences a whole category, not one suggestion.** The protocol gives no
  place to identify an individual suggestion. A permanent ignore list exists, but it is
  server-wide and set by you in the configuration file.

---

## 2. Requirements

| | |
|---|---|
| Ollama | running on the host, with a model pulled |
| Python | 3.3 or newer; no packages, no virtualenv, standard library only |
| Collabora | any version with the `languagetool` settings (22.05 and newer) |
| GPU | 8 GB for the default `qwen3.5:9b`; less for a smaller model |

The model choice is the one decision worth thinking about. `qwen3.5:9b` is the default and
handles style and phrasing; `qwen3.5:4b` finds spelling and grammar reliably on a smaller
card. A model is loaded once and stays resident.

```bash
ollama pull qwen3.5:9b
```

---

## 3. Find the address the container reaches you on

The service must not listen on `localhost`: a container cannot reach the host's loopback.
It listens on the Docker bridge instead, which is not routable from outside the machine.

```bash
ip -4 addr show docker0 | grep inet        # usually 172.17.0.1
```

If Collabora runs in a compose stack it may be on a different bridge — `docker inspect
-f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' <container>` gives the one it
actually uses. Use that address everywhere `172.17.0.1` appears below.

Not in Docker at all? Then `127.0.0.1` is correct and you can skip step 5.

---

## 4. Install the service

```bash
git clone https://github.com/sylvaticus/laita.git
cd laita/languagetool
sudo tools/install.sh --host 172.17.0.1 --port 8181 --model qwen3.5:9b
```

Add `--dry-run` first if you want to see every file it writes and change nothing.

It creates an unprivileged system account `laita`, copies the code to `/opt/laita`, writes
`/etc/laita/languagetool.json` and a hardened systemd unit, and starts it. The clone is
disposable afterwards — nothing runs out of it.

Check it came up:

```bash
curl -s http://172.17.0.1:8181/status
journalctl -u laita-languagetool -n 20
```

The log says at startup whether Ollama answered and whether it has the model. If it did
not, fix that before going on: the service will otherwise run perfectly and find nothing.

---

## 5. Let the container reach it

Many hosts have a firewall that drops this path. **The packets are dropped, not refused**,
so the symptom is every check hanging for ten seconds and looking exactly like a slow model.
It is worth confirming rather than assuming.

```bash
sudo docker exec <collabora-container> curl -s -m 5 http://172.17.0.1:8181/v2/languages
```

A list of languages means you can skip the rest of this step. A hang means the firewall.

**ufw:**

```bash
sudo ufw allow in on docker0 to 172.17.0.1 port 8181 proto tcp
```

**Hand-written iptables** whose `INPUT` chain ends in a catch-all `-j DROP` — the rule must
go *above* that line, or it will never be reached:

```bash
sudo iptables -I INPUT 1 -i docker0 -d 172.17.0.1 -p tcp --dport 8181 -j ACCEPT
```

Then make it survive a reboot, the way that host already persists its rules. If that is
`iptables-persistent`, add the line to `/etc/iptables/rules.v4` **by hand**, above the
catch-all DROP. Avoid `netfilter-persistent save` while Docker is running: it snapshots
Docker's generated chains and the current container IPs into your file too.

Neither of these opens anything to the internet: `172.17.0.1` is not routable from off the
machine, and the rule is restricted to the `docker0` interface and one port.

---

## 6. Point Collabora at it

Two options on the `coolwsd` command line. `base_url` takes **no** `/check` suffix —
LibreOffice appends it.

```
--o:languagetool.enabled=true
--o:languagetool.base_url=http://172.17.0.1:8181/v2
```

**Docker:** these go in `extra_params`, alongside whatever is already there. The container
has to be recreated, so copy your current command first and add to it:

```bash
docker inspect collabora --format '{{json .Config.Env}}' | tr ',' '\n'   # keep this
docker rm -f collabora
docker run -t -d --name collabora --restart always \
  -e "extra_params=<your existing params> --o:languagetool.enabled=true --o:languagetool.base_url=http://172.17.0.1:8181/v2" \
  <your existing -e aliasgroup... and -p options> \
  collabora/code:latest
```

> `docker rm -f` often leaves an orphaned `docker-proxy` holding the published port, and
> the replacement `docker run` then fails with *address already in use*. Check with
> `sudo ss -lntp | grep 9980` and kill that process if it is still there.

**Native package:** set the same values in `/etc/coolwsd/coolwsd.xml` under `<languagetool>`
and `systemctl restart coolwsd`.

Confirm coolwsd really received them — the `--o:` form is a runtime override and is **never
written into `coolwsd.xml`**, so grepping that file proves nothing:

```bash
sudo docker exec collabora sh -c 'for f in /proc/[0-9]*/cmdline; do
    tr "\0" "\n" < "$f" 2>/dev/null | grep -i languagetool; done' | sort -u
```

---

## 7. Test it

Open a Writer document from Nextcloud. Set the text language (**Tools ▸ Language**) and make
sure **Tools ▸ Automatic Spell Checking** is on — a paragraph with no language set is never
offered to any checker, and nothing will say why.

Type a sentence with a real mistake and keep typing for a few more words. Within about ten
seconds, underlines appear.

Do not test with a simple misspelling: AutoCorrect rewrites `teh` to `the` on the next space,
so no checker ever sees it. Use something it leaves alone — a wrong agreement, a missing
accent, a clumsy sentence.

Watch it work:

```bash
journalctl -u laita-languagetool -f
```

```
check: 96 chars, lang=fr-FR, queued, 1ms
model: 96 chars in 1 chunk(s), 4 issues, 6.1s  'Hier je suis alle au marche'
check: 96 chars, lang=fr-FR, cache, 4 raw -> 4 anchored, 2ms
```

---

## 8. Tuning

Edit `/etc/laita/languagetool.json` and `systemctl restart laita-languagetool`.

```json
{
  "host": "172.17.0.1",
  "port": 8181,
  "model": "qwen3.5:9b",
  "endpoint": "http://127.0.0.1:11434",
  "categories": {"error": true, "style": true, "rephrase": false},
  "dictionary": ["Nextcloud", "Collabora", "names your users write often"],
  "extraInstructions": "This is academic writing about agriculture and forestry.",
  "ignored": [],
  "debounceMs": 1500,
  "minChars": 25
}
```

The settings worth knowing:

| | |
|---|---|
| `categories` | turn off `style` and `rephrase` for corrections only — far less model time |
| `dictionary` | words never to flag: place names, jargon, people |
| `extraInstructions` | house style, in plain language, added to the prompt |
| `minChars` | paragraphs shorter than this are not sent. Raise it on a busy server |
| `debounceMs` | how long a paragraph must be still before the model is asked |
| `model` | a smaller model is dramatically cheaper and still catches hard errors |

An unknown key is refused and the service will not start — deliberately, so a typo does not
silently do nothing. `journalctl -u laita-languagetool` names the offending key.

### If several people write at once

One model serves everybody, one request at a time. That is usually fine, because people
think between paragraphs. If the log shows requests queueing behind each other, in order of
effect: turn off `style` and `rephrase`, use a smaller model, raise `minChars`, or give
Ollama a second GPU.

---

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| No underlines at all, nothing in the log | Collabora never called. Check the `--o:` options reached coolwsd (§6) |
| Every check takes exactly 10 s | The firewall is dropping the packets (§5) |
| `WARNING: Ollama has no model` at startup | `ollama pull <model>` |
| Underlines appear only when typing continues | Expected — there is no way to push a result (§1) |
| Nothing on one paragraph, fine on others | No language set on that text, or shorter than `minChars` |
| `address already in use` recreating the container | Orphaned `docker-proxy` on 9980 (§6) |

Everything the service does is in the journal, one line per check:

```bash
journalctl -u laita-languagetool -f
curl -s http://172.17.0.1:8181/status      # cache hits, queue, last error
```

---

## 10. Removing it

```bash
sudo tools/install.sh --uninstall           # stops the service, removes /opt/laita
```

Then drop the two `--o:languagetool.*` options from Collabora and recreate the container.
The configuration file is kept; delete `/etc/laita/languagetool.json` yourself if you want
it gone.

---

## Privacy, for the notice you owe your users

Text people type in Collabora is sent to the LAITA service and to Ollama, both on this
server, and to nothing else. No API key, no external service, no internet. The service
keeps recent paragraphs in memory to avoid asking the model twice; it writes none of them
to disk, and they are gone when it restarts. The journal records the length of each
paragraph checked and the first 60 characters of paragraphs the model was asked about —
set `logFile` to a path with restricted permissions, or tighten your journal retention, if
that matters where you are.
