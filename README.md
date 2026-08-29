# JCF — the deployed site

This repository is **public only because GitHub Pages requires it**, and it holds
nothing but the files a browser downloads:

- `index.html`, `style.css`, `script.js`, `help.html` — the Jarurat Care
  HOPE Circle page.
- `Patient Navigator/` — the caregiver-mentor portal: HTML, CSS, JS, icons and
  the service worker.

Served at <https://ubhayaab.github.io/JCF/>.

## What is NOT here, and why

The source lives in the private repository **`UbhayAab/JCF-app`**. This one is a
deploy target, not the place to make changes.

Everything with patient data in or near it stays private: the Gemini prompts,
the SQL schema and migrations, the benchmark corpus, the test fixtures and the
measurement docs. Those are all server-side or development artefacts. None of
them is needed for the site to run, because the document reader executes in a
Supabase Edge Function, not in the browser.

## The one key in here is meant to be here

`Patient Navigator/js/config.js` carries `SUPABASE_ANON_KEY`. That key is
designed to be public: every request it makes is still filtered by Postgres Row
Level Security, so it grants a signed-in mentor exactly what her role allows and
an anonymous visitor nothing at all. The Gemini API key is a Supabase Edge
Function secret and has never been in a served file.

## Updating

Do not edit files here. Change them in `JCF-app` and run its publish step, or
this repository will drift from the source and the next person will not know
which copy is real.
