# Worship Slides

A tiny web app that turns your weekly Word docs into ProPresenter `.pro` files —
**Call to Worship**, **Prayer of Confession & Assurance**, and the **Sermon**.
Everything runs in the browser; no files are uploaded anywhere.

Scripture is intentionally left to ProPresenter's own Bible tool (so it uses your
licensed NRSV). The app just tells you the reference to type.

## Use it each week
1. Open the app (your GitHub Pages URL, see below).
2. Drop in the **liturgy** `.docx` and the **sermon** `.docx`.
3. Click **Generate**, download the files (or "Download all as .zip").
4. Import them into ProPresenter (File → Import, or drag into a playlist).
5. For scripture, follow the on-screen note (e.g. *Luke 3:15-22, NRSV*) in the Bible tool.

### How the docs must be written
- **Liturgy doc** — section headings on their own lines: `Call to Worship`,
  `Prayer of Confession`, `Assurance of Pardon` (optional). Under each, the text.
  Call to Worship: one `Leader:/People:` exchange per paragraph = one slide.
  The scripture reading line (e.g. `NT Lesson - Luke 3:15-22`) is detected for the reminder.
- **Sermon doc** — slide text marked `SLIDE 1 - your text`, one per slide.

Prayers are split into slide-sized pieces automatically. Backgrounds from the
template are removed so your ProPresenter theme shows through.

## Host it on GitHub Pages (one-time setup)
1. Create a new GitHub repository (e.g. `worship-slides`).
2. Upload the contents of this `webapp/` folder to the repo root
   (`index.html`, `app.js`, `vendor/`, `templates/`). Either:
   - drag the files into GitHub's web uploader, **or**
   - from this folder: `git init && git add . && git commit -m "Worship Slides"`
     then `git remote add origin <your repo URL>` and `git push -u origin main`.
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` / `/ (root)`, Save.
4. Wait ~1 minute; your app is live at `https://<you>.github.io/worship-slides/`.

## Changing the slide look
The look comes from the two files in `templates/`:
- `confession.pro` — style for Call to Worship + Confession
- `sermon.pro` — style for the Sermon

To restyle, make a slide you like in ProPresenter, export it, and replace the
matching template file (keep the same filename). The app clones that slide's
style for every generated slide.

## Local fallback
`../make_slides.py`, `../slidegen.py`, and `../generate.py` do the same thing from
the command line if you ever need it:
```
python3 generate.py --liturgy "Blank 405.docx" --sermon "Sermon.docx" --templates . --out ./output
```
